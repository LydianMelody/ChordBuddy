import json
import urllib.error
import pytest
from test_server import service,request
from test_separation_store import seed
from chordbuddy.separation_audio import write_float,validate_mix
from chordbuddy.separation_contract import TRACKS,file_hash,recipe_digest

def publish(app):
    lib=app.library
    app.separation.recipe_factory=lambda:{}
    recipe=recipe_digest({})
    with lib.transaction() as db:db.execute("INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)",('s','Song','','source.mp3',1,'s','imported',None,None,'now'))
    folder=lib.root/'s';folder.mkdir();(folder/'source.mp3').write_bytes(b'mp3')
    store=app.separation_store
    run=store.create_run('s',recipe);root=store.safe_path(run['folder'])
    for role in TRACKS:write_float(root/(role+'.wav'),[.1,-.1]*8)
    write_float(root/'guitar.wav',[.2,-.2]*8)
    manifest=validate_mix(root);manifest.update(source_sha256=file_hash(folder/'source.mp3'),recipe_sha256=recipe,recipe={})
    store.update_progress(run['id'],'validating');store.activate_validated(run['id'],manifest)
    return run['id']

def test_pcm_api_bounded_authenticated_and_no_paths(service):
    run_id=publish(service.app)
    state=json.load(request(service,'/api/separation/s'))
    assert state['availability']=='ready' and 'relative_path' not in json.dumps(state)
    response=request(service,f'/api/separation-audio/{run_id}?start_frame=6&frame_count=4')
    assert response.headers['X-Stem-Frame-Count']=='2'
    assert len(response.read())==2*8*2*4
    for query in ('start_frame=-1&frame_count=1','start_frame=0&frame_count=999999','start_frame=8&frame_count=1'):
        with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/separation-audio/{run_id}?{query}')
        assert err.value.code in (400,416)
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/separation-audio/{run_id}?start_frame=0&frame_count=1',headers={'X-ChordBuddy-Token':'bad'})
    assert err.value.code==403

def test_mutated_source_rejects_cached_audio(service):
    run_id=publish(service.app)
    service.app.library.source_path('s').write_bytes(b'changed')
    assert json.load(request(service,'/api/separation/s'))['availability']=='stale'
    with pytest.raises(urllib.error.HTTPError):request(service,f'/api/separation-audio/{run_id}?start_frame=0&frame_count=1')


def test_publication_does_not_require_directory_rename(service,monkeypatch):
    from pathlib import Path
    def locked(*args,**kwargs):raise PermissionError('Directory held by external reader')
    monkeypatch.setattr(Path,'rename',locked)
    run_id=publish(service.app)
    assert json.load(request(service,'/api/separation/s'))['active']['run_id']==run_id

def test_failed_rerun_and_corrupt_asset_preserve_original(service):
    run_id=publish(service.app)
    store=service.app.separation_store
    failed=store.create_run('s','recipe')
    store.fail_run(failed['id'],'failed','Fixture model failure')
    assert store.get_song_state('s')['active']['run_id']==run_id
    assert service.app.library.source_path('s').read_bytes()==b'mp3'
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f"/api/separation-audio/{failed['id']}?start_frame=0&frame_count=1")
    assert err.value.code==404
    root,manifest=store.get_published_run(run_id)
    (root/'bass.wav').write_bytes(b'corrupt')
    assert store.get_song_state('s')['availability']=='stale'
    with pytest.raises(urllib.error.HTTPError):request(service,f'/api/separation-audio/{run_id}?start_frame=0&frame_count=1')

def test_global_job_panel_tracks_latest_completed_kind(service,monkeypatch):
    monkeypatch.setattr(service.app.engine,'snapshot',lambda:{'status':'completed','song_id':'s','kind':'transcription'})
    monkeypatch.setattr(service.app.separation,'snapshot',lambda:{'status':'completed','song_id':'s','kind':'separation'})
    service.app._last_job_kind='transcription'
    assert service.app.state()['job']['kind']=='transcription'

def test_inference_gate_blocks_separation_without_creating_run(service):
    publish(service.app)
    owner=service.app.inference_gate.try_acquire('transcription','s','test')
    try:
        before=service.app.library.db.execute('SELECT count(*) FROM separation_runs').fetchone()[0]
        with pytest.raises(urllib.error.HTTPError) as error:request(service,'/api/separate',json.dumps({'song_id':'s'}).encode())
        assert error.value.code==409
        assert service.app.library.db.execute('SELECT count(*) FROM separation_runs').fetchone()[0]==before
    finally:service.app.inference_gate.release(owner)
