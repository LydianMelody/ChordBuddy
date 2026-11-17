"""Stems stored as 24-bit FLAC (chordbuddy/stem_audio.py): exact round trips, stems louder than full scale, reading WAV and FLAC the same
way, publishing a compressed split, cleaning it up, and closing open files so Windows can delete them."""
import os
from pathlib import Path

import numpy as np
import pytest

from test_separation_store import seed
from chordbuddy import stem_audio
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.separation_audio import index_wav, write_float
from chordbuddy.separation_checks import validate_mix
from chordbuddy.separation_contract import STEMS, TRACKS, file_hash
import chordbuddy.stem_retention as retention

RATE = 44100


def tone(seconds=3.0, peak=.5, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    left = np.sin(2 * np.pi * 220 * t) * .6 + rng.normal(0, .1, len(t))
    right = np.sin(2 * np.pi * 330 * t) * .6 + rng.normal(0, .1, len(t))
    audio = np.stack([left, right], axis=1)
    return (audio / np.abs(audio).max() * peak).astype(np.float32)


def as_stored(audio):
    audio = np.asarray(audio, dtype=np.float32)
    scale = stem_audio.scale_for(float(np.abs(audio).max()))
    return ((stem_audio._quantize(audio, scale) >> 8).astype(np.float64) / stem_audio.FULL * scale).astype(np.float32)


def write_wav(path, audio):
    write_float(path, np.asarray(audio, dtype=np.float32).reshape(-1).tolist())


@pytest.fixture(autouse=True)
def closed():
    yield
    stem_audio.release()


def test_quiet_stem_round_trips_to_its_24_bit_rounding(tmp_path):
    audio = tone(peak=.7)
    info = stem_audio.write_flac(tmp_path / 'bass.flac', audio)
    assert info['format'] == stem_audio.FLAC and info['scale'] == 1.0 and info['frames'] == len(audio)
    back = stem_audio.read_all(tmp_path / 'bass.flac', info)
    assert np.array_equal(back, as_stored(audio))
    assert float(np.abs(back - audio).max()) <= .5 / stem_audio.FULL + 1e-12, 'never more than half a 24-bit step away'
    assert stem_audio.index(tmp_path / 'bass.flac') == dict(info, scale=1.0)
    assert not (tmp_path / 'bass.flac.part').exists()


def test_stem_louder_than_full_scale_is_kept_whole(tmp_path):
    audio = tone(peak=1.87, seed=3)               # the loudest real stem found in the library
    info = stem_audio.write_flac(tmp_path / 'vocals.flac', audio)
    assert info['scale'] == 2.0
    assert stem_audio.index(tmp_path / 'vocals.flac') == info, 'the file itself says how it was scaled'
    back = stem_audio.read_all(tmp_path / 'vocals.flac', info)
    assert float(np.abs(back).max()) > 1.8, 'nothing cut off at full scale'
    assert float(np.abs(back - audio).max()) <= 1 / stem_audio.FULL + 1e-12


def test_scale_is_a_power_of_two_and_refuses_broken_audio():
    assert [stem_audio.scale_for(p) for p in (0, .5, 1.0, 1.01, 2.0, 3.5)] == [1, 1, 1, 2, 2, 4]
    with pytest.raises(ValueError):
        stem_audio.scale_for(float('nan'))
    with pytest.raises(ValueError):
        stem_audio.scale_for(1000.0)
    with pytest.raises(ValueError):
        stem_audio.write_flac('unused.flac', np.full((10, 2), np.inf, dtype=np.float32))


def test_frames_read_the_same_from_wav_and_flac(tmp_path):
    audio = tone(seconds=2.5, peak=1.3, seed=1)
    stored = as_stored(audio)
    write_wav(tmp_path / 'a.wav', stored)
    flac = stem_audio.write_flac(tmp_path / 'a.flac', audio)
    wav = stem_audio.index(tmp_path / 'a.wav')
    for start, count in ((0, 1), (0, RATE), (12345, 4410), (len(audio) - 100, RATE)):
        a = stem_audio.read_frames(tmp_path / 'a.wav', wav, start, count)
        b = stem_audio.read_frames(tmp_path / 'a.flac', flac, start, count)
        assert a.typecode == b.typecode == 'f' and a.tobytes() == b.tobytes()
    for bad in ((-1, 10), (0, 0), (0, RATE + 1), (len(audio), 1)):
        with pytest.raises(ValueError):
            stem_audio.read_frames(tmp_path / 'a.flac', flac, *bad)


def test_flac_frames_slice_without_decoding_everything(tmp_path):
    audio = tone(seconds=2, peak=1.5, seed=2)
    info = stem_audio.write_flac(tmp_path / 'a.flac', audio)
    view = stem_audio.frames(tmp_path / 'a.flac', info)
    whole = as_stored(audio)
    assert view.shape == whole.shape and len(view) == len(whole)
    assert np.array_equal(view[1000:5000], whole[1000:5000]) and np.array_equal(view[-10:], whole[-10:])
    assert view[50:50].shape == (0, 2)
    assert np.array_equal(np.asarray(view), whole) and np.array_equal(view[::2], whole[::2])
    write_wav(tmp_path / 'b.wav', whole)
    assert isinstance(stem_audio.frames(tmp_path / 'b.wav', index_wav(tmp_path / 'b.wav')), np.memmap)


def test_wire_chunk_mixes_formats_in_track_order(tmp_path):
    frames = RATE * 2
    stems = {r: as_stored(tone(seconds=2, peak=.3, seed=i)) for i, r in enumerate(TRACKS)}
    assets = []
    for role, audio in stems.items():
        if role in ('original', 'drums'):
            write_wav(tmp_path / (role + '.wav'), audio)
            assets.append(dict(index_wav(tmp_path / (role + '.wav')), role=role, relative_path=role + '.wav'))
        else:
            info = stem_audio.write_flac(tmp_path / (role + '.flac'), audio)
            assets.append(dict(info, role=role, relative_path=role + '.flac'))
    payload, actual = stem_audio.wire_chunk(tmp_path, {'frames': frames, 'assets': assets}, 1000, 2000)
    assert actual == 2000
    expected = b''.join(stems[r][1000:3000].astype('<f4').tobytes() for r in TRACKS)
    assert payload == expected


def song_folder(root, peak=.4):
    stems = {r: tone(seconds=1.5, peak=peak, seed=i) for i, r in enumerate(STEMS)}
    stems['vocals'] = tone(seconds=1.5, peak=1.6, seed=9)       # one stem louder than full scale
    for role, audio in stems.items():
        write_wav(root / (role + '.wav'), audio)
    write_wav(root / 'original.wav', sum(stems.values()) * .2)
    write_wav(root / 'guitar.wav', stems['lead'] + stems['rhythm'])
    return stems


def test_compressed_split_validates_and_loses_only_its_wavs(tmp_path):
    stems = song_folder(tmp_path)
    checked = validate_mix(tmp_path)
    compressed = stem_audio.compress_assets(tmp_path, checked, STEMS)
    by_role = {a['role']: a for a in compressed['assets']}
    assert by_role['original']['relative_path'] == 'original.wav' and by_role['original']['format'] == 'float32le'
    assert all(by_role[r]['relative_path'] == r + '.flac' and by_role[r]['file_sha256'] == file_hash(tmp_path / (r + '.flac')) for r in STEMS)
    assert by_role['vocals']['scale'] == 2.0 and by_role['bass']['scale'] == 1.0
    assert compressed['common_gain'] == checked['common_gain'] and compressed['frames'] == checked['frames']
    stem_audio.drop_wavs(tmp_path, STEMS)
    assert not any((tmp_path / (r + '.wav')).exists() for r in STEMS) and (tmp_path / 'original.wav').exists()
    again = validate_mix(tmp_path)                               # the checker reads the FLACs now (guitar.wav is still a WAV)
    assert [a['relative_path'] for a in again['assets']] == [a['relative_path'] for a in compressed['assets']]
    assert {a['role']: a.get('scale') for a in again['assets']} == {a['role']: a.get('scale') for a in compressed['assets']}
    assert abs(again['common_gain'] - checked['common_gain']) < 1e-5
    for role in STEMS:
        back = stem_audio.read_all(tmp_path / (role + '.flac'), by_role[role])
        assert float(np.abs(back - stems[role]).max()) <= by_role[role]['scale'] / stem_audio.FULL


def test_published_flac_split_plays_and_its_cleanup_removes_flacs(tmp_path):
    lib, store = seed(tmp_path)
    analysis = AnalysisStore(lib)
    runs = []
    for _ in range(2):
        run = store.create_run('song', 'recipe')
        runs.append(run)
        root = tmp_path / run['folder']
        song_folder(root)
        manifest = stem_audio.compress_assets(root, validate_mix(root), STEMS)
        manifest.update(source_sha256=file_hash(tmp_path / 'song/source.mp3'), recipe_sha256='recipe')
        store.update_progress(run['id'], 'validating')
        store.activate_validated(run['id'], manifest)
        stem_audio.drop_wavs(root, STEMS)
        (root / 'guitar.wav').unlink()
    old = tmp_path / runs[0]['folder']
    root, manifest = store.get_published_run(runs[0]['id'])
    payload, actual = stem_audio.wire_chunk(root, manifest, 0, 100)    # the old run was playing: its FLACs are open
    assert actual == 100 and stem_audio.open_count() == len(STEMS)
    result = retention.prune_stem_history(tmp_path, store, analysis, song_id='song',
                                          readiness=lambda song: {'ready': True, 'active': {'run_id': runs[-1]['id']}})
    assert not result['warning'] and len(result['purged']) == 1
    assert sorted(result['purged'][0]['files']) == sorted([r + '.flac' for r in STEMS] + ['guitar.wav'])
    assert not any((old / (r + '.flac')).exists() for r in STEMS) and (old / 'original.wav').exists()
    assert all((tmp_path / runs[-1]['folder'] / (r + '.flac')).exists() for r in STEMS)
    lib.close()


def test_release_closes_files_so_they_can_be_deleted(tmp_path):
    info = stem_audio.write_flac(tmp_path / 'a.flac', tone(seconds=1))
    stem_audio.read_frames(tmp_path / 'a.flac', info, 0, 100)
    assert stem_audio.open_count() == 1
    stem_audio.release(tmp_path / 'elsewhere')
    assert stem_audio.open_count() == 1, 'only files under the folder named'
    stem_audio.release(tmp_path)
    assert stem_audio.open_count() == 0
    os.unlink(tmp_path / 'a.flac')


def test_a_replaced_file_is_never_read_from_the_old_open_one(tmp_path):
    first = stem_audio.write_flac(tmp_path / 'a.flac', tone(seconds=1, seed=1))
    stem_audio.read_frames(tmp_path / 'a.flac', first, 0, 10)
    stem_audio.release(tmp_path)                       # replacing a file means deleting the old one first, as the app does
    audio = tone(seconds=1.2, seed=2)
    second = stem_audio.write_flac(tmp_path / 'a.flac', audio)
    assert stem_audio.read_frames(tmp_path / 'a.flac', second, 0, 10).tobytes() == as_stored(audio)[:10].astype('<f4').tobytes()


def test_idle_files_are_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(stem_audio, 'IDLE_SECONDS', .2)
    info = stem_audio.write_flac(tmp_path / 'a.flac', tone(seconds=1))
    stem_audio.read_frames(tmp_path / 'a.flac', info, 0, 10)
    import time
    deadline = time.monotonic() + 5
    while stem_audio.open_count() and time.monotonic() < deadline:
        time.sleep(.05)
    assert stem_audio.open_count() == 0
    os.unlink(tmp_path / 'a.flac')
