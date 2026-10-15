import json
import os
import pytest
from pathlib import Path
from test_server import service, request
from test_separation_api import publish
from chordbuddy.separation import SeparationManager
from chordbuddy.separation_audio import write_float, validate_mix
from chordbuddy.separation_contract import TRACKS, file_hash, recipe_digest
from chordbuddy.documents import RevisionConflict


def candidate(app):
    store=app.separation_store
    run=store.create_run('s','recipe');root=store.safe_path(run['folder'])
    for role in TRACKS:write_float(root/(role+'.wav'),[.1,-.1]*8)
    write_float(root/'guitar.wav',[.2,-.2]*8)
    manifest=validate_mix(root);manifest.update(source_sha256=file_hash(app.library.source_path('s')),recipe_sha256='recipe',recipe={})
    store.update_progress(run['id'],'validating')
    return run,root,manifest


def test_r1_final_read_failure_preserves_old_active(service,monkeypatch):
    app=service.app;old=publish(app);run,root,manifest=candidate(app)
    original=Path.read_text
    def read(path,*args,**kwargs):
        if path==root/'manifest.json':raise PermissionError('Injected final manifest read failure')
        return original(path,*args,**kwargs)
    monkeypatch.setattr(Path,'read_text',read)
    app.separation.pipeline=lambda manager,attempt:manager.store.activate_validated(run['id'],manifest)
    app.separation.recipe_factory=lambda:{}
    owner=app.inference_gate.try_acquire('separation','s',run['id'])
    app.separation._run(run,'cpu',owner,True)
    assert app.separation_store._run(run['id'])['status']=='failed'
    assert app.library.db.execute('SELECT active_id FROM song_separations WHERE song_id=?',('s',)).fetchone()[0]==old
    assert app.separation_store.get_song_state('s')['active']['run_id']==old


def test_r1_completed_publication_cannot_be_demoted(service):
    old=publish(service.app)
    service.app.separation_store.fail_run(old,'failed','Late response failure')
    assert service.app.separation_store._run(old)['status']=='completed'


def mutate_preserving_stat(path):
    before=path.stat();path.write_bytes(b'xyz');os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))


def test_r4_new_selection_rehashes_same_stat_source(service):
    publish(service.app);mutate_preserving_stat(service.app.library.source_path('s'))
    assert service.app.separation_store.get_song_state('s')['availability']=='stale'


def test_r4_cache_reuse_compares_fresh_source_identity(service,monkeypatch):
    app=service.app;old=publish(app);mutate_preserving_stat(app.library.source_path('s'))
    manager=app.separation;run=manager.store.create_run('s','recipe')
    run.update(recipe_sha256='recipe',recipe={},rerun=False,device='cpu')
    # Simulate a cached selection response: the pipeline itself must reject the mismatch.
    monkeypatch.setattr(manager.store,'get_song_state',lambda _: {'active':{'run_id':old,'recipe_sha256':'recipe'}})
    monkeypatch.setattr(manager,'_process',lambda *args: (_ for _ in ()).throw(RuntimeError('Reached fresh decoding')))
    with pytest.raises(RuntimeError,match='Reached fresh decoding'):manager._pipeline(run)


def test_r5_current_recipe_controls_fresh_selection_but_not_pinned_stream(service):
    app=service.app;old=publish(app)
    app.separation.recipe_factory=lambda:{'version':'changed'}
    assert json.load(request(service,'/api/separation/s'))['availability']=='stale'
    # A historical validated run remains readable by the already-pinned session.
    response=request(service,f'/api/separation-audio/{old}?start_frame=0&frame_count=1')
    assert len(response.read())==64


def test_r6_ingestion_failure_retains_gate_and_prevents_new_attempts(service,monkeypatch):
    app=service.app;publish(app)
    app._transcription_owner=app.inference_gate.try_acquire('transcription','s','old')
    monkeypatch.setattr(app.documents,'ingest',lambda *args:(_ for _ in ()).throw(OSError('database is full')))
    monkeypatch.setattr(app.engine,'readiness',lambda:{'ready':True})
    with pytest.raises(Exception,match='database is full'):app._ingest_transcription('s',Path('old'),'completed',None)
    assert app.inference_gate.owner is not None
    before=app.library.db.execute('SELECT count(*) FROM runs').fetchone()[0]
    with pytest.raises(RevisionConflict):app.transcribe('s')
    with pytest.raises(RevisionConflict):app.separate('s')
    assert app.library.db.execute('SELECT count(*) FROM runs').fetchone()[0]==before
    assert 'restart' in app.state()['job']['message'].lower()

def test_r6_options_write_and_terminal_save_failure_retains_gate(service,monkeypatch):
    app=service.app;publish(app)
    monkeypatch.setattr(app.engine,'readiness',lambda:{'ready':True})
    original=Path.write_text
    def write(path,*args,**kwargs):
        if path.name=='run-options.json':raise OSError('options disk full')
        return original(path,*args,**kwargs)
    monkeypatch.setattr(Path,'write_text',write)
    monkeypatch.setattr(app.library,'finish_run',lambda *args:(_ for _ in ()).throw(OSError('terminal database full')))
    with pytest.raises(OSError,match='terminal database full'):app.transcribe('s')
    assert app.inference_gate.owner is not None
    assert 'restart' in app.state()['job']['message'].lower()

def test_r5_installed_recipe_cache_refreshes_when_configuration_changes(tmp_path,monkeypatch):
    import chordbuddy.separation as module
    from chordbuddy.inference_jobs import InferenceGate
    from test_separation_store import seed
    lib,store=seed(tmp_path/'library')
    project=tmp_path/'project';model=project/'fixture'
    files=[project/'tools/ffmpeg.exe']+[project/'chordbuddy'/name for name in ('separation_worker.py','separation_recipe.py','separation_audio.py')]
    files += [project/'.models/separation/runtime/python.exe',model/'weights/weights.ckpt',model/'evidence/config.yaml',model/'evidence/upstream-commit.txt',model/'source/models/bs_roformer/model.py']
    for p in files:p.parent.mkdir(parents=True,exist_ok=True);p.write_text('first')
    calls=[]
    monkeypatch.setattr(module,'MODELS',{'base':('fixture','weights.ckpt','config.yaml','hash')})
    monkeypatch.setattr(module,'model_root',lambda *args:model)
    def build(project):calls.append(True);return {'config':(model/'evidence/config.yaml').read_text()}
    monkeypatch.setattr(module,'build_recipe',build)
    manager=SeparationManager(project,store,InferenceGate())
    first=manager.current_recipe_digest();assert manager.current_recipe_digest()==first and len(calls)==1
    (model/'evidence/config.yaml').write_text('changed configuration')
    assert manager.current_recipe_digest()!=first and len(calls)==2
    lib.close()
