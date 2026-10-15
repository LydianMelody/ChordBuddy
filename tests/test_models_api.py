import json
import urllib.error
import pytest
from test_server import service,request

def post(service,path,payload=None,data=None,headers=None):
    h={'Content-Type':'application/json'} if data is None else {'Content-Type':'application/octet-stream'}
    h.update(headers or {})
    return request(service,path,data=data if data is not None else json.dumps(payload or {}).encode(),headers=h)

def test_model_status_is_in_the_app_state_and_has_its_own_route(service):
    state=json.load(request(service,'/api/state'))
    assert set(state['models'])>={'ready','active','models','bytes_missing'}
    assert [m['id'] for m in state['models']['models']]==['base','guitar']
    assert json.load(request(service,'/api/models'))['models'][0]['title']

def test_analysis_waits_for_the_models(service,monkeypatch):
    monkeypatch.setattr(service.app.models,'ready',lambda:False)
    with pytest.raises(urllib.error.HTTPError) as err:post(service,'/api/songs/abc/analyze',{})
    assert err.value.code==400 and 'Download models' in json.load(err.value)['error']

def test_a_wrong_model_file_is_refused_and_leaves_nothing_behind(service,tmp_path,monkeypatch):
    monkeypatch.setattr('chordbuddy.server.PROJECT',tmp_path)
    with pytest.raises(urllib.error.HTTPError) as err:post(service,'/api/models/import?name=junk.ckpt',data=b'not a model')
    assert err.value.code==400
    assert not list((tmp_path/'.models'/'uploads').glob('*'))
    with pytest.raises(urllib.error.HTTPError) as err:post(service,'/api/models/import?name=x',data=b'')
    assert err.value.code==400

def test_model_routes_need_the_token(service):
    with pytest.raises(urllib.error.HTTPError) as err:request(service,'/api/models',headers={'X-ChordBuddy-Token':'bad'})
    assert err.value.code==403
    with pytest.raises(urllib.error.HTTPError) as err:post(service,'/api/models/download',{},headers={'X-ChordBuddy-Token':'bad'})
    assert err.value.code==403
