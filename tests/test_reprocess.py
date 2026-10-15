import json
from unittest.mock import patch
import pytest
from chordbuddy.library import Library, now
from chordbuddy.documents import DocumentStore, RevisionConflict
from chordbuddy.server import Application


def seed(lib):
    with lib.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',('song','Test','','test.mp3',20,'Test','imported',None,None,now()))
    lib.folder('song').mkdir()
    lib.source_path('song').write_bytes(b'audio')


def ingest(store,status='completed',policy='replace',previous=None,extra=None):
    run=store.library.create_run('song')
    (run/'run-options.json').write_text(json.dumps({'previous_run':previous,'edit_policy':policy,'confidence':{}}))
    (run/'score.abc').write_text('X:1\nK:C\n"C"C4|')
    if extra:
        for name,text in extra.items():
            path=run/name
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(text)
    store.ingest('song',run,status,None)
    return run.name


def edited_chart(store):
    doc=next(d for d in store.for_song('song') if d['kind']=='chart')
    full=store.get(doc['id'])
    full['content']['sections'][0]['lyrics']='My own lyric'
    return store.save(doc['id'],full['content'],'Paste lyrics',full['revision'])


def test_keep_retains_original_id_provenance_history_and_propagates(tmp_path):
    lib=Library(tmp_path); seed(lib); store=DocumentStore(lib)
    old=ingest(store); edited=edited_chart(store)
    new=ingest(store,policy='keep',previous=old)
    docs=store.for_song('song')
    kept=next(d for d in docs if d.get('kept'))
    assert kept['id']==edited['id'] and kept['run_id']==old and kept['user_modified']
    assert kept['name'].endswith(' · kept edits')
    assert len([d for d in docs if d['kind']=='chart'])==2
    assert store.get(kept['id'])['content']==edited['content']
    assert store.get(kept['id'])['can_undo']
    assert store.get(kept['id'])['kept']
    assert store.get(kept['id'])['run_id']==old
    newer=ingest(store,policy='keep',previous=new)
    assert lib.song('song')['active_run']==newer
    assert next(d for d in store.for_song('song') if d.get('kept'))['id']==edited['id']
    assert lib.db.execute('SELECT name FROM documents WHERE id=?',(edited['id'],)).fetchone()[0]=='Song chart.json'


def test_actual_content_not_history_cursor_determines_changes(tmp_path):
    lib=Library(tmp_path); seed(lib); store=DocumentStore(lib); ingest(store)
    edited=edited_chart(store)
    restored=store.history(edited['id'],'restore',edited['revision'])
    assert restored['can_undo'] and not restored['user_modified']


def test_replace_preserves_recoverable_prior_run(tmp_path):
    lib=Library(tmp_path); seed(lib); store=DocumentStore(lib); old=ingest(store); edited=edited_chart(store)
    new=ingest(store,previous=old)
    assert not any(d.get('kept') for d in store.for_song('song'))
    lib.activate_run('song',old)
    assert store.get(edited['id'])['content']==edited['content']
    assert edited['id'] in [d['id'] for d in store.for_song('song')]
    assert {r['id'] for r in lib.runs('song')}=={old,new}
    assert all(r['has_documents'] for r in lib.runs('song'))


@pytest.mark.parametrize('status',['failed','cancelled','partial'])
def test_unsuccessful_partial_run_does_not_replace_successful_active(tmp_path,status):
    lib=Library(tmp_path); seed(lib); store=DocumentStore(lib); old=ingest(store)
    bad=ingest(store,status=status,previous=old)
    assert lib.song('song')['active_run']==old
    lib.activate_run('song',bad)
    assert lib.song('song')['active_run']==bad


def test_ingestion_hides_internal_metadata_and_unfiltered_originals(tmp_path):
    lib=Library(tmp_path); seed(lib); store=DocumentStore(lib)
    ingest(store,extra={'confidence.json':'{}','unfiltered/score.abc':'X:1\nK:C\nD4|'})
    assert {d['name'] for d in store.for_song('song')}=={'score.abc','Song chart.json'}


def test_settings_typed_partial_validation_persists_and_device_legacy(tmp_path):
    lib=Library(tmp_path)
    assert lib.state()['settings']=={'device':'auto','beat_flag_threshold':50,'beat_remove_threshold':0,'chord_flag_threshold':50,'chord_opacity_min':40,'chord_opacity_max':100}
    assert lib.settings({'beat_flag_threshold':60,'beat_remove_threshold':10})['device']=='auto'
    assert lib.settings('cpu')['beat_remove_threshold']==10
    for patch_value in [{'beat_remove_threshold':61},{'beat_flag_threshold':9},{'chord_flag_threshold':True},{'strange':4}]:
        with pytest.raises(ValueError): lib.settings(patch_value)
    lib.close(); reopened=Library(tmp_path)
    assert reopened.state()['settings']['beat_flag_threshold']==60


