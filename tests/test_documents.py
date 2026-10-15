import io
import json

import mido
import pytest

from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore, RevisionConflict, abc_tokens, link_chords, timed_chords
from chordbuddy.midi import read_midi, write_midi


def prepare(tmp_path, mp3_bytes):
    lib = Library(tmp_path)
    song = lib.import_audio('Test.mp3', mp3_bytes)
    run = lib.create_run(song['id'])
    (run / 'score.abc').write_text('X:1\nT:Test\nM:4/4\nL:1/4\nK:C\n"G"G4|"C"C4|\n')
    (run / 'events.json').write_text(json.dumps({'events':[
        {'time':0,'values':{'chord':'G:maj'}}, {'time':.2,'values':{'chord':'C:maj'}}]}))
    mid = mido.MidiFile()
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.extend([mido.MetaMessage('set_tempo',tempo=600000),mido.Message('program_change',program=5),mido.Message('note_on',note=67,velocity=90,time=0),mido.Message('note_off',note=67,time=960)])
    mid.save(run / 'transcription.mid')
    docs = DocumentStore(lib)
    docs.ingest(song['id'], run, 'completed', None)
    return lib, docs, song, run


def test_undo_redo_persist_and_edits_do_not_touch_other_outputs(tmp_path, mp3_bytes):
    lib, docs, song, run = prepare(tmp_path, mp3_bytes)
    score = next(d for d in docs.for_song(song['id']) if d['kind']=='abc')
    doc = docs.get(score['id'])
    original_midi = (run / 'transcription.mid').read_bytes()
    new = dict(doc['content'], abc=doc['content']['abc'].replace('"G"','"Gm"'))
    changed = docs.save(doc['id'],new,'Change G to Gm',doc['revision'])
    assert '"Gm"' in changed['content']['abc']
    reopened = DocumentStore(Library(tmp_path))
    undo = reopened.history(doc['id'],'undo',changed['revision'])
    assert '"G"' in undo['content']['abc']
    redo = reopened.history(doc['id'],'redo',undo['revision'])
    assert '"Gm"' in redo['content']['abc']
    assert (run/'transcription.mid').read_bytes() == original_midi
    assert '"G"' in (run/'score.abc').read_text()
    assert redo['content']['chords'][0]['label'] == 'Gm'
    assert redo['content']['chords'][1]['abc_index'] == redo['content']['abc'].index('"C"')


def test_conflicts_branching_and_restore_are_undoable(tmp_path, mp3_bytes):
    _, docs, song, _ = prepare(tmp_path,mp3_bytes)
    doc = docs.get(next(d['id'] for d in docs.for_song(song['id']) if d['kind']=='abc'))
    first = docs.save(doc['id'],dict(doc['content'],abc=doc['content']['abc'].replace('"G"','"Gm"')),'Minor',doc['revision'])
    with pytest.raises(RevisionConflict):
        docs.save(doc['id'],doc['content'],'Stale',doc['revision'])
    undone = docs.history(doc['id'],'undo',first['revision'])
    alternate = docs.save(doc['id'],dict(undone['content'],abc=undone['content']['abc'].replace('"G"','"G7"')),'Seventh',undone['revision'])
    assert not alternate['can_redo']
    restored = docs.history(doc['id'],'restore',alternate['revision'])
    assert restored['content']['abc'] == doc['content']['abc']
    assert '"G7"' in docs.history(doc['id'],'undo',restored['revision'])['content']['abc']


def test_midi_edit_roundtrip_preserves_tempo_program_and_validates(tmp_path, mp3_bytes):
    _, docs, song, _ = prepare(tmp_path, mp3_bytes)
    doc = docs.get(next(d['id'] for d in docs.for_song(song['id']) if d['kind']=='midi'))
    assert doc['content']['notes'][0]['end'] == pytest.approx(1.2)
    content = json.loads(json.dumps(doc['content']))
    content['notes'][0].update(pitch=65, start=.3, end=1.5)
    saved = docs.save(doc['id'],content,'Move note',doc['revision'])
    data, name = docs.export(doc['id'])
    midi = mido.MidiFile(file=io.BytesIO(data))
    assert next(m.note for tr in midi.tracks for m in tr if m.type=='note_on') == 65
    assert next(m.tempo for tr in midi.tracks for m in tr if m.type=='set_tempo') == 600000
    assert next(m.program for tr in midi.tracks for m in tr if m.type=='program_change') == 5
    content['notes'][0]['end'] = -.5
    with pytest.raises(ValueError):
        docs.save(doc['id'],content,'Invalid',saved['revision'])


def test_chord_links_ignore_quoted_titles_and_comments():
    abc = 'X:1\nT:Song "G"\nK:C\n% "G" is a comment\n"G"G4| % "C" another comment\n"C"C4|\n'
    chords = [{'id':'c0','start':0,'end':1,'label':'G'}, {'id':'c1','start':1,'end':2,'label':'C'}]
    linked = link_chords(abc, chords)
    assert [abc[c['abc_index']:c['abc_index']+3] for c in linked] == ['"G"','"C"']
    assert linked[0]['abc_index'] == abc.index('"G"G4')
    assert linked[1]['abc_index'] == abc.index('"C"C4')
    assert len(abc_tokens(abc)) == 2


def test_timed_chords_skip_malformed_events_sort_and_clamp_duration(tmp_path):
    (tmp_path/'events.json').write_text(json.dumps({'events':[
        None, {'time':1,'values':{'chord':'C:maj'}}, {'time':0,'values':{'chord':'G:maj'}},
        {'time':.5,'values':None}, {'time':8,'values':{'chord':'F:maj'}},
        {'time':float('nan'),'values':{'chord':'D:maj'}}]}))
    chords = timed_chords(tmp_path, 2)
    assert [(c['start'],c['end'],c['label']) for c in chords] == [(0,1,'G'),(1,2,'C')]


def test_midi_export_preserves_trailing_silence_and_nonnote_events(tmp_path):
    path = tmp_path/'original.mid'
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.extend([mido.MetaMessage('set_tempo', tempo=500000),
                  mido.MetaMessage('text', text='Original annotation'),
                  mido.Message('control_change', channel=3, control=64, value=127, time=120),
                  mido.Message('note_on', channel=3, note=60, velocity=80, time=120),
                  mido.Message('note_off', channel=3, note=60, time=240),
                  mido.Message('pitchwheel', channel=3, pitch=100, time=120),
                  mido.MetaMessage('end_of_track', time=1320)])
    mid.save(path)
    content = read_midi(path)
    content['notes'][0]['pitch'] = 62
    exported = mido.MidiFile(file=io.BytesIO(write_midi(path, content)))
    def timed_nonnotes(midi):
        rows=[]
        tick=0
        for msg in midi.tracks[0]:
            tick += msg.time
            if msg.type not in ('note_on','note_off'):
                rows.append((tick, msg.copy(time=0).dict()))
        return rows
    assert timed_nonnotes(exported) == timed_nonnotes(mid)
    assert exported.length == pytest.approx(mid.length)
