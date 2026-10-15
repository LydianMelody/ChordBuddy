import copy
import json

import pytest

from chordbuddy.documents import DocumentStore
from chordbuddy.library import Library


def prepare_chart(tmp_path, mp3_bytes):
    library=Library(tmp_path)
    song=library.import_audio('Chart.mp3',mp3_bytes)
    run=library.create_run(song['id'])
    duration=song['duration']
    (run/'structure.lab').write_text(f'0\t{duration*.2}\tintro\n{duration*.2}\t{duration*.4}\tverse\n{duration*.4}\t{duration*.6}\tverse\n{duration*.8}\t{duration}\toutro\n')
    (run/'events.json').write_text(json.dumps({'events':[
        {'time':0,'values':{'chord':'G#:min7/b7'}},
        {'time':duration*.4,'values':{'chord':'C:maj'}}]}))
    (run/'score.abc').write_text('X:1\nK:C\n"G#m7/F#"G4|"C"C4|\n')
    store=DocumentStore(library)
    store.ingest(song['id'],run,'completed',None)
    return library,store,song,run


def chart_document(store,song_id):
    rows=store.for_song(song_id)
    charts=[row for row in rows if row['kind']=='chart']
    assert len(charts)==1,'Exactly one editable song chart must be created for each run'
    return store.get(charts[0]['id'])


def test_sections_merge_adjacent_and_cover_gaps_with_normalized_chords(tmp_path,mp3_bytes):
    _,store,song,run=prepare_chart(tmp_path,mp3_bytes)
    chart=chart_document(store,song['id'])
    content=chart['content']
    assert chart['name']=='Song chart.json'
    assert content['version']==1
    assert content['duration']==song['duration']
    assert [s['name'] for s in content['sections']]==['Intro','Verse','Instrumental','Outro']
    assert content['sections'][1]['end']==pytest.approx(song['duration']*.6)
    assert content['sections'][0]['start']==0
    assert content['sections'][-1]['end']==song['duration']
    assert all(a['end']==pytest.approx(b['start']) for a,b in zip(content['sections'],content['sections'][1:]))
    assert [chord['label'] for chord in content['chords']]==['G#m7/F#','C']
    assert all(c['line'] is None and c['offset'] is None for c in content['chords'])
    assert not (run/'Song chart.json').exists(),'A derived chart must not overwrite model original outputs'


def test_lazy_upgrade_uses_corrected_abc_without_rewriting_old_history(tmp_path,mp3_bytes):
    library,store,song,run=prepare_chart(tmp_path,mp3_bytes)
    # Simulate a library created before the chart document kind existed.
    with library.transaction() as db:
        ids=[row[0] for row in db.execute("SELECT id FROM documents WHERE kind='chart'")]
        for document_id in ids:
            db.execute('DELETE FROM edits WHERE document_id=?',(document_id,))
            db.execute('DELETE FROM documents WHERE id=?',(document_id,))
    score=store.get(next(d['id'] for d in store.for_song(song['id']) if d['kind']=='abc'))
    corrected=store.save(score['id'],dict(score['content'],abc=score['content']['abc'].replace('"C"','"Cm"')),'Correct C',score['revision'])
    # Remove any chart created by the lookup above, then reopen as an old library.
    with library.transaction() as db:
        for row in db.execute("SELECT id FROM documents WHERE kind='chart'").fetchall():
            db.execute('DELETE FROM edits WHERE document_id=?',(row[0],))
            db.execute('DELETE FROM documents WHERE id=?',(row[0],))
        prior=[tuple(row) for row in db.execute('SELECT * FROM edits WHERE document_id=?',(score['id'],))]
    library.close()
    reopened=DocumentStore(Library(tmp_path))
    chart=chart_document(reopened,song['id'])
    again=chart_document(reopened,song['id'])
    assert again['id']==chart['id']
    assert chart['content']['chords'][-1]['label']=='Cm'
    assert reopened.get(score['id'])==corrected
    assert [tuple(row) for row in reopened.library.db.execute('SELECT * FROM edits WHERE document_id=?',(score['id'],))]==prior


