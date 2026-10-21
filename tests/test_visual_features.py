import base64
import json
import urllib.error
import numpy as np
import pytest
from test_server import service,request
from test_separation_api import publish
from chordbuddy import visual_features as vf
from chordbuddy.separation_contract import SAMPLE_RATE

def decode(text):
    return np.frombuffer(base64.b64decode(text),dtype=np.uint8)

def seconds(n):
    return np.arange(int(n*SAMPLE_RATE))/SAMPLE_RATE

def test_a_tone_is_loud_in_its_own_band_and_silence_is_empty():
    tone=(.5*np.sin(2*np.pi*440*seconds(2))).astype(np.float32)
    values,frames=vf.stem_features(np.concatenate([tone,np.zeros(SAMPLE_RATE,np.float32)]))
    assert frames==300
    level=decode(values['level']);bands=decode(values['bands']).reshape(frames,8)
    # a 0.5 sine is about -9 dBFS: 255*(60-9)/60
    assert abs(int(level[100])-217)<=3 and level[250]==0
    assert bands[100].argmax()==3                                   # 400-900 Hz
    assert bands[250].max()==0
    assert abs(values['peak_db']+9)<.5

def test_hits_are_found_where_a_drum_would_hit():
    t=seconds(3);clicks=np.zeros(len(t),np.float32)
    for at in (.5,1,1.5,2,2.5):
        start=int(at*SAMPLE_RATE);clicks[start:start+400]=np.random.default_rng(int(at*10)).uniform(-.8,.8,400)*np.exp(-np.arange(400)/80)
    values,_=vf.stem_features(clicks)
    times=[hit[0] for hit in values['hits']]
    assert len(times)==5 and all(abs(a-b)<=.02 for a,b in zip(times,(.5,1,1.5,2,2.5)))
    assert all(0<hit[1]<=1 for hit in values['hits'])

def test_features_are_saved_once_and_redone_when_the_audio_changes(service,monkeypatch):
    run_id=publish(service.app)
    root,manifest=service.app.separation_store.get_published_run(run_id)
    first=vf.load_or_compute(root,manifest)
    assert set(first['tracks'])=={a['role'] for a in manifest['assets']} and first['fps']==100 and (root/vf.CACHE_NAME).is_file()
    monkeypatch.setattr(vf,'compute',lambda *a:pytest.fail('should use the saved features'))
    assert vf.load_or_compute(root,manifest)==first
    changed=dict(manifest,assets=[dict(a,file_sha256='0'*64) if a['role']=='drums' else a for a in manifest['assets']])
    monkeypatch.setattr(vf,'compute',lambda r,m:{'version':vf.VERSION,'source':{a['role']:a['file_sha256'] for a in m['assets']},'redone':True})
    assert vf.load_or_compute(root,changed)['redone']

def test_route_serves_features_with_the_token_only(service):
    run_id=publish(service.app)
    body=json.load(request(service,f'/api/visual-features/{run_id}'))
    assert body['run_id']==run_id and 'vocals' in body['tracks'] and 'relative_path' not in json.dumps(body)
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/visual-features/{run_id}',headers={'X-ChordBuddy-Token':'bad'})
    assert err.value.code==403
    with pytest.raises(urllib.error.HTTPError) as err:request(service,'/api/visual-features/nope')
    assert err.value.code in (400,404)
