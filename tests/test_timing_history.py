import copy
import importlib.util
import json
import pytest
from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore,RevisionConflict
from test_reprocess import seed,ingest

def fixture(tmp_path):
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib)
    ingest(docs,extra={'beat.lab':'0 1 4 4\n1 2 4 4\n2 3 4 4\n3 4 4 4\n4 1 4 4\n5 2 4 4\n','downbeat.lab':'0\n4\n'})
    doc=docs.get(next(x['id'] for x in docs.for_song('song') if x['kind']=='chart'))
    return lib,docs,doc

def test_timing_and_chart_undo_atomically(tmp_path):
    lib,docs,before=fixture(tmp_path)
    assert 'timing_binding' in before,'Chart history lacks timing binding'
    version=docs.timing_version(before)
    version['bars'][0]['beats'][1]=1.2
    ident=docs.timing.put_version(version)
    binding={'version_id':ident,'overrides':{}}
    applied=docs.save_bound_chart(before['id'],before['content'],binding,'Correction',docs.revision_stamp(before['id']))
    assert applied['music']['measures'][0]['beats'][1]==1.2
    undone=docs.history(before['id'],'undo',applied['revision'])
    assert undone['content']==before['content'] and undone['timing_binding']==before['timing_binding']
    redone=docs.history(before['id'],'redo',undone['revision'])
    lib.close();lib=Library(tmp_path);docs=DocumentStore(lib)
    reopened=docs.get(before['id'])
    assert redone['timing_binding']==reopened['timing_binding']==applied['timing_binding']
    assert reopened['music']==applied['music']
    lib.close()

def test_stale_binding_and_failed_commit_preserve_state(tmp_path,monkeypatch):
    lib,docs,before=fixture(tmp_path)
    assert hasattr(docs,'revision_stamp'),'Atomic timing edits missing'
    stamp=docs.revision_stamp(before['id']);binding=before['timing_binding']
    content=copy.deepcopy(before['content']);content['sections'][0]['name']='User name'
    edited=docs.save(before['id'],content,'Rename',before['revision'])
    with pytest.raises(RevisionConflict):docs.save_bound_chart(before['id'],before['content'],binding,'stale',stamp)
    assert docs.get(before['id'])['content']==edited['content']
    def fail(*args):raise OSError('disk full')
    monkeypatch.setattr(docs.timing,'record_binding',fail)
    with pytest.raises(OSError):docs.save_bound_chart(before['id'],before['content'],binding,'failure',docs.revision_stamp(before['id']))
    assert docs.get(before['id'])['revision']==edited['revision']
    lib.close()

def test_open_does_not_rewrite_edit_zero(tmp_path):
    lib,docs,before=fixture(tmp_path)
    original=lib.db.execute('SELECT content FROM edits WHERE document_id=? AND position=0',(before['id'],)).fetchone()[0]
    docs.get(before['id']);docs.for_song('song')
    assert lib.db.execute('SELECT content FROM edits WHERE document_id=? AND position=0',(before['id'],)).fetchone()[0]==original
    lib.close()

def test_selected_chart_timing_uses_undo_binding(tmp_path):
    lib,docs,before=fixture(tmp_path)
    assert hasattr(docs,'set_chart_timing'),'Selected chart timing needs bound history'
    result=docs.set_chart_timing(before['id'],{'constant_tempo':True,'bpm':80},before['revision'])
    assert result['timing_binding']['overrides']['bpm']==80
    undo=docs.history(before['id'],'undo',result['revision'])
    assert undo['music']==before['music']
    assert lib.song_metadata('song')['timing']['bpm'] is None
    lib.close()

def test_chord_metadata_retains_corrected_timing(tmp_path):
    lib,docs,before=fixture(tmp_path)
    before['content']['chords']=[{'id':'c0','label':'C','start':0,'end':10,'section_id':before['content']['sections'][0]['id'],'line':None,'offset':None}]
    version=docs.timing_version(before);version['bars'][0]['beats'][1]=1.2
    binding={'version_id':docs.timing.put_version(version),'overrides':{}}
    corrected=docs.save_bound_chart(before['id'],before['content'],binding,'Correction',docs.revision_stamp(before['id']))
    docs.apply_song_metadata('song',{'timing':{'constant_tempo':False,'bpm':None},'chord_overrides':[{'id':'c-user','label':'F','start':0,'end':2}]})
    after=docs.get(before['id'])
    assert after['timing_binding']==corrected['timing_binding']
    assert after['music']==corrected['music']
    lib.close()

def test_timing_only_change_is_retained_on_reanalysis(tmp_path):
    lib,docs,before=fixture(tmp_path)
    version=docs.timing_version(before);version['bars'][0]['beats'][1]=1.2
    binding={'version_id':docs.timing.put_version(version),'overrides':{}}
    applied=docs.save_bound_chart(before['id'],before['content'],binding,'Correction',docs.revision_stamp(before['id']))
    assert applied['user_modified']
    ingest(docs,policy='keep',previous=before['run_id'])
    assert any(d['id']==before['id'] and d['kept'] for d in docs.for_song('song'))
    assert docs.get(before['id'])['timing_binding']==binding
    lib.close()
