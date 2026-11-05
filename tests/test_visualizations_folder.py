import json
import urllib.error
import pytest
from pathlib import Path
from test_server import service,request

def test_the_visualizations_folder_is_listed_without_templates(service):
    body=json.load(request(service,'/visualizations/index.json',headers={'X-ChordBuddy-Token':''}))   # a page file, no token needed
    folder=Path(__file__).resolve().parents[1]/'chordbuddy'/'web'/'visualizations'
    on_disk={p.name for p in folder.glob('*.js') if not p.name.startswith('_')}   # whatever is in the folder today: files come and go
    assert set(body['files'])==on_disk and set(body['versions'])==on_disk
    assert not any(name.startswith('_') for name in body['files'])
    assert all(name.endswith('.js') for name in body['files'])

def test_my_visuals_are_listed_and_served_from_their_own_folder_only(service,tmp_path):
    mine=tmp_path/'My Visuals';mine.mkdir();service.app.my_visuals=mine
    (mine/'glow.js').write_text('export default {}');(mine/'_draft.js').write_text('');(mine/'notes.txt').write_text('hi')
    (mine/'pics').mkdir();(mine/'pics'/'star.png').write_bytes(b'png')
    (tmp_path/'secret.txt').write_text('no')
    body=json.load(request(service,'/visualizations/index.json',headers={'X-ChordBuddy-Token':''}))
    assert body['mine']==['glow.js'] and set(body['mine_versions'])=={'glow.js'}
    assert request(service,'/my-visuals/glow.js').read()==b'export default {}'
    assert request(service,'/my-visuals/pics/star.png').read()==b'png','a picture a visual uses'
    for path in ['/my-visuals/../secret.txt','/my-visuals/%2e%2e/secret.txt','/my-visuals/missing.js']:
        with pytest.raises(urllib.error.HTTPError):request(service,path)

def test_without_a_my_visuals_folder_the_list_is_just_empty(service,tmp_path):
    service.app.my_visuals=tmp_path/'nowhere'
    body=json.load(request(service,'/visualizations/index.json',headers={'X-ChordBuddy-Token':''}))
    assert body['mine']==[] and body['files']
