import json
import urllib.error
from urllib.parse import quote
import pytest
from test_server import service,request

MIDI=b'MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0MTrk\x00\x00\x00\x04\x00\xff\x2f\x00'
JSON={'Content-Type':'application/json'}

@pytest.fixture
def song(service,mp3_bytes):
    return json.load(request(service,'/api/import?filename=Midi.mp3',mp3_bytes))['id']

def upload(service,song,name='part.mid',data=MIDI,extra=''):
    return json.load(request(service,f'/api/user-midi/upload?song={song}&name={quote(name)}{extra}',data))

def post(service,path,body):
    return json.load(request(service,path,json.dumps(body).encode(),JSON))

def code(service,path,data=None,headers=None):
    with pytest.raises(urllib.error.HTTPError) as exc:request(service,path,data,headers)
    return exc.value.code

def test_upload_list_and_read_back(service,song):
    assert json.load(request(service,'/api/user-midi/'+song))=={'files':[]}
    entry=upload(service,song,'C:\\music\\Lead line.mid')
    assert entry['name']=='Lead line.mid' and entry['size']==len(MIDI) and entry['settings']=={} and len(entry['id'])==12
    files=json.load(request(service,'/api/user-midi/'+song))['files']
    assert [f['id'] for f in files]==[entry['id']] and isinstance(files[0]['mtime'],float)
    with request(service,f"/api/user-midi/{song}/{entry['id']}") as response:
        assert response.headers['Content-Type']=='audio/midi' and response.read()==MIDI

def test_bad_files_are_rejected(service,song):
    assert code(service,f'/api/user-midi/upload?song={song}&name=a.mid',b'not midi at all, sorry')==400
    assert code(service,f'/api/user-midi/upload?song={song}&name=a.txt',MIDI)==400
    assert code(service,f'/api/user-midi/upload?song={song}&name=a.mid',b'MThd')==400
    assert json.load(request(service,'/api/user-midi/'+song))['files']==[]

def test_unknown_ids_songs_and_traversal_are_404(service,song):
    upload(service,song)
    for bad in ['0'*12,'..','%2e%2e','..%2fx','../x','ABCDEF123456']:
        assert code(service,f'/api/user-midi/{song}/{bad}')==404,bad
    assert code(service,'/api/user-midi/nosuchsong')==404
    assert code(service,'/api/user-midi/nosuchsong/'+'0'*12)==404
    assert code(service,f'/api/user-midi/upload?song=nosuchsong&name=a.mid',MIDI)==404
    assert code(service,'/api/user-midi/rename',json.dumps({'song_id':song,'id':'../x','name':'n.mid'}).encode(),JSON)==404

def test_replace_keeps_id_and_settings(service,song):
    entry=upload(service,song,'old.mid')
    post(service,'/api/user-midi/settings',{'song_id':song,'id':entry['id'],'settings':{'offset':1.5}})
    newer=MIDI+b'\x00'
    again=upload(service,song,'new.mid',newer,'&replace='+entry['id'])
    assert again['id']==entry['id'] and again['name']=='new.mid' and again['settings']=={'offset':1.5} and again['size']==len(newer)
    assert len(json.load(request(service,'/api/user-midi/'+song))['files'])==1
    assert request(service,f"/api/user-midi/{song}/{entry['id']}").read()==newer
    other=upload(service,song,'x.mid',MIDI,'&replace=000000000000')   # an unknown id just makes a new entry
    assert other['id']!=entry['id'] and other['settings']=={}

def test_settings_and_rename(service,song):
    entry=upload(service,song)
    saved=post(service,'/api/user-midi/settings',{'song_id':song,'id':entry['id'],'settings':{'replaces':['bass']}})
    assert saved['settings']=={'replaces':['bass']}
    assert json.load(request(service,'/api/user-midi/'+song))['files'][0]['settings']=={'replaces':['bass']}
    for settings in ['text',{'big':'x'*(256*1024)}]:
        assert code(service,'/api/user-midi/settings',json.dumps({'song_id':song,'id':entry['id'],'settings':settings}).encode(),JSON)==400
    assert post(service,'/api/user-midi/rename',{'song_id':song,'id':entry['id'],'name':'Bass take 2.mid'})['name']=='Bass take 2.mid'
    assert code(service,'/api/user-midi/rename',json.dumps({'song_id':song,'id':entry['id'],'name':'  '}).encode(),JSON)==400

