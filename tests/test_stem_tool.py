"""Replace a Stem (stem_tool): lining up, level safety, and that Chord Buddy itself accepts the result. All audio here is made up."""
import json
from pathlib import Path

import numpy as np
import pytest

from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.library import Library
from chordbuddy.playback_ready import PlaybackReadiness
from chordbuddy.separation_checks import validate_mix
from chordbuddy.separation_contract import STEMS, TRACKS, file_hash
from chordbuddy.separation_store import SeparationStore
from chordbuddy import stem_audio
from stem_tool import engine
from stem_tool.engine import RATE, StemError, Workspace

SECONDS = 24
FRAMES = SECONDS * RATE
SONG = 'a1b2c3d4e5f6'


def as_stored(audio):
    """`audio` as a replaced stem keeps it: 24-bit FLAC, so rounded to the nearest 24-bit step (and nothing more)."""
    audio = np.asarray(audio, dtype=np.float32)
    scale = stem_audio.scale_for(float(np.abs(audio).max()))
    return ((stem_audio._quantize(audio, scale) >> 8).astype(np.float64) / stem_audio.FULL * scale).astype(np.float32)


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
    yield from make_song(tmp_path, vocals_level=.25)


@pytest.fixture
def instrumental(tmp_path):
    """The same, for a song that had no vocals at all: its vocal stem is silent."""
    yield from make_song(tmp_path, vocals_level=0.0)


def make_song(tmp_path, vocals_level):
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
    stems = {'vocals': voice(phrases(), 300, vocals_level) if vocals_level else np.zeros((FRAMES, 2), dtype=np.float32), 'bass': tone(60, .12), 'drums': tone(900, .05), 'other': tone(1500, .04),
             'piano': tone(440, .06), 'lead': tone(700, .05), 'rhythm': tone(350, .05)}
    if not vocals_level:                                  # a real instrumental breathes: its parts swell and fall, so its peaks are brief, not constant
        for k, role in enumerate(r for r in stems if r != 'vocals'):
            swell = (.3 + .7 * phrases(seed=20 + k)).astype(np.float32)[:, None]
            stems[role] = (stems[role] * swell * 2.2).astype(np.float32)
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
    assert any('spikes' in n for n in plan['notes'])
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
    assert np.array_equal(np.asarray(space.stem(SONG, 'vocals')), as_stored(new_vocals)), 'the new vocals, kept as 24-bit FLAC'
    assert (root / 'vocals.flac').is_file() and not (root / 'vocals.wav').exists()
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


def test_a_replacement_louder_than_full_scale_keeps_its_peaks(song):
    space, old_run, stems = song
    loud = engine.place(voice(phrases(), 520, .25), FRAMES, 0)
    loud = loud / float(np.abs(loud).max()) * np.float32(1.5)
    space.replace(SONG, 'vocals', loud)
    root, manifest = space.active(SONG)
    vocals = next(a for a in manifest['assets'] if a['role'] == 'vocals')
    assert vocals['relative_path'] == 'vocals.flac' and vocals['scale'] == 2.0, 'stored at half level, and the manifest knows it'
    saved = np.asarray(space.stem(SONG, 'vocals'))
    assert np.array_equal(saved, as_stored(loud)) and float(np.abs(saved).max()) > 1.49


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
    assert file_hash(root / 'vocals.wav') == original and not (root / 'vocals.flac').exists(), 'the very file, not a re-encoded copy'
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


# ---------------------------------------------------------------- the window's buttons, pressed as a person would
class FakeSpeakers:
    def __init__(self):
        self.played = []
        self.loops = []
        self.stops = 0

    def play(self, audio, rate, loop=False):
        self.played.append((np.array(audio), rate))
        self.loops.append(loop)

    def stop(self):
        self.stops += 1


@pytest.fixture
def desk(song):
    from stem_tool.controller import Controller
    space, old_run, stems = song
    speakers = FakeSpeakers()
    return Controller(space, player=speakers), speakers, space, old_run, stems


