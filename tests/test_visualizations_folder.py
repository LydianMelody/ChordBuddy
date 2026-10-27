import json
from pathlib import Path
from test_server import service,request

def test_the_visualizations_folder_is_listed_without_templates(service):
    body=json.load(request(service,'/visualizations/index.json',headers={'X-ChordBuddy-Token':''}))   # a page file, no token needed
    folder=Path(__file__).resolve().parents[1]/'chordbuddy'/'web'/'visualizations'
    on_disk={p.name for p in folder.glob('*.js') if not p.name.startswith('_')}   # whatever is in the folder today: files come and go
    assert set(body['files'])==on_disk and set(body['versions'])==on_disk
    assert not any(name.startswith('_') for name in body['files'])
    assert all(name.endswith('.js') for name in body['files'])
