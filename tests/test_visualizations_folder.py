import json
from test_server import service,request

def test_the_visualizations_folder_is_listed_without_templates(service):
    body=json.load(request(service,'/visualizations/index.json',headers={'X-ChordBuddy-Token':''}))   # a page file, no token needed
    assert {'cozy.js','runner.js','abstract.js','diagnostic.js'}<=set(body['files'])
    assert not any(name.startswith('_') for name in body['files'])
    assert all(name.endswith('.js') for name in body['files'])