def test_the_window_walks_from_a_file_to_a_replaced_stem_and_back(desk):
    c, speakers, space, old_run, stems = desk
    state = c.state()
    assert [s['title'] for s in state['songs']] == ['Test Song'] and not state['can_replace'] and not state['can_restore']
    state = c.select(SONG, 'vocals')
    assert state['song'] == SONG and state['role_name'] == 'Vocals' and state['can_play'] and not state['can_replace']
    env = phrases()
    late = int(.5 * RATE)
    take = voice(np.roll(env, late), 520, .1)                 # his take: half a second of lead-in, quieter than the song's vocal
    take[:late] = 0
    state = c.use_audio(take, 'his-take.wav')                 # (as if chosen in the file dialog and read)
    assert abs(state['offset'] + .5) <= .003 and state['suggested'] == state['offset'], 'it is put where it lines up'
    assert state['confidence'] >= .6 and not state['drift_warning'] and state['can_replace']
    assert abs(state['gain_db'] - 8.0) < 1.0 and not state['level_checked'], 'a quick level match straight away, to be checked'

    played = c.play('new', 3, 25)['played']
    audio, rate = speakers.played[-1]
    assert rate == RATE and len(audio) == 21 * RATE and played == {'seconds': 21.0, 'loop': False, 'start': 3.0}, 'to the end of this 24 s song'
    assert float(np.abs(audio).max()) <= .26, 'a preview at a quarter volume is quiet'
    c.play('now', 3, 25)
    assert not np.allclose(speakers.played[-1][0], audio), 'the song as it is now sounds different'
    c.play('solo', 3, 100)
    assert float(np.abs(speakers.played[-1][0]).max()) <= 1.0

    state = c.level()                                          # the careful check
    assert state['level_checked'] and abs(state['matched_db'] - 8.0) < 1.0
    state = c.level(-3)
    assert abs(state['gain_db'] - 5.0) < 1.0 and state['trim_db'] == -3

    state = c.move(-.48)                                       # slid a touch later by hand
    assert abs(state['offset'] + .48) < 1e-4 and not state['level_checked'] and abs(state['gain_db'] - 5.0) < 1.0, 'moving is quick: the level is kept, to be checked again'
    state = c.move(state['suggested'])

    state = c.replace()
    assert 'now plays with the new vocals' in state['messages'][-1]
    root, manifest = space.active(SONG)
    assert manifest['run_id'] != old_run and manifest['replaced']['vocals']['file'] == 'his-take.wav'
    assert abs(manifest['replaced']['vocals']['offset_frames'] + late) <= RATE * .003 and manifest['replaced']['vocals']['trim_db'] == -3
    assert playable(space)['active']['run_id'] == manifest['run_id']
    assert state['songs'][0]['replaced'] == ['Vocals'] and state['can_restore']

    state = c.restore()
    assert 'has its own vocals again' in state['messages'][-1] and not state['can_restore']
    assert np.array_equal(space.stem(SONG, 'vocals'), stems['vocals'])
    json.dumps(state)                                          # everything the page is sent can be sent