def test_reprocess_requires_policy_before_creating_run_and_snapshots_options(tmp_path):
    app=Application(tmp_path); seed(app.library); old=ingest(app.documents); edited_chart(app.documents)
    def start(song_id,source,run,device):
        options=json.loads((run/'run-options.json').read_text())
        assert options['previous_run']==old and options['edit_policy']=='keep'
        assert options['model']['id']=='m-a-p/SheetSage2'
        assert options['model']['revision']=='7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384'
        assert options['confidence']=={'beat_flag_threshold':50,'beat_remove_threshold':0,'chord_flag_threshold':50}
        return {'status':'starting'}
    with patch.object(app.engine,'readiness',return_value={'ready':True}),patch.object(app.engine,'start',side_effect=start):
        with pytest.raises(ValueError,match='Keep|keep'): app.transcribe('song')
        assert len(app.library.runs('song'))==1
        assert app.transcribe('song','keep')['status']=='starting'
    app.close()


def test_activation_rejects_wrong_song_unregistered_and_busy(tmp_path):
    app=Application(tmp_path); seed(app.library); run=ingest(app.documents)
    with pytest.raises(ValueError): app.activate_run('song','missing')
    with patch.object(app.engine,'snapshot',return_value={'status':'running'}):
        with pytest.raises(RevisionConflict): app.activate_run('song',run)
    app.close()


def test_run_options_sidecar_allowed_but_other_outputs_rejected(tmp_path):
    import sys, threading
    from chordbuddy.engine import Engine
    audio=tmp_path/'audio.mp3'; audio.write_bytes(b'audio')
    run=tmp_path/'run'; run.mkdir(); (run/'run-options.json').write_text('{}')
    worker=tmp_path/'worker.py'; worker.write_text('print("explicit subprocess fixture")')
    done=threading.Event()
    engine=Engine(tmp_path,lambda *args:done.set())
    with patch.object(engine,'readiness',return_value={'ready':True}),patch.object(engine,'_command',return_value=[sys.executable,str(worker)]):
        assert engine.start('song',audio,run)['status'] in ('starting','running')
        assert done.wait(10)
        assert engine.wait(10)
        other=tmp_path/'occupied'; other.mkdir(); (other/'score.abc').write_text('X:1\nK:C\nC4|')
        with pytest.raises(ValueError,match='empty'): engine.start('song',audio,other)
        directory=tmp_path/'bad-options'; directory.mkdir(); (directory/'run-options.json').mkdir()
        with pytest.raises(ValueError,match='empty'): engine.start('song',audio,directory)


def test_keep_includes_edits_made_after_job_launch(tmp_path):
    lib=Library(tmp_path);seed(lib);store=DocumentStore(lib);old=ingest(store)
    run=lib.create_run('song')
    (run/'run-options.json').write_text(json.dumps({'previous_run':old,'edit_policy':'keep'}))
    (run/'score.abc').write_text('X:1\nK:C\nD4|')
    edited=edited_chart(store)
    store.ingest('song',run,'completed',None)
    assert next(d for d in store.for_song('song') if d['kept'])['id']==edited['id']


def test_failed_initial_partial_requires_explicit_activation(tmp_path):
    lib=Library(tmp_path);seed(lib);store=DocumentStore(lib)
    partial=ingest(store,status='partial')
    assert lib.song('song')['active_run'] is None and not store.for_song('song')
    lib.activate_run('song',partial)
    assert store.for_song('song')

def test_snapshot_does_not_hold_library_lock_while_waiting_for_engine(tmp_path):
    import threading
    app=Application(tmp_path);seed(app.library);run=ingest(app.documents)
    acquired=threading.Event()
    def snapshot():
        def completion_library_access():
            with app.library.lock:
                acquired.set()
        callback=threading.Thread(target=completion_library_access)
        callback.start()
        assert acquired.wait(2),'Engine completion cannot acquire library lock while snapshot waits'
        callback.join(2)
        return None
    with patch.object(app.engine,'snapshot',side_effect=snapshot):
        assert app.activate_run('song',run)['active_run']==run
    app.close()


def test_cannot_activate_another_songs_registered_run(tmp_path):
    lib=Library(tmp_path);seed(lib);store=DocumentStore(lib);run=ingest(store)
    with lib.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',('other','Other','','other.mp3',20,'Other','imported',None,None,now()))
    with pytest.raises(ValueError):lib.activate_run('other',run)
    assert lib.song('other')['active_run'] is None
