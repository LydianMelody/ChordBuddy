"""Pitch control's MIDI export: every note moves by the pitch except drums, and the file name says what was done."""
import io
import mido
import pytest
from chordbuddy.midi import transpose_midi
from test_midi_export import store, midi_id, _bytes  # noqa: F401  (the shared library fixture)


def song_with_drums():
    midi = mido.MidiFile(ticks_per_beat=480)
    for name, channel, note in [('Vocal', 0, 60), ('Kit', 9, 36), ('Drums', 2, 38), ('Chords', 1, 64)]:
        track = mido.MidiTrack([mido.MetaMessage('track_name', name=name)])
        track.extend([mido.Message('note_on', note=note, velocity=90, channel=channel), mido.Message('note_off', note=note, velocity=0, time=480, channel=channel)])
        midi.tracks.append(track)
    return _bytes(midi)


def notes(data):
    midi = mido.MidiFile(file=io.BytesIO(data))
    return {t.name: [m.note for m in t if m.type in ('note_on', 'note_off')] for t in midi.tracks}


def test_notes_move_and_drums_stay():
    moved = notes(transpose_midi(song_with_drums(), 3))
    assert moved == {'Vocal': [63, 63], 'Kit': [36, 36], 'Drums': [38, 38], 'Chords': [67, 67]}
    assert notes(transpose_midi(song_with_drums(), -6))['Vocal'] == [54, 54]


def test_zero_returns_the_same_bytes_and_bad_pitches_are_refused():
    data = song_with_drums()
    assert transpose_midi(data, 0) is data
    for bad in (7, -7, 1.5, True, '2'):
        with pytest.raises(ValueError):
            transpose_midi(data, bad)


def test_the_export_is_moved_and_named_for_the_pitch(store):
    docs, song = store
    plain, plain_name = docs.midi_download(midi_id(docs, song))
    moved, name = docs.midi_download(midi_id(docs, song), 'single', 3, 'Eb major')
    assert name == 'My Song (+3, Eb major).mid' and plain_name == 'My Song.mid'
    before = [m.note for t in mido.MidiFile(file=io.BytesIO(plain)).tracks for m in t if m.type == 'note_on']
    after = [m.note for t in mido.MidiFile(file=io.BytesIO(moved)).tracks for m in t if m.type == 'note_on']
    assert after == [n + 3 for n in before]
    _, down = docs.midi_download(midi_id(docs, song), 'tracks', -2)
    assert down == 'My Song (-2) - MIDI tracks.zip'
    with pytest.raises(ValueError):
        docs.midi_download(midi_id(docs, song), 'single', 2, 'C minor; rm -rf')


# ---- the sound exports: the page uploads pitched PCM, the server encodes it and hands back an MP3 or a zip of stems ----
import math
import struct
import zipfile
from pathlib import Path
from chordbuddy.mix_export import PitchRenders, encode_pcm, mix_pcm_size

PROJECT = Path(__file__).resolve().parent.parent
needs_ffmpeg = pytest.mark.skipif(not (PROJECT / 'tools' / 'ffmpeg.exe').is_file(), reason='the bundled encoder is not installed')


def tone(seconds=1.0, hz=440.0):
    frames = int(44100 * seconds)
    return b''.join(struct.pack('<hh', v, v) for v in (int(12000 * math.sin(2 * math.pi * hz * i / 44100)) for i in range(frames)))


@needs_ffmpeg
def test_a_pitched_mix_is_encoded_then_downloaded_once(tmp_path):
    renders = PitchRenders(PROJECT, tmp_path / 'renders')
    assert renders.put('abcd1234ef', 'mix', tone()) == {'ok': True}
    got, sent = [], []
    renders.send('abcd1234ef', 'mix', 'Song (+3, C minor)', lambda kind, name, size=None: got.append((kind, name, size)), sent.append)
    data = b''.join(sent)
    assert got[0][:2] == ('audio/mpeg', 'Song (+3, C minor).mp3') and got[0][2] == len(data) and len(data) > 1000
    assert data[:3] == b'ID3' or data[:2] == b'\xff\xfb'
    assert not (tmp_path / 'renders' / 'abcd1234ef').exists(), 'the parts are removed once downloaded'
    with pytest.raises(KeyError):
        renders.send('abcd1234ef', 'mix', 'Song', lambda *a: None, sent.append)


@needs_ffmpeg
def test_pitched_stems_come_back_as_one_zip_named_like_the_plain_stems(tmp_path):
    renders = PitchRenders(PROJECT, tmp_path / 'renders')
    for role in ('vocals', 'drums'):
        renders.put('stemjob12', role, tone(.5))
    sent = []
    renders.send('stemjob12', 'stems', 'Song (-2)', lambda *a: None, sent.append)
    names = zipfile.ZipFile(io.BytesIO(b''.join(sent))).namelist()
    assert names == ['Song (-2)_Vocals.mp3', 'Song (-2)_Drums.mp3']


def test_bad_parts_jobs_and_audio_are_refused(tmp_path):
    renders = PitchRenders(PROJECT, tmp_path / 'renders')
    for job, part, pcm in [('../escape', 'mix', tone(.1)), ('short', 'mix', tone(.1)), ('abcd1234ef', 'everything', tone(.1)), ('abcd1234ef', 'mix', b'abc')]:
        with pytest.raises(ValueError):
            renders.put(job, part, pcm)
    assert mix_pcm_size({'frames': 44100}) == 352800