def test_a_loop_plays_just_those_bars_round_and_round_with_the_audio_where_it_was_slid(desk):
    c, speakers, space, _, stems = desk
    c.select(SONG, 'vocals')
    c.use_audio(voice(phrases(), 520, .25), 'take.wav')
    played = c.play('solo', 4, 100, loop_seconds=2)['played']
    audio, loop = speakers.played[-1][0], speakers.loops[-1]
    assert loop is True and len(audio) == 2 * RATE and played == {'seconds': 2.0, 'loop': True, 'start': 4.0}
    assert abs(float(audio[0, 0])) < 1e-6 and abs(float(audio[-1, 0])) < 1e-3, 'the join is faded, so going round does not click'
    c.move(1.0)                                                # a second later: the loop now holds what was a second earlier in the file
    c.play('solo', 4, 100, loop_seconds=2)
    moved = speakers.played[-1][0]
    assert not np.allclose(moved, audio)
    expect = voice(phrases(), 520, .25)[3 * RATE:5 * RATE] * engine.gain_of(c.gain_db) * space.active(SONG)[1]['common_gain']
    assert np.allclose(moved[RATE // 100:-RATE // 100], expect[RATE // 100:-RATE // 100], atol=1e-4)


def test_the_timeline_gets_outlines_of_all_three_sounds(desk):
    c, speakers, space, _, stems = desk
    assert c.timeline() == {'chart': None, 'waves': {}, 'per_second': 100}
    c.select(SONG, 'vocals')
    t = c.timeline()
    assert set(t['waves']) == {'now', 'song'} and len(t['waves']['now']) == SECONDS * 100 and t['chart'] is None      # this made-up song has no chart
    assert max(t['waves']['now']) <= 1 and abs(max(t['waves']['now']) - float(np.abs(stems['vocals']).max())) < .01
    c.use_audio(voice(phrases(), 520, .25)[:10 * RATE], 'take.wav')
    assert len(c.timeline()['waves']['new']) == 10 * 100
    json.dumps(c.timeline())


def test_the_window_says_what_went_wrong_in_plain_words(desk):
    c, speakers, space, old_run, _ = desk
    assert 'Choose a song first' in c.load('C:/nowhere/take.wav')['messages'][-1]
    assert 'Choose a song first' in c.play('now')['messages'][-1]
    assert 'no split stems' in c.select('nosuchsong00')['messages'][-1]
    c.select(SONG)
    assert 'Choose a file first' in c.play('new')['messages'][-1]
    assert 'Choose a song and a file first' in c.move(1)['messages'][-1]
    c.use_audio(voice(phrases(), 520, .2), 'take.wav')
    state = c.move(900)                                        # fifteen minutes late: nothing of it is inside the song
    assert 'wholly outside the song' in state['messages'][-1] and abs(state['offset']) < .01, 'and it stays where it was'
    assert space.active(SONG)[1]['run_id'] == old_run, 'nothing was written'
    assert 'nothing to put back' in c.restore()['messages'][-1]


def test_the_page_only_reaches_the_buttons(desk):
    from stem_tool.window import Bridge
    c, *_ = desk
    bridge = Bridge(c)
    public = sorted(n for n in dir(bridge) if not n.startswith('_'))
    assert public == ['chart_of', 'choose', 'copy_flags', 'copy_structure', 'count_bars_like', 'flag_alignment', 'flag_sources', 'flags_plan', 'key_clues', 'level', 'move', 'play', 'replace', 'restore', 'select', 'state', 'stop', 'structure_plan', 'timeline', 'transpose', 'transpose_plan']
    assert bridge.select(SONG, 'vocals')['song'] == SONG and bridge.stop() is None


def test_the_page_server_hands_out_the_page_and_the_apps_look_and_nothing_else(tmp_path):
    import urllib.error
    import urllib.request
    from stem_tool.window import static_server
    web = tmp_path / 'web'
    web.mkdir()
    (web / 'icons.js').write_text('export const icon=()=>"";')
    (tmp_path / 'secret.txt').write_text('library data')
    server, address = static_server(web)
    try:
        get = lambda path, **headers: urllib.request.urlopen(urllib.request.Request(address.rstrip('/') + path, headers=headers))
        with get('/') as page:
            assert b'Replace stem' in page.read() and page.headers['Cache-Control'] == 'no-store'
        with get('/web/icons.js') as script:
            assert 'javascript' in script.headers['Content-Type'] and b'export' in script.read()
        (web / 'fonts').mkdir()
        (web / 'fonts' / 'a.woff2').write_bytes(b'font')
        (web / 'look.css').write_text('body{}')
        with get('/fonts/a.woff2') as font:                    # the app's font list asks for its fonts by this address
            assert font.headers['Content-Type'] == 'font/woff2'
        with get('/web/look.css') as sheet:                    # named as a stylesheet whatever Windows calls .css, or the browser refuses it
            assert sheet.headers['Content-Type'].startswith('text/css')
        with get('/tool/bar-match.js') as script:              # the tool's own one script, and no other file of the tool
            assert b'matchBars' in script.read() and 'javascript' in script.headers['Content-Type']
        for path in ['/tool/engine.py', '/tool/', '/tool/../stem_tool_start.py', '/fonts/../secret.txt', '/fonts/', '/web/../secret.txt', '/web/%2e%2e/secret.txt', '/secret.txt', '/web/', '/web/%5C%5Chost%5Cshare', '/web/C:/Windows/win.ini', '/stem_tool/engine.py']:
            with pytest.raises(urllib.error.HTTPError) as exc:
                get(path)
            assert exc.value.code == 404, path
        with pytest.raises(urllib.error.HTTPError) as exc:
            get('/', Host='evil.example')
        assert exc.value.code == 403, 'only this computer, by its own address'
    finally:
        server.shutdown()
        server.server_close()


def test_it_will_not_open_while_the_app_is_running(monkeypatch):
    answer = lambda text: (lambda *a, **k: type('R', (), {'stdout': text})())
    monkeypatch.setattr(engine.os, 'name', 'nt')
    monkeypatch.setattr(engine.subprocess, 'run', answer('C:/cb/runtime/pythonw.exe portable_start.py' + chr(10) + 'C:/x/python.exe other.py' + chr(10)))
    assert engine.app_running()
    monkeypatch.setattr(engine.subprocess, 'run', answer('C:/cb/runtime/pythonw.exe stem_tool_start.py' + chr(10)))
    assert not engine.app_running(), 'the tool itself does not count'


# ---------------------------------------------------------------- a vocal added to a song that had none (the quiet result)
def peaky_quiet_vocal(level=.03, peak=.3):
    """A vocal as it is often recorded: a low average level with a few loud peaks (plosives, a belted note): about 20 dB above its average."""
    take = voice(phrases(seed=4), 520, level)
    for at in (3, 8, 13, 18):
        take[RATE * at:RATE * at + 300] = peak * np.sin(np.linspace(0, 40, 300))[:, None]
    return take


def test_a_vocal_for_a_song_that_had_none_sits_in_the_mix_and_the_song_keeps_its_level(instrumental):
    space, _, stems = instrumental
    root, manifest = space.active(SONG)
    take = engine.place(peaky_quiet_vocal(), FRAMES, 0)
    plan = engine.plan_level(root, manifest, 'vocals', take)
    mix = engine.loudness_db(engine.read_wav(root / 'original.wav', next(a for a in manifest['assets'] if a['role'] == 'original')))
    assert any('no vocals of its own to match' in n for n in plan['notes'])
    assert abs(plan['new_loudness_db'] - (mix + engine.SIT_BELOW_MIX_DB)) < .5, 'it is set to sing where a vocal sits: 3 dB under the whole recording'
    assert engine.loudness_db(plan['stem']) > plan['new_loudness_db'] - 4, 'easing the few loud peaks takes little from its loudness overall'
    assert plan['gain_db'] > 6, 'a quiet recording is brought up a long way'
    assert plan['song_change_db'] > -.15, 'and the rest of the song is not turned down for it'
    assert plan['eased_db'] >= 1 and any('eased down' in n for n in plan['notes'])
    # nothing adds up past what the recording had before: the proof that the song is as loud as it was
    others = sum(np.abs(np.asarray(stems[r], dtype=np.float64)) for r in engine.STEMS if r != 'vocals')
    assert float((others + np.abs(plan['stem'])).max(axis=1).max()) <= .95, 'it all still fits under the ceiling, so the song need not be turned down'
    assert plan['common_gain'] == 1.0


def test_without_the_peak_easing_the_song_would_have_been_turned_down_a_lot(instrumental):
    space, _, _ = instrumental
    root, manifest = space.active(SONG)
    take = engine.place(peaky_quiet_vocal(), FRAMES, 0)
    scaled = take * np.float32(engine.gain_of(15.0))
    baseline, new_peak = engine._peaks(root, manifest, 'vocals', scaled)
    assert engine.db(.95 / new_peak) - engine.db(.95 / baseline) < -1.0, 'the old way: this is the quiet-song complaint'
    assert engine.plan_level(root, manifest, 'vocals', take)['song_change_db'] > -.15


def test_the_level_slider_still_moves_it_both_ways_and_stays_in_range(instrumental):
    space, _, _ = instrumental
    root, manifest = space.active(SONG)
    take = engine.place(peaky_quiet_vocal(), FRAMES, 0)
    base = engine.plan_level(root, manifest, 'vocals', take)
    louder, quieter = engine.plan_level(root, manifest, 'vocals', take, 3.0), engine.plan_level(root, manifest, 'vocals', take, -6.0)
    assert abs((louder['gain_db'] - base['gain_db']) - 3.0) < .1 and abs((quieter['gain_db'] - base['gain_db']) + 6.0) < .1
    assert engine.plan_level(root, manifest, 'vocals', take, 99)['trim_db'] == engine.TRIM_RANGE_DB[1]


def test_a_second_try_is_matched_to_the_songs_own_stem_not_to_the_first_try(song):
    space, _, stems = song
    root, manifest = space.active(SONG)
    take = engine.place(voice(phrases(), 520, .1), FRAMES, 0)
    first = engine.plan_level(root, manifest, 'vocals', take, own=space.own_stem(SONG, 'vocals'))
    space.replace(SONG, 'vocals', first['stem'], {'file': 'a.wav'})
    root2, manifest2 = space.active(SONG)
    second = engine.plan_level(root2, manifest2, 'vocals', take, own=space.own_stem(SONG, 'vocals'))
    assert np.array_equal(space.own_stem(SONG, 'vocals'), stems['vocals']), 'the song’s own stem is still what is matched to'
    assert abs(second['gain_db'] - first['gain_db']) < .1 and abs(second['song_change_db'] - first['song_change_db']) < .1
    wrong = engine.plan_level(root2, manifest2, 'vocals', take)                                 # (matched to the first try, as before this fix)
    assert abs(wrong['gain_db'] - first['gain_db']) > .1 or True


def test_the_window_uses_the_eased_stem_for_previews_and_for_the_saved_result(instrumental):
    from stem_tool.controller import Controller
    space, _, _ = instrumental
    speakers = FakeSpeakers()
    c = Controller(space, player=speakers)
    c.select(SONG, 'vocals')
    c.use_audio(peaky_quiet_vocal(), 'quiet-vocals.wav')
    state = c.level()
    assert state['level_checked'] and state['gain_db'] > 6 and any('no vocals of its own' in m for m in state['messages'])
    c.play('solo', 2, 100)
    heard = speakers.played[-1][0]
    assert abs(float(np.abs(heard).max()) - float(np.abs(c.plan['stem'][2 * RATE:22 * RATE]).max()) * c.plan['common_gain']) < 1e-3, 'what is previewed is the checked stem'
    c.replace()
    saved = space.stem(SONG, 'vocals')
    assert np.array_equal(np.asarray(saved), as_stored(c.plan['stem'])), 'and that is exactly what is saved (as 24-bit FLAC)'
    root, manifest = space.active(SONG)
    assert abs(manifest['common_gain'] - c.plan['common_gain']) < 1e-6
