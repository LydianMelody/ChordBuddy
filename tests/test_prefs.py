import json
import urllib.error
import pytest
from test_server import service,request

def post(service,path,payload):
    return request(service,path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})

def test_preferences_are_saved_with_the_library_and_validated(service):
    assert json.load(request(service,'/api/prefs'))=={}
    result=json.load(post(service,'/api/prefs',{'cb-theme':'forest','cb-key:abc123':'A minor'}))
    assert result=={'cb-theme':'forest','cb-key:abc123':'A minor'}
    post(service,'/api/prefs',{'cb-theme':'plum'})
    assert json.load(request(service,'/api/prefs'))['cb-theme']=='plum'
    assert service.app.library.read_settings()['device']=='auto'            # ordinary settings are untouched
    for bad in ({'theme':'x'},{'cb-theme':5},{'cb-'+'x'*90:'y'},{'cb-ok':'y'*300},['not','a','dict']):
        with pytest.raises(urllib.error.HTTPError) as err:post(service,'/api/prefs',bad)
        assert err.value.code==400
