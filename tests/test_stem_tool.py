"""Replace a Stem (stem_tool): lining up, level safety, and that Chord Buddy itself accepts the result. All audio here is made up."""
import json

import numpy as np
import pytest

from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.library import Library
from chordbuddy.playback_ready import PlaybackReadiness
from chordbuddy.separation_checks import validate_mix
from chordbuddy.separation_contract import STEMS, TRACKS, file_hash
from chordbuddy.separation_store import SeparationStore
from stem_tool import engine
from stem_tool.engine import RATE, StemError, Workspace

SECONDS = 24
FRAMES = SECONDS * RATE
SONG = 'a1b2c3d4e5f6'


def phrases(seed=1, seconds=SECONDS):
    """A made-up vocal's loudness over time: sung phrases of uneven lengths with rests between them."""
    rng = np.random.default_rng(seed)
    env = np.zeros(seconds * RATE, dtype=np.float32)
    t = int(.8 * RATE)
    while t < len(env) - RATE:
        length = int(rng.uniform(.25, 1.1) * RATE)
        env[t:t + length] = rng.uniform(.4, 1.0) * np.hanning(length)
        t += length + int(rng.uniform(.1, .7) * RATE)
    return env


def voice(env, hz, level=1.0):
    t = np.arange(len(env)) / RATE
    mono = (env * np.sin(2 * np.pi * hz * t) * level).astype(np.float32)
    return np.stack([mono, mono], axis=1)


def tone(hz, level, frames=FRAMES):
    mono = (np.sin(2 * np.pi * hz * np.arange(frames) / RATE) * level).astype(np.float32)
    return np.stack([mono, mono], axis=1)


@pytest.fixture
def song(tmp_path):
    """A library with one song, split by "the app": a published run, and a completed analysis job that names it (as real songs have)."""
    lib = Library(tmp_path)
    with lib.transaction() as tx:
        tx.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (SONG, 'Test Song', 'Tester', 'source.mp3', SECONDS, SONG, 'imported', None, None, 'then'))
    folder = tmp_path / SONG
    folder.mkdir()
    (folder / 'source.mp3').write_bytes(b'the recording')
    lib.close()
    space = Workspace(tmp_path, tmp_path)
    store = space.store
    run = store.create_run(SONG, 'recipe')
    root = store.safe_path(run['folder'])
    stems = {'vocals': voice(phrases(), 300, .25), 'bass': tone(60, .12), 'drums': tone(900, .05), 'other': tone(1500, .04),
             'piano': tone(440, .06), 'lead': tone(700, .05), 'rhythm': tone(350, .05)}
    for role, audio in stems.items():
        engine.write_wav(root / (role + '.wav'), audio)
    engine.write_wav(root / 'original.wav', sum(stems.values()))
    engine.write_wav(root / 'guitar.wav', stems['lead'] + stems['rhythm'])
    store.update_progress(run['id'], 'validating')
    manifest = validate_mix(root)
    manifest.update(source_sha256=file_hash(folder / 'source.mp3'), recipe={'made': 'up'}, recipe_sha256='recipe')
    store.activate_validated(run['id'], manifest)
    (root / 'guitar.wav').unlink()
    # the analysis job that makes the song playable: four completed stages, the separation one naming the run and pinning its files
    analysis = space.analysis
    deps = {'source_sha256': manifest['source_sha256']}
    stages = {}
    for kind in ('source', 'transcription', 'chart'):
        file = folder / (kind + '.txt')
        file.write_text(kind)
        stages[kind] = {'id': analysis.publish(SONG, kind, deps, {'run_id': 'x', 'assets': [{'path': str(file.relative_to(tmp_path)), 'sha256': file_hash(file)}]})['id'], 'status': 'completed'}
    asset = lambda p: {'path': str(p.relative_to(tmp_path)), 'sha256': file_hash(p)}
    _, published = store.get_published_run(run['id'])
    ref = analysis.publish(SONG, 'separation', deps, {'run_id': run['id'], 'assets': [asset(root / 'manifest.json')] + [asset(root / a['relative_path']) for a in published['assets']]})
    stages['separation'] = {'id': ref['id'], 'status': 'completed'}
    analysis.save_job({'id': 'f' * 32, 'kind': 'analysis', 'song_id': SONG, 'status': 'completed', 'stages': stages})
    yield space, run['id'], stems
    space.close()


