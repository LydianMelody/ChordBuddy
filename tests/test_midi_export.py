"""Saving the MIDI: one multichannel file, or one file per track; and the zip of everything the model wrote."""
import io
import json
import zipfile
import mido
import pytest
from chordbuddy.documents import DocumentStore
from chordbuddy.filenames import safe_stem, unique
from chordbuddy.library import Library
from chordbuddy.midi import split_tracks, friendly_track_name


def three_track_midi():
    midi = mido.MidiFile(ticks_per_beat=960)
    conductor = mido.MidiTrack([mido.MetaMessage('set_tempo', tempo=500000), mido.MetaMessage('time_signature', numerator=3, denominator=4)])
    midi.tracks.append(conductor)
    for index, name in enumerate(['Vocal', 'Ins', 'Chords']):
        track = mido.MidiTrack([mido.MetaMessage('track_name', name=name)])
        track.extend([mido.Message('note_on', note=60 + index, velocity=90, channel=index), mido.Message('note_off', note=60 + index, velocity=0, time=960, channel=index)])
        midi.tracks.append(track)
    return midi


@pytest.fixture
def store(tmp_path, mp3_bytes):
    lib = Library(tmp_path)
    song = lib.import_audio('My Song.mp3', mp3_bytes)
    run = lib.create_run(song['id'])
    (run / 'score.abc').write_text('X:1\nT:Test\nM:4/4\nL:1/4\nK:C\n"G"G4|"C"C4|\n')
    (run / 'beat.lab').write_text('0 0.5 1\n')
    (run / 'confidence.json').write_text('{}')
    (run / 'edited').mkdir()
    (run / 'edited' / 'score.abc').write_text('mine')
    three_track_midi().save(run / 'transcription.mid')
    docs = DocumentStore(lib)
    docs.ingest(song['id'], run, 'completed', None)
    return docs, song


def midi_id(docs, song):
    return next(d['id'] for d in docs.for_song(song['id']) if d['name'] == 'transcription.mid')


def test_each_track_with_notes_becomes_its_own_file_and_keeps_the_tempo():
    files = split_tracks(_bytes(three_track_midi()))
    assert [name for name, _ in files] == ['Vocal melody', 'Instruments', 'Chords']
    for index, (_, data) in enumerate(files):
        midi = mido.MidiFile(file=io.BytesIO(data))
        notes = [m for t in midi.tracks for m in t if m.type == 'note_on']
        assert [m.note for m in notes] == [60 + index] and [m.channel for m in notes] == [index]
        assert any(m.type == 'set_tempo' and m.tempo == 500000 for t in midi.tracks for m in t)
        assert any(m.type == 'time_signature' for t in midi.tracks for m in t)


def _bytes(midi):
    stream = io.BytesIO()
    midi.save(file=stream)
    return stream.getvalue()


def test_the_single_file_keeps_every_track_on_its_own_channel(store):
    docs, song = store
    data, name = docs.midi_download(midi_id(docs, song))
    assert name == 'My Song.mid'
    midi = mido.MidiFile(file=io.BytesIO(data))
    assert sorted({m.channel for t in midi.tracks for m in t if m.type == 'note_on'}) == [0, 1, 2]


def test_the_per_track_download_is_a_zip_of_standalone_files(store):
    docs, song = store
    data, name = docs.midi_download(midi_id(docs, song), 'tracks')
    assert name == 'My Song - MIDI tracks.zip'
    archive = zipfile.ZipFile(io.BytesIO(data))
    assert archive.namelist() == ['My Song - Vocal melody.mid', 'My Song - Instruments.mid', 'My Song - Chords.mid']
    assert all(mido.MidiFile(file=io.BytesIO(archive.read(n))).length > 0 for n in archive.namelist())


def test_only_the_two_modes_are_accepted(store):
    docs, song = store
    with pytest.raises(ValueError):
        docs.midi_download(midi_id(docs, song), 'everything')
    with pytest.raises(ValueError):
        docs.midi_download(next(d['id'] for d in docs.for_song(song['id']) if d['kind'] == 'abc'), 'single')


def test_the_outputs_zip_holds_the_models_files_and_nothing_private(store):
    docs, song = store
    data, name = docs.outputs_zip(song['id'])
    assert name == 'My Song - model outputs.zip'
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert 'transcription.mid' in names and 'beat.lab' in names and 'score.abc' in names
    assert 'confidence.json' not in names and not any(n.startswith('edited') for n in names)


def test_file_names_are_made_safe_and_unique():
    assert safe_stem('A/B:C') == 'A B C' and safe_stem('CON') == '_CON' and safe_stem('...') == 'Chord Buddy' and safe_stem('', 'Song') == 'Song'
    assert unique(['a.mid', 'A.mid', 'b.mid']) == ['a.mid', 'A (2).mid', 'b.mid']
    assert friendly_track_name('Ins') == 'Instruments' and friendly_track_name('', 3) == 'Track 4'


def test_the_midi_is_saved_next_to_the_song_and_handed_to_the_computers_program(tmp_path, mp3_bytes, monkeypatch):
    import os
    from pathlib import Path
    from chordbuddy.server import Application
    app = Application(tmp_path, Path.cwd())
    try:
        song = app.library.import_audio('My Song.mp3', mp3_bytes)
        run = app.library.create_run(song['id'])
        (run / 'score.abc').write_text('X:1\nK:C\n"C"C4|')
        three_track_midi().save(run / 'transcription.mid')
        app.documents.ingest(song['id'], run, 'completed', None)
        document = next(d['id'] for d in app.documents.for_song(song['id']) if d['name'] == 'transcription.mid')
        opened = []
        monkeypatch.setattr(os, 'startfile', lambda path: opened.append(path), raising=False)
        monkeypatch.setattr('chordbuddy.server.os.name', 'nt')
        result = app.open_external_midi(song['id'], document)
        saved = Path(result['path'])
        assert saved.parent == app.library.folder(song['id']) / 'external' and saved.name == 'My Song.mid'
        assert mido.MidiFile(saved).tracks and opened == [str(saved)] and result['opened']
        with pytest.raises(ValueError):
            app.open_external_midi('other-song', document)
    finally:
        app.close()