def test_remove_moves_the_file_aside(service,song):
    entry=upload(service,song)
    assert post(service,'/api/user-midi/remove',{'song_id':song,'id':entry['id']})=={'ok':True}
    assert json.load(request(service,'/api/user-midi/'+song))['files']==[]
    assert code(service,f"/api/user-midi/{song}/{entry['id']}")==404
    gone=service.app.library.folder(song)/'my-midi'/'removed'
    assert [p.read_bytes() for p in gone.glob('*.mid')]==[MIDI]
    assert json.loads(next(gone.glob('*.json')).read_text())['id']==entry['id']
    assert not (gone.parent/(entry['id']+'.mid')).exists()

def test_unique_names_never_collide(service,song):
    names=[upload(service,song,'Custom MIDI',MIDI,'&unique=1')['name'] for _ in range(3)]
    assert names==['Custom MIDI.mid','Custom MIDI 2.mid','Custom MIDI 3.mid']

def test_requests_need_the_token(service,song):
    entry=upload(service,song)
    no={'X-ChordBuddy-Token':''}
    for path,data in [('/api/user-midi/'+song,None),(f"/api/user-midi/{song}/{entry['id']}",None),(f'/api/user-midi/upload?song={song}&name=a.mid',MIDI),
                      ('/api/user-midi/remove',b'{}')]:
        assert code(service,path,data,no)==403

def test_open_and_folder_use_the_stored_file(service,song,monkeypatch,tmp_path):
    entry=upload(service,song)
    opened=[]
    monkeypatch.setattr('os.startfile',lambda p:opened.append(p),raising=False)
    monkeypatch.setattr('chordbuddy.server.os.name','nt')
    stored=service.app.user_midi.path(song,entry['id'])
    assert stored.is_relative_to(service.app.library.folder(song)) and stored.read_bytes()==MIDI
    result=post(service,'/api/user-midi/open',{'song_id':song,'id':entry['id']})
    assert result['opened'] and result['path']==str(stored) and opened==[str(stored)] and 'same file' in result['message']
    folder=post(service,'/api/user-midi/folder',{'song_id':song})
    assert folder['ok'] and opened[-1]==folder['path'] and folder['path'].endswith('my-midi')
    assert code(service,'/api/user-midi/open',json.dumps({'song_id':song,'id':'0'*12}).encode(),JSON)==404

def test_stored_files_have_readable_names_and_old_id_only_files_still_work(service,song):
    entry=upload(service,song,'Real Thing: bass?.MIDI')
    folder=service.app.user_midi.folder_path(song)
    assert (folder/f"Real Thing bass ({entry['id']}).mid").read_bytes()==MIDI,'easy to find and export back over from a DAW'
    # a file from before readable names, and an index entry whose file name tries to leave the folder: both use the id
    index=json.loads((folder/'index.json').read_text('utf-8'))
    old=dict(index['files'][0],id='0123456789ab');old.pop('file')
    bad=dict(index['files'][0],id='ba0123456789',file='..\..\evil (ba0123456789).mid')
    index['files']+= [old,bad];(folder/'index.json').write_text(json.dumps(index),'utf-8')
    (folder/'0123456789ab.mid').write_bytes(MIDI);(folder/'ba0123456789.mid').write_bytes(MIDI)
    assert {f['id'] for f in json.load(request(service,'/api/user-midi/'+song))['files']}=={entry['id'],'0123456789ab','ba0123456789'}
    assert service.app.user_midi.path(song,'ba0123456789')==folder/'ba0123456789.mid'