def test_chart_lyrics_anchors_history_reopen_export_and_abc_independence(tmp_path,mp3_bytes):
    library,store,song,run=prepare_chart(tmp_path,mp3_bytes)
    chart=chart_document(store,song['id'])
    score=store.get(next(d['id'] for d in store.for_song(song['id']) if d['kind']=='abc'))
    original_abc=(run/'score.abc').read_bytes()
    original_events=(run/'events.json').read_bytes()
    content=copy.deepcopy(chart['content'])
    content['sections'][0]['lyrics']='Hello world\nSecond line'
    content['chords'][0].update(line=0,offset=6,label='Gm7')
    saved=store.save(chart['id'],content,'Place chord over world',chart['revision'])
    library.close()
    reopened=DocumentStore(Library(tmp_path))
    undo=reopened.history(chart['id'],'undo',saved['revision'])
    assert undo['content']==chart['content']
    redo=reopened.history(chart['id'],'redo',undo['revision'])
    assert redo['content']==content
    data,name=reopened.export(chart['id'])
    assert name=='Song chart.json'
    assert json.loads(data)==content
    assert json.loads((run/'edited'/'Song chart.json').read_text())==content
    assert reopened.get(score['id'])==score
    assert (run/'score.abc').read_bytes()==original_abc
    assert (run/'events.json').read_bytes()==original_events


@pytest.mark.parametrize('change', ['duration','nan','overlap','duplicate','section','line','offset','half_anchor','chord_order'])
def test_invalid_chart_changes_are_atomic(tmp_path,mp3_bytes,change):
    _,store,song,_=prepare_chart(tmp_path,mp3_bytes)
    chart=chart_document(store,song['id'])
    content=copy.deepcopy(chart['content'])
    if change=='duration': content['duration']+=1
    elif change=='nan': content['sections'][0]['start']=float('nan')
    elif change=='overlap': content['sections'][1]['start']=0
    elif change=='duplicate': content['sections'][1]['id']=content['sections'][0]['id']
    elif change=='section': content['chords'][0]['section_id']=content['sections'][-1]['id']
    elif change=='line': content['chords'][0].update(line=5,offset=0)
    elif change=='offset': content['chords'][0].update(line=0,offset=1)
    elif change=='half_anchor': content['chords'][0].update(line=0,offset=None)
    elif change=='chord_order': content['chords'].reverse()
    with pytest.raises(ValueError):
        store.save(chart['id'],content,'Invalid chart edit',chart['revision'])
    assert store.get(chart['id'])==chart


@pytest.mark.parametrize('label',['A'*81,' '+ 'A'*81 +' '])
def test_lazy_chart_preserves_legacy_long_abc_chord_and_all_document_access(tmp_path,mp3_bytes,label):
    library,store,song,run=prepare_chart(tmp_path,mp3_bytes)
    score=store.get(next(d['id'] for d in store.for_song(song['id']) if d['kind']=='abc'))
    changed=store.save(score['id'],dict(score['content'],abc=score['content']['abc'].replace('"G#m7/F#"',f'"{label}"')),'Legacy long chord',score['revision'])
    with library.transaction() as db:
        for row in db.execute("SELECT id FROM documents WHERE kind='chart'").fetchall():
            db.execute('DELETE FROM edits WHERE document_id=?',(row[0],))
            db.execute('DELETE FROM documents WHERE id=?',(row[0],))
    detail=store.song_detail(song['id'])
    chart=store.get(next(d['id'] for d in detail['documents'] if d['kind']=='chart'))
    assert chart['content']['chords'][0]['label']==label
    assert store.get(score['id'])==changed
    assert (run/'score.abc').read_text()=='X:1\nK:C\n"G#m7/F#"G4|"C"C4|\n'