def playable(space):
    return PlaybackReadiness(space.analysis, space.store).state(SONG)


# ---------------------------------------------------------------- lining up
@pytest.mark.parametrize('shift', [0.0, 0.75, -1.3, 7.004])
def test_another_singers_take_is_lined_up_by_its_phrasing(shift):
    env = phrases()
    reference = voice(env, 300, .25)
    late = int(round(shift * RATE))                       # his file has this much extra at the front (or is missing this much)
    take = voice(np.roll(env, late), 520, .6)             # a different voice, a different level, the same phrasing
    if late > 0:
        take[:late] = 0
    found = engine.find_offset(take, reference)
    assert abs(found['offset'] + late) <= RATE * .003, 'within 3 ms'
    assert found['confidence'] > .6 and abs(found['drift_ms']) < 10


def test_a_take_at_another_tempo_is_called_out():
    env = phrases(seconds=SECONDS)
    stretched = np.interp(np.arange(int(len(env) * 1.012)) / 1.012, np.arange(len(env)), env).astype(np.float32)   # 1.2 % slower
    found = engine.find_offset(voice(stretched, 520), voice(env, 300))
    assert abs(found['drift_ms']) > engine.DRIFT_WARN_MS
    assert 'different version or tempo' in found['words']


def test_unrelated_audio_is_not_called_a_match():
    found = engine.find_offset(voice(phrases(seed=99), 520), voice(phrases(seed=1), 300))
    assert found['confidence'] < .6 and 'guess' in found['words'] or 'likely' in found['words']


# ---------------------------------------------------------------- level
def test_loudness_ignores_the_rests():
    env = phrases()
    sung = voice(env, 300, .25)
    padded = np.concatenate([sung, np.zeros((FRAMES, 2), dtype=np.float32)])        # the same singing, then as long again of silence
    assert abs(engine.loudness_db(sung) - engine.loudness_db(padded)) < .5


@pytest.mark.parametrize('level,expect', [(.25, 0.0), (.125, 6.0), (.5, -6.0)])
def test_the_new_stem_is_matched_to_the_one_it_replaces(song, level, expect):
    space, run, _ = song
    root, manifest = space.active(SONG)
    plan = engine.plan_level(root, manifest, 'vocals', engine.place(voice(phrases(), 520, level), FRAMES, 0))
    assert abs(plan['gain_db'] - expect) < .6
    assert abs(plan['new_loudness_db'] - plan['old_loudness_db']) < .6


def test_a_whisper_quiet_file_is_boosted_only_so_far(song):
    space, _, _ = song
    root, manifest = space.active(SONG)
    plan = engine.plan_level(root, manifest, 'vocals', engine.place(voice(phrases(), 520, .0005), FRAMES, 0))
    assert plan['gain_db'] == engine.MAX_BOOST_DB and any('very quiet' in n for n in plan['notes'])


def test_a_peaky_file_cannot_turn_the_whole_song_down_much(song):
    space, _, _ = song
    root, manifest = space.active(SONG)
    spiky = voice(phrases(), 520, .05)
    spiky[RATE * 5:RATE * 5 + 40] = 1.0                     # a click far louder than the singing
    plan = engine.plan_level(root, manifest, 'vocals', engine.place(spiky, FRAMES, 0))
    assert plan['song_change_db'] >= -engine.MAX_SONG_DROP_DB - .05
    assert any('loud peaks' in n for n in plan['notes'])
    assert plan['common_gain'] <= 1.0


def test_the_hand_trim_stays_inside_its_limits(song):
    space, _, _ = song
    root, manifest = space.active(SONG)
    placed = engine.place(voice(phrases(), 520, .25), FRAMES, 0)
    assert engine.plan_level(root, manifest, 'vocals', placed, trim_db=40)['trim_db'] == engine.TRIM_RANGE_DB[1]
    assert engine.plan_level(root, manifest, 'vocals', placed, trim_db=-40)['trim_db'] == engine.TRIM_RANGE_DB[0]


def test_place_moves_pads_and_fades():
    take = np.ones((RATE, 2), dtype=np.float32)
    late = engine.place(take, 3 * RATE, RATE)               # starts a second in
    assert not late[:RATE].any() and late[RATE + RATE // 2, 0] == 1 and not late[2 * RATE:].any()
    assert late[RATE, 0] == 0 and late[2 * RATE - 1, 0] < .01, 'cut ends are faded, never a click'
    early = engine.place(take, RATE // 2, -RATE // 4)       # its first quarter second falls before the song
    assert len(early) == RATE // 2 and early[RATE // 8, 0] == 1
    with pytest.raises(StemError):
        engine.place(take, RATE, 5 * RATE)


@pytest.mark.parametrize('bad', [np.zeros((RATE, 2)), np.full((RATE, 2), np.nan), np.ones((10, 2)), np.ones((RATE, 1))])
def test_unusable_audio_is_refused_in_plain_words(bad):
    with pytest.raises(StemError):
        engine.check_audio(bad)


# ---------------------------------------------------------------- publishing
def test_replacing_makes_a_new_version_the_app_accepts_and_leaves_the_old_one_alone(song, tmp_path):
    space, old_run, stems = song
    assert playable(space)['ready'] and playable(space)['active']['run_id'] == old_run
    old_root, old_manifest = space.active(SONG)
    before = {a['role']: a['file_sha256'] for a in old_manifest['assets']}
    new_vocals = engine.place(voice(phrases(), 520, .25), FRAMES, 0)
    result = space.replace(SONG, 'vocals', new_vocals, {'file': 'his-take.wav'})
    assert result['previous_run_id'] == old_run and result['run_id'] != old_run
    root, manifest = space.active(SONG)
    assert manifest['run_id'] == result['run_id']
    now = {a['role']: a['file_sha256'] for a in manifest['assets']}
    assert now['vocals'] != before['vocals'] and all(now[r] == before[r] for r in TRACKS if r != 'vocals'), 'only the vocals changed'
    assert np.array_equal(space.stem(SONG, 'vocals'), new_vocals)
    assert manifest['replaced']['vocals']['file'] == 'his-take.wav' and manifest['recipe_sha256'] == 'recipe'
    assert not (root / 'guitar.wav').exists()
    # the app's own readers: the stems validate, and the song is playable from the NEW run
    state = playable(space)
    assert state['ready'] and state['active']['run_id'] == result['run_id']
    assert space.store.get_song_state(SONG)['availability'] == 'ready'
    # the old version is untouched, checksums and all
    assert {a['role']: file_hash(old_root / a['relative_path']) for a in old_manifest['assets']} == before
    assert space.store.get_published_run(old_run)[1]['run_id'] == old_run


def test_the_song_can_never_clip_whatever_is_put_in(song):
    space, _, _ = song
    loud = engine.place(voice(phrases(), 520, 3.0), FRAMES, 0)            # far over full scale
    space.replace(SONG, 'vocals', loud)
    root, manifest = space.active(SONG)
    total = sum(np.abs(np.asarray(space.stem(SONG, r), dtype=np.float64)) for r in STEMS)
    assert float(total.max()) * manifest['common_gain'] <= .95 + 1e-6


def test_the_original_can_be_put_back_exactly(song):
    space, old_run, stems = song
    original = file_hash(space.active(SONG)[0] / 'vocals.wav')
    assert space.backup(SONG, 'vocals') is None
    space.replace(SONG, 'vocals', engine.place(voice(phrases(), 520, .25), FRAMES, 0))
    space.replace(SONG, 'vocals', engine.place(voice(phrases(), 610, .2), FRAMES, 0))      # replaced twice: the backup is still the song's own
    assert space.backup(SONG, 'vocals') is not None
    result = space.restore(SONG, 'vocals')
    root, manifest = space.active(SONG)
    assert np.array_equal(space.stem(SONG, 'vocals'), stems['vocals'])
    assert 'vocals' not in (manifest.get('replaced') or {}) and space.backup(SONG, 'vocals') is None
    assert playable(space)['active']['run_id'] == result['run_id']
    assert abs(manifest['common_gain'] - space.store.get_published_run(old_run)[1]['common_gain']) < 1e-9
    with pytest.raises(StemError):
        space.restore(SONG, 'vocals')
    assert file_hash(space.store.get_published_run(old_run)[0] / 'vocals.wav') == original


def test_a_failure_part_way_leaves_the_song_as_it_was(song, monkeypatch):
    space, old_run, _ = song
    monkeypatch.setattr(engine, 'validate_mix', lambda root: (_ for _ in ()).throw(ValueError('boom')))
    with pytest.raises(ValueError):
        space.replace(SONG, 'vocals', engine.place(voice(phrases(), 520, .25), FRAMES, 0))
    assert space.active(SONG)[1]['run_id'] == old_run
    assert playable(space)['active']['run_id'] == old_run
    assert len(list((space.library.root / SONG / 'separation').iterdir())) == 1, 'the half-made version is cleaned up'


def test_wrong_lengths_stems_and_songs_are_refused(song):
    space, _, _ = song
    with pytest.raises(StemError):
        space.replace(SONG, 'vocals', np.zeros((FRAMES - 1, 2), dtype=np.float32))
    with pytest.raises(StemError):
        space.replace(SONG, 'original', np.zeros((FRAMES, 2), dtype=np.float32))
    with pytest.raises(KeyError):
        space.active('nosuchsong00')


def test_songs_lists_what_can_be_worked_on(song):
    space, _, _ = song
    assert [(s['id'], s['title'], s['replaced']) for s in space.songs()] == [(SONG, 'Test Song', [])]
    space.replace(SONG, 'vocals', engine.place(voice(phrases(), 520, .25), FRAMES, 0))
    assert space.songs()[0]['replaced'] == ['vocals']


def test_the_preview_is_the_mix_the_app_would_play(song):
    space, _, stems = song
    root, manifest = space.active(SONG)
    heard = engine.preview(root, manifest, 'vocals', stems['vocals'], RATE, 2)
    expect = sum(stems.values())[RATE:3 * RATE] * manifest['common_gain']
    assert heard.shape == (2 * RATE, 2) and np.allclose(heard, expect, atol=1e-5)


def test_a_real_file_is_decoded_to_the_songs_format(tmp_path, ffmpeg_exe):
    import wave
    mono = (np.sin(2 * np.pi * 220 * np.arange(22050) / 22050) * 12000).astype('<i2')     # one second, mono, 22.05 kHz, 16-bit
    path = tmp_path / 'take.wav'
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(22050)
        f.writeframes(mono.tobytes())
    audio = engine.decode(ffmpeg_exe, path)
    assert audio.shape[1] == 2 and abs(len(audio) - RATE) < 50 and audio.dtype == np.float32
    # a mono file comes out the same on both sides (the decoder lowers it 3 dB as it spreads it; the level is matched to the song afterwards anyway)
    assert np.allclose(audio[:, 0], audio[:, 1]) and .2 < float(np.abs(audio).max()) < .4
    with pytest.raises(StemError):
        engine.decode(ffmpeg_exe, tmp_path / 'missing.wav')
    (tmp_path / 'notes.txt').write_text('not audio')
    with pytest.raises(StemError):
        engine.decode(ffmpeg_exe, tmp_path / 'notes.txt')
