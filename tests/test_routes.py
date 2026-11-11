"""What every address of the local server answers, written down so a change to how requests are routed can't quietly change it.

Two passes over every route in chordbuddy/server.py:
  REAL   the real app with a fresh library: harmless requests (unknown ids, empty bodies, wrong types) and what comes back
         (status, headers that matter, the error message or the names in the answer).
  WIRED  the app's services swapped for stand-ins that only write down how they were called: full, valid-looking requests,
         and exactly which service got which arguments. Nothing heavy can start, so every route can be asked properly.

The expected answers at the bottom were recorded from the server as it was before the route tables. To record them again
(only when a route is changed on purpose): set CB_ROUTES_RECORD to a file name, run this test, and paste that file's two lists in.
"""
import http.client
import json
import os
from pathlib import Path
import re
import threading
import webbrowser

import pytest
from unittest.mock import patch

from chordbuddy import server as server_module
from chordbuddy import update_check
from chordbuddy.server import make_server


# every POST route that takes a JSON object, and the fields it reads ('?' marks one that may be left out)
JSON_POSTS=[
    ('/api/visual-relay/send',['messages?']),
    ('/api/documents/d1/timing',['timing','revision']),
    ('/api/documents/d1/cleanup/preview',[]),
    ('/api/documents/d1/cleanup/apply',['preview','revision']),
    ('/api/documents/d1/rhythm/propose',[]),
    ('/api/documents/d1/rhythm/preview',['proposal_id','policy']),
    ('/api/documents/d1/rhythm/apply',['preview_id','stamp','policy']),
    ('/api/songs/s1/analyze',['invalidate?','stems?','edit_policy?']),
    ('/api/analysis/a1/cancel',[]),
    ('/api/separate',['song_id','rerun?']),
    ('/api/separation/cancel',['job_id']),
    ('/api/song',['id','title','artist?']),
    ('/api/song/trash',['id']),
    ('/api/song/restore',['id']),
    ('/api/song/purge',['id']),
    ('/api/song-export/info',['song_id']),
    ('/api/song-import/apply',['token','mode?','analysis?','stems?','setlist?','target?']),
    ('/api/song-import/cancel',['token']),
    ('/api/setlist',['name']),
    ('/api/setlist/rename',['id','name']),
    ('/api/setlist/delete',['id']),
    ('/api/setlist/order',['id','song_ids']),
    ('/api/setlist/add',['id','song_id']),
    ('/api/setlist/remove',['id','song_id']),
    ('/api/prefs',['anything?']),
    ('/api/models/download',[]),
    ('/api/models/cancel',[]),
    ('/api/chord-model/download',[]),
    ('/api/chord-model/cancel',[]),
    ('/api/settings',['device?']),
    ('/api/song-metadata',['song_id?','id?','metadata?','timing?','chord_overrides?','revision?']),
    ('/api/confirm-chord',['song_id?','id?','start?','end?','label?','revision?']),
    ('/api/start-chord-at-measure',['song_id','chord_id','measure_id','revision?','document_id?']),
    ('/api/transcribe',['song_id','edit_policy?']),
    ('/api/activate-run',['song_id','run_id']),
    ('/api/cancel',[]),
    ('/api/lead-sheet/external',['song_id','filename?','xml?']),
    ('/api/midi/external',['song_id','document_id']),
    ('/api/open-folder',['song_id']),
    ('/api/update-page',[]),
    ('/api/monitor/schedule',['events']),
    ('/api/monitor/cancel',['from?']),
    ('/api/monitor/gains',['click?','cue?']),
    ('/api/monitor/load',['song_id']),
    ('/api/cue-track/remove',['song_id']),
    ('/api/midi/connect',['name','output?','input?']),
    ('/api/midi/disconnect',['name']),
    ('/api/midi/schedule',['device','events','generation?']),
    ('/api/midi/cancel',['device?','from?','generation?']),
    ('/api/midi/cleanup',['device?']),
    ('/api/power/acquire',['holder']),
    ('/api/power/release',['holder']),
    ('/api/performance/save',['body','base']),
    ('/api/performance/draft',['body','base']),
    ('/api/performance/delete',['id']),
    ('/api/show/save',['body','base']),
    ('/api/show/draft',['body','base']),
    ('/api/show/import',['bundle']),
    ('/api/show/delete',['id']),
    ('/api/visual-patches',['visual','patch?','song_id?']),
    ('/api/user-midi/settings',['song_id','id','settings']),
    ('/api/user-midi/rename',['song_id','id','name']),
    ('/api/user-midi/remove',['song_id','id']),
    ('/api/user-midi/open',['song_id','id']),
    ('/api/user-midi/folder',['song_id']),
    ('/api/document/d1',['content','label?','revision']),
    ('/api/document/d1/export',['revision']),
    ('/api/document/d1/undo',['revision','position?']),
    ('/api/document/d1/undo/more',[]),
    ('/api/document/',['content','revision']),
    ('/api/nothing-here',[]),
    ('/api/documents/d1/timing/more',[]),
    ('/nothing-here',[]),
]

# GET requests against the real app. {song} is a song imported for the test, {token} the session token.
REAL_GETS=[
    '/api/visual-relay/address','/api/visual-relay/player','/visual-stream','/visual-stream?key=wrong','/visual-stream?key={key}','/api/update-check','/api/monitor/status',
    '/api/cue-track/{song}','/api/cue-track/nope','/api/cue-track/',
    '/api/midi/ports','/api/midi/status','/api/midi/log','/api/midi/events','/api/midi/events?after=x','/api/midi/events?after=2&wait=nan','/api/midi/events?wait=x',
    '/api/power','/api/shows','/api/performances/{song}','/api/performances/nope',
    '/api/show/nope/export','/api/show/nope/export/more','/api/performance/nope','/api/performance/nope?revision=x','/api/performance/nope?revision=2',
    '/api/show/nope','/api/show/nope?revision=x','/api/show/nope?revision=2',
    '/api/visual-patches','/api/visual-patches/{song}','/api/visual-patches/nope','/api/visual-patches/',
    '/api/user-midi/{song}','/api/user-midi/nope','/api/user-midi/','/api/user-midi/{song}/nofile','/api/user-midi/{song}/','/api/user-midi/a/b/c',
    '/api/documents/nope/rhythm/proposals/nope','/api/documents/nope/rhythm/proposals/',
    '/api/waveform/nope','/api/mix-export/nope','/api/mix-export/nope?levels=bad','/api/mix-export/nope?master=nan','/api/stems-export/nope',
    '/api/song-export/nope','/api/song-export/{song}','/api/song-export/{song}?stems=1',
    '/api/separation-audio/nope','/api/separation-audio/nope?start_frame=0&frame_count=10','/api/separation-audio/nope?start_frame=x&frame_count=1',
    '/api/separation-audio/nope?start_frame=0&frame_count=1&more=1','/api/separation-audio/nope?start_frame=0&start_frame=1&frame_count=1',
    '/api/visual-features/nope','/api/playback/{song}','/api/playback/nope','/api/separation/{song}','/api/separation/nope','/api/separation/cancel',
    '/api/prefs','/api/models','/api/chord-model','/api/state','/api/song/{song}','/api/song/nope','/api/document/nope','/api/document/a/b',
    '/api/audio/{song}','/api/audio/nope','/api/audio/{song}?token={token}',
    '/api/export/nope','/api/export-midi/nope','/api/export-midi/nope?mode=tracks','/api/export-outputs/nope',
    '/api/nope','/api/','/api','/api/state/more','/api/shows/','/api/prefs?x=1',
    '/','/index.html','/nope.html','/visualizations/index.json','/my-visuals/nope.js','/my-visuals/','/web/../server.py',
]

# (label, method, path, body, headers): the requests that need something special. `token` False leaves the session token out.
REAL_SPECIAL=[
    ('audio range','GET','/api/audio/{song}',None,{'Range':'bytes=10-29'}),
    ('audio range past the end','GET','/api/audio/{song}',None,{'Range':'bytes=99999999-'}),
    ('audio range nonsense','GET','/api/audio/{song}',None,{'Range':'nonsense'}),
    ('audio last bytes','GET','/api/audio/{song}',None,{'Range':'bytes=-5'}),
    ('wrong token','GET','/api/state',None,{'X-ChordBuddy-Token':'wrong'}),
    ('no token','GET','/api/state',None,{'X-ChordBuddy-Token':''}),
    ('token in the address where that is not allowed','GET','/api/state?token={token}',None,{'X-ChordBuddy-Token':''}),
    ('token in the address of the audio','GET','/api/audio/{song}?token={token}',None,{'X-ChordBuddy-Token':''}),
    ('token in the address of an export','GET','/api/export/nope?token={token}',None,{'X-ChordBuddy-Token':''}),
    ('foreign origin','GET','/api/state',None,{'Origin':'https://example.com'}),
    ('wrong host','GET','/',None,{'Host':'example.com'}),
    ('static without a token','GET','/',None,{'X-ChordBuddy-Token':''}),
    ('post without a token','POST','/api/prefs',b'{}',{'X-ChordBuddy-Token':''}),
    ('model import, empty','POST','/api/models/import?name=x.ckpt',b'',{}),
    ('model import, size not a number','POST','/api/models/import?name=x.ckpt',None,{'Content-Length':'x'}),
    ('song import, empty','POST','/api/song-import',b'',{}),
    ('song import, size not a number','POST','/api/song-import',None,{'Content-Length':'x'}),
    ('song import, not a zip','POST','/api/song-import',b'not a zip',{}),
    ('import, not an mp3','POST','/api/import?filename=bad.mp3',b'bad',{}),
    ('import, empty','POST','/api/import?filename=bad.mp3',b'',{}),
    ('import, no name','POST','/api/import',b'bad',{}),
    ('import, unknown setlist','POST','/api/import?filename=bad.mp3&setlist=nope',b'bad',{}),
    ('cue track upload, unknown song','POST','/api/cue-track/upload?song=nope&name=a.wav',b'x',{}),
    ('cue track upload, not audio','POST','/api/cue-track/upload?song={song}&name=a.txt',b'x',{}),
    ('cue track upload, empty','POST','/api/cue-track/upload?song={song}&name=a.wav',b'',{}),
    ('midi upload, unknown song','POST','/api/user-midi/upload?song=nope&name=a.mid',b'x',{}),
    ('midi upload, not midi','POST','/api/user-midi/upload?song={song}&name=a.mid',b'x',{}),
    ('midi upload, unique, not midi','POST','/api/user-midi/upload?song={song}&unique=1',b'x',{}),
    ('midi upload, empty','POST','/api/user-midi/upload?song={song}&name=a.mid',b'',{}),
    ('json, a list','POST','/api/prefs',b'[]',{}),
    ('json, not json','POST','/api/prefs',b'nope',{}),
    ('json, empty','POST','/api/prefs',b'',{}),
    ('json, nan','POST','/api/monitor/gains',b'{"click":NaN}',{}),
    ('json, unknown address, empty','POST','/api/nothing-here',b'',{}),
    ('json, size not a number','POST','/api/prefs',None,{'Content-Length':'x'}),
    ('post to the event stream','POST','/visual-stream',b'{}',{}),
    ('post to a get route','POST','/api/state',b'{}',{}),
    ('settings, unknown device','POST','/api/settings',b'{"device":"magic"}',{}),
    ('settings, a list','POST','/api/settings',b'{"device":[1]}',{}),
    ('gains, a string','POST','/api/monitor/gains',b'{"click":"1"}',{}),
    ('gains, too loud','POST','/api/monitor/gains',b'{"cue":2}',{}),
    ('gains, fine','POST','/api/monitor/gains',b'{"click":0.5,"cue":1}',{}),
    ('monitor cancel, a string','POST','/api/monitor/cancel',b'{"from":"x"}',{}),
    ('midi schedule, events not a list','POST','/api/midi/schedule',b'{"device":"x","events":{}}',{}),
    ('midi schedule, device not a string','POST','/api/midi/schedule',b'{"device":1,"events":[]}',{}),
    ('midi schedule, a bad event','POST','/api/midi/schedule',b'{"device":"x","events":[{"at":"now","bytes":[144,60,100]}]}',{}),
    ('lead sheet, song of another kind','POST','/api/lead-sheet/external',b'{"song_id":"nope","xml":"<score-partwise/>"}',{}),
    ('lead sheet, entity','POST','/api/lead-sheet/external',b'{"song_id":"nope","xml":"<!ENTITY x>"}',{}),
    ('analyze, stems not yes or no','POST','/api/songs/nope/analyze',b'{"stems":"yes"}',{}),
    ('separate, rerun not yes or no','POST','/api/separate',b'{"song_id":"nope","rerun":1}',{}),
    ('transcribe, odd edit policy','POST','/api/transcribe',b'{"song_id":"{song}","edit_policy":"odd"}',{}),
    ('rename the song','POST','/api/song',b'{"id":"{song}","title":"New name","artist":"Someone"}',{}),
    ('rename the song, title a number','POST','/api/song',b'{"id":"{song}","title":5}',{}),
    ('song export sizes','POST','/api/song-export/info',b'{"song_id":"{song}"}',{}),
    ('a setlist','POST','/api/setlist',b'{"name":"Friday"}',{}),
    ('a setlist, no name','POST','/api/setlist',b'{"name":""}',{}),
    ('visual relay send','POST','/api/visual-relay/send',b'{"messages":[{"type":"x"}]}',{}),
    ('visual relay send, not a list','POST','/api/visual-relay/send',b'{"messages":"x"}',{}),
    ('trash then restore the song','POST','/api/song/trash',b'{"id":"{song}"}',{}),
    ('restore the song','POST','/api/song/restore',b'{"id":"{song}"}',{}),
]

# GET requests against the stand-ins
WIRED_GETS=[
    '/api/update-check','/api/monitor/status','/api/cue-track/s1','/api/cue-track/s1/more','/api/midi/ports','/api/midi/status',
    '/api/midi/events','/api/midi/events?after=7&wait=1.5','/api/power','/api/shows','/api/performances/s1',
    '/api/show/w1/export','/api/performance/p1','/api/performance/p1?revision=3','/api/show/w1','/api/show/w1?revision=4','/api/show/w1/more?revision=4',
    '/api/visual-patches','/api/visual-patches/s1','/api/user-midi/s1','/api/user-midi/s1/f1',
    '/api/documents/d1/rhythm/proposals/v1',
    '/api/playback/s1','/api/separation/s1','/api/prefs','/api/models','/api/chord-model','/api/state','/api/song/s1','/api/document/d1',
    '/api/export/d1','/api/export-midi/d1','/api/export-midi/d1?mode=tracks','/api/export-outputs/d1',
]
WIRED_UPLOADS=[
    ('/api/song-import',b'zipzip'),
    ('/api/import?filename=Song.mp3',b'audio'),('/api/import?filename=Song.mp3&setlist=l1',b'audio'),
    ('/api/cue-track/upload?song=s1&name=cue.wav',b'audio'),
    ('/api/user-midi/upload?song=s1&name=a.mid',b'midi'),('/api/user-midi/upload?song=s1&name=a.mid&replace=f1',b'midi'),
    ('/api/user-midi/upload?song=s1&unique=1',b'midi'),('/api/user-midi/upload?song=s1&name=a.mid&unique=1',b'midi'),
]


class Call:
    """A stand-in for one service or one of its methods: calling it writes the call down and answers with something fixed."""
    def __init__(self,name,log,answers):
        self._name,self._log,self._answers=name,log,answers

    def __getattr__(self,part):
        if part.startswith('__'):raise AttributeError(part)
        return Call(self._name+'.'+part,self._log,self._answers)

    def __call__(self,*args,**kwargs):
        self._log.append([self._name,plain(list(args)),plain(kwargs)])
        return self._answers.get(self._name,{'from':self._name})


def plain(value):
    # arguments as something that can be compared and written down
    if isinstance(value,Call):return '<'+value._name+'>'
    if isinstance(value,(bytes,bytearray)):return '<%d bytes>'%len(value)
    if isinstance(value,Path):return '<path>'
    if isinstance(value,dict):return {k:plain(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)):return [plain(v) for v in value]
    if callable(value):return '<callable>'
    return value


WIRED_ANSWERS={
    'library.song_metadata':{'timing':{'bpm':100},'chord_overrides':[{'id':'v-id','label':'old'},{'id':'other','label':'kept'}]},
    'library.folder':'F:/songs/s1',
    'user_midi.folder_path':'F:/songs/s1/my-midi',
    'user_midi.next_name':'Custom MIDI 2',
    'user_midi.read':b'MThd-fixture',
    'cue_tracks.get':{'version':'cue-v1','name':'cue.wav'},
    'cue_tracks.path':'F:/songs/s1/my-cues/cue.wav',
    'monitor.load_track':{'ready':True},
    'documents.get':{'id':'d1','run_id':'r1','from':'documents.get'},
    'documents.timing.version':{'transcription_id':'r1','source_sha256':'abc','from':'documents.timing.version'},
    'documents.revision_stamp':{'source_sha256':'abc'},
    'documents.export':(b'exported','Song chart.abc'),
    'documents.midi_download':(b'MThd-export','Song é.mid'),
    'documents.outputs_zip':(b'PK-zip','Song outputs.zip'),
    '_song_busy':False,
}
SERVICES=['library','documents','midi','monitor','power','performances','visual_patches','user_midi','cue_tracks','transfer','models','chord_model',
          'separation','analysis','engine','rhythm','playback','separation_store']
APP_METHODS=['analyze','separate','trash_song','purge_song','transcribe','activate_run','propose_rhythm','open_external_score','open_external_midi',
             'open_user_midi','state','playback_state','_song_busy']


@pytest.fixture
def service(tmp_path):
    server=make_server(tmp_path,port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join()


def ask(server,method,path,body=None,headers=None):
    """One request; returns (response, body bytes). An event stream is not read: it never ends."""
    connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=60)
    try:
        sent={'X-ChordBuddy-Token':server.app.token}
        sent.update(headers or {})
        if sent.get('X-ChordBuddy-Token')=='':del sent['X-ChordBuddy-Token']
        connection.request(method,path,body=body,headers=sent)
        response=connection.getresponse()
        stream=(response.getheader('Content-Type') or '').startswith('text/event-stream')
        return response,(b'' if stream else response.read())
    finally:
        connection.close()


KEPT_HEADERS=['Content-Disposition','Content-Range','Accept-Ranges','X-Stem-Run-Id','X-Stem-Start-Frame','X-Stem-Frame-Count','X-Stem-Sample-Rate']


def describe(response,body,full,clean):
    kind=response.getheader('Content-Type')
    out=[response.status,kind,response.getheader('Cache-Control'),response.getheader('Connection')]
    if kind and kind.startswith('application/json'):
        value=json.loads(body)
        if full:out.append(value)
        elif isinstance(value,dict) and set(value)=={'error'}:out.append(['error',value['error']])
        elif isinstance(value,dict):out.append(['keys',sorted(value)])
        elif isinstance(value,list):out.append(['list',len(value)])
        else:out.append(['value',value])
    elif full:out.append(body.decode('latin-1'))
    else:out.append(['bytes',None if kind in ('application/zip','text/html') else len(body)])        # a zip carries the time it was made; the page grows whenever the app's page is edited
    headers={name:response.getheader(name) for name in KEPT_HEADERS if response.getheader(name) is not None}
    if response.getheader('ETag') is not None:headers['ETag']=response.getheader('ETag') if full else 'yes'
    out.append(headers)
    return json.loads(clean(json.dumps(out)))


def check(name,actual,expected):
    record=os.environ.get('CB_ROUTES_RECORD')
    if record:
        with open(record,'a',encoding='utf-8') as out:
            out.write(name+'=[\n'+''.join('    '+repr(row)+',\n' for row in actual)+']\n')
        return
    assert len(actual)==len(expected)
    for got,want in zip(actual,expected):assert got==want


def test_what_every_route_answers(service,mp3_bytes,tmp_path):
    app=service.app
    opened=[]
    echo=lambda name:(lambda *args,**kwargs:{'stand-in':name,'args':plain(list(args)),'kwargs':plain(kwargs)})
    # Nothing here may reach the internet, a MIDI port, the sound card, the power settings, the browser or a real analysis.
    with patch.object(update_check,'check',echo('update_check.check')),patch.object(webbrowser,'open',lambda url:opened.append(url)), \
            patch.object(os,'startfile',lambda path:opened.append('startfile'),create=True), \
            patch.object(app.models,'start',echo('models.start')),patch.object(app.models,'ready',lambda:False), \
            patch.object(app.chord_model,'start',echo('chord_model.start')), \
            patch.object(app.engine,'readiness',lambda:{'ready':False,'message':'The engine is not ready (test).'}), \
            patch.object(app.midi,'ports',echo('midi.ports')),patch.object(app.midi,'connect',echo('midi.connect')), \
            patch.object(app.monitor,'status',echo('monitor.status')),patch.object(app.monitor,'schedule',echo('monitor.schedule')), \
            patch.object(app.monitor,'load_track',echo('monitor.load_track')), \
            patch.object(app.power,'acquire',echo('power.acquire')),patch.object(app.power,'release',echo('power.release')):
        response,body=ask(service,'POST','/api/import?filename=Test.mp3',mp3_bytes)
        song=json.loads(body)['id']
        key=server_module.stream_key(app.stream_key_path,True)
        fill=lambda text:text.replace('{song}',song).replace('{token}',app.token).replace('{key}',key)
        tmp=json.dumps(str(tmp_path))[1:-1]
        def clean(text):
            for old,new in ((song,'{song}'),(app.token,'{token}'),(key,'{key}'),(tmp,'{tmp}'),(str(service.server_port),'{port}')):text=text.replace(old,new)
            return re.sub(r'\b[0-9a-f]{32}\b','{id}',text)
        actual=[]
        def probe(label,method,path,body=None,headers=None):
            response,answer=ask(service,method,fill(path),body,headers)
            actual.append([label]+describe(response,answer,False,clean))
        for path in REAL_GETS:probe('GET '+path,'GET',path)
        for label,method,path,body,headers in REAL_SPECIAL:
            probe(label,method,path,fill(body.decode()).encode() if body else body,headers)
        for path,fields in JSON_POSTS:
            names=[f.rstrip('?') for f in fields]
            probe('POST '+path+' {}','POST',path,b'{}')
            if names:
                probe('POST '+path+' unknown','POST',path,json.dumps({f:'nope' for f in names}).encode())
                probe('POST '+path+' lists','POST',path,json.dumps({f:[1] for f in names}).encode())
                probe('POST '+path+' numbers','POST',path,json.dumps({f:7 for f in names}).encode())
    assert opened==[update_check.PAGE_URL]*sum(1 for row in actual if row[0].startswith('POST /api/update-page'))
    check('EXPECTED_REAL',actual,EXPECTED_REAL)


def test_which_service_every_route_calls(service):
    app=service.app
    log=[];opened=[]
    saved={name:app.__dict__.get(name,None) for name in SERVICES+APP_METHODS}
    had={name for name in SERVICES+APP_METHODS if name in app.__dict__}
    try:
        for name in SERVICES+APP_METHODS:setattr(app,name,Call(name,log,WIRED_ANSWERS))
        app.midi.__dict__['log']=['logged']                     # read as a plain list, not called
        with patch.object(update_check,'check',Call('update_check.check',log,WIRED_ANSWERS)),patch.object(webbrowser,'open',lambda url:opened.append(url)), \
                patch.object(os,'startfile',lambda path:log.append(['os.startfile',[path],{}]),create=True):
            actual=[]
            clean=lambda text:text.replace(str(service.server_port),'{port}')
            def probe(label,method,path,body=None):
                del log[:]
                response,answer=ask(service,method,path,body)
                actual.append([label]+describe(response,answer,True,clean)+[json.loads(json.dumps(log))])
            for path in WIRED_GETS:probe('GET '+path,'GET',path)
            probe('GET /api/midi/log','GET','/api/midi/log')
            for path,body in WIRED_UPLOADS:probe('POST '+path,'POST',path,body)
            for path,fields in JSON_POSTS:
                everything={f.rstrip('?'):'v-'+f.rstrip('?') for f in fields}
                needed={f:'v-'+f for f in fields if not f.endswith('?')}
                probe('POST '+path+' all','POST',path,json.dumps(everything).encode())
                if needed!=everything:probe('POST '+path+' needed','POST',path,json.dumps(needed).encode())
            probe('POST /api/song-import/apply setlist empty','POST','/api/song-import/apply',b'{"token":"t","setlist":""}')
            probe('POST /api/midi/connect output off','POST','/api/midi/connect',b'{"name":"n","output":false,"input":0}')
            probe('POST /api/song-metadata id only','POST','/api/song-metadata',b'{"id":"s1","timing":{"bpm":90},"other":1}')
            probe('POST /api/song-metadata both ids','POST','/api/song-metadata',b'{"song_id":"s1","id":"c1","chord_overrides":[],"revision":3}')
            WIRED_ANSWERS['_song_busy']=True
            try:
                probe('GET /api/song-export/s1 busy','GET','/api/song-export/s1')
                probe('POST /api/song-export/info busy','POST','/api/song-export/info',b'{"song_id":"s1"}')
            finally:WIRED_ANSWERS['_song_busy']=False
            WIRED_ANSWERS['cue_tracks.get']=None
            try:probe('POST /api/monitor/load no cue track','POST','/api/monitor/load',b'{"song_id":"s1"}')
            finally:WIRED_ANSWERS['cue_tracks.get']={'version':'cue-v1','name':'cue.wav'}
            WIRED_ANSWERS['documents.revision_stamp']={'source_sha256':'other'}
            try:probe('GET rhythm proposal of another source','GET','/api/documents/d1/rhythm/proposals/v1')
            finally:WIRED_ANSWERS['documents.revision_stamp']={'source_sha256':'abc'}
    finally:
        for name in SERVICES+APP_METHODS:
            if name in had:setattr(app,name,saved[name])
            else:app.__dict__.pop(name,None)
    check('EXPECTED_WIRED',actual,EXPECTED_WIRED)


def test_the_stream_key_and_the_route_table_agree():
    # What the OBS stream key may read is a pattern of its own (STREAM_READS); each kind of address it lets through must be a real GET route.
    for path in ['/api/document/d1','/api/visual-features/r1','/api/user-midi/s1/f1']:
        assert server_module.STREAM_READS.fullmatch(path)
        assert server_module.find_route(server_module.GET_ROUTES,path) is not None
    for path in ['/api/state','/api/user-midi/s1','/api/document/d1/export','/api/documents/d1','/api/visual-features/']:
        assert not server_module.STREAM_READS.fullmatch(path)


# Recorded from the server before the route tables (see the top of this file).
EXPECTED_REAL=[
    ['GET /api/visual-relay/address', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['port', 'url']], {}],
    ['GET /api/visual-relay/player', 200, 'text/event-stream; charset=utf-8', 'no-store', 'close', ['bytes', 0], {}],
    ['GET /visual-stream', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This stream address is not valid. Copy it again from Chord Buddy (More options, Visualizer for OBS).'], {}],
    ['GET /visual-stream?key=wrong', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This stream address is not valid. Copy it again from Chord Buddy (More options, Visualizer for OBS).'], {}],
    ['GET /visual-stream?key={key}', 200, 'text/event-stream; charset=utf-8', 'no-store', 'close', ['bytes', 0], {}],
    ['GET /api/update-check', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['GET /api/monitor/status', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['GET /api/cue-track/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['track']], {}],
    ['GET /api/cue-track/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/cue-track/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/midi/ports', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['GET /api/midi/status', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['clock', 'clock_in', 'inputs', 'late_ms', 'missed', 'outputs', 'queued', 'routes']], {}],
    ['GET /api/midi/log', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['list', 0], {}],
    ['GET /api/midi/events', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['events', 'last']], {}],
    ['GET /api/midi/events?after=x', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "invalid literal for int() with base 10: 'x'"], {}],
    ['GET /api/midi/events?after=2&wait=nan', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['events', 'last']], {}],
    ['GET /api/midi/events?wait=x', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "could not convert string to float: 'x'"], {}],
    ['GET /api/power', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['awake', 'holders', 'supported']], {}],
    ['GET /api/shows', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['list', 0], {}],
    ['GET /api/performances/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['list', 0], {}],
    ['GET /api/performances/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/show/nope/export', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Show not found'], {}],
    ['GET /api/show/nope/export/more', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Show not found'], {}],
    ['GET /api/performance/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Performance not found'], {}],
    ['GET /api/performance/nope?revision=x', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "invalid literal for int() with base 10: 'x'"], {}],
    ['GET /api/performance/nope?revision=2', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Performance not found'], {}],
    ['GET /api/show/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Show not found'], {}],
    ['GET /api/show/nope?revision=x', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "invalid literal for int() with base 10: 'x'"], {}],
    ['GET /api/show/nope?revision=2', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Show not found'], {}],
    ['GET /api/visual-patches', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['song', 'usual']], {}],
    ['GET /api/visual-patches/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['song', 'usual']], {}],
    ['GET /api/visual-patches/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/visual-patches/', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['song', 'usual']], {}],
    ['GET /api/user-midi/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['files']], {}],
    ['GET /api/user-midi/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/user-midi/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/user-midi/{song}/nofile', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That MIDI file is not here'], {}],
    ['GET /api/user-midi/{song}/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That MIDI file is not here'], {}],
    ['GET /api/user-midi/a/b/c', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Page not found'], {}],
    ['GET /api/documents/nope/rhythm/proposals/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['GET /api/documents/nope/rhythm/proposals/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['GET /api/waveform/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['GET /api/mix-export/nope', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected seven stem levels'], {}],
    ['GET /api/mix-export/nope?levels=bad', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected seven stem levels'], {}],
    ['GET /api/mix-export/nope?master=nan', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected seven stem levels'], {}],
    ['GET /api/stems-export/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['GET /api/song-export/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/song-export/{song}', 200, 'application/zip', 'no-store', 'close', ['bytes', None], {'Content-Disposition': "attachment; filename*=UTF-8''Test.zip"}],
    ['GET /api/song-export/{song}?stems=1', 200, 'application/zip', 'no-store', 'close', ['bytes', None], {'Content-Disposition': "attachment; filename*=UTF-8''Test.zip"}],
    ['GET /api/separation-audio/nope', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected frame bounds'], {}],
    ['GET /api/separation-audio/nope?start_frame=0&frame_count=10', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['GET /api/separation-audio/nope?start_frame=x&frame_count=1', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "invalid literal for int() with base 10: 'x'"], {}],
    ['GET /api/separation-audio/nope?start_frame=0&frame_count=1&more=1', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected frame bounds'], {}],
    ['GET /api/separation-audio/nope?start_frame=0&start_frame=1&frame_count=1', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected frame bounds'], {}],
    ['GET /api/visual-features/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['GET /api/playback/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active', 'analysis_id', 'ready', 'reason', 'song_id']], {'ETag': 'yes'}],
    ['GET /api/playback/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/separation/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active', 'availability', 'error', 'job']], {'ETag': 'yes'}],
    ['GET /api/separation/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/separation/cancel', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/prefs', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', []], {}],
    ['GET /api/models', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active', 'bytes_missing', 'models', 'ready']], {}],
    ['GET /api/chord-model', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['bytes_present', 'bytes_total', 'downloading', 'environment', 'error', 'folders', 'id', 'license', 'missing', 'progress', 'ready', 'role', 'title']], {}],
    ['GET /api/state', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['chord_model', 'engine', 'job', 'models', 'root', 'setlists', 'settings', 'songs', 'trash']], {'ETag': 'yes'}],
    ['GET /api/song/{song}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['chords', 'documents', 'metadata', 'runs', 'song']], {}],
    ['GET /api/song/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/document/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['GET /api/document/a/b', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['GET /api/audio/{song}', 200, 'audio/mpeg', 'no-store', 'close', ['bytes', 2252], {'Accept-Ranges': 'bytes'}],
    ['GET /api/audio/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/audio/{song}?token={token}', 200, 'audio/mpeg', 'no-store', 'close', ['bytes', 2252], {'Accept-Ranges': 'bytes'}],
    ['GET /api/export/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['GET /api/export-midi/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['GET /api/export-midi/nope?mode=tracks', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['GET /api/export-outputs/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['GET /api/nope', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['GET /api/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['GET /api', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Page not found'], {}],
    ['GET /api/state/more', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['GET /api/shows/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['GET /api/prefs?x=1', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', []], {}],
    ['GET /', 200, 'text/html', 'no-cache', None, ['bytes', None], {'ETag': 'yes'}],
    ['GET /index.html', 200, 'text/html', 'no-cache', None, ['bytes', None], {'ETag': 'yes'}],
    ['GET /nope.html', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Page not found'], {}],
    ['GET /visualizations/index.json', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['files', 'mine', 'mine_versions', 'versions']], {}],
    ['GET /my-visuals/nope.js', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Page not found'], {}],
    ['GET /my-visuals/', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Page not found'], {}],
    ['GET /web/../server.py', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Page not found'], {}],
    ['audio range', 206, 'audio/mpeg', 'no-store', 'close', ['bytes', 20], {'Content-Range': 'bytes 10-29/2252', 'Accept-Ranges': 'bytes'}],
    ['audio range past the end', 416, None, 'no-store', 'close', ['bytes', 0], {'Content-Range': 'bytes */2252'}],
    ['audio range nonsense', 416, None, 'no-store', 'close', ['bytes', 0], {'Content-Range': 'bytes */2252'}],
    ['audio last bytes', 206, 'audio/mpeg', 'no-store', 'close', ['bytes', 5], {'Content-Range': 'bytes 2247-2251/2252', 'Accept-Ranges': 'bytes'}],
    ['wrong token', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This request is not authorized'], {}],
    ['no token', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This request is not authorized'], {}],
    ['token in the address where that is not allowed', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This request is not authorized'], {}],
    ['token in the address of the audio', 200, 'audio/mpeg', 'no-store', 'close', ['bytes', 2252], {'Accept-Ranges': 'bytes'}],
    ['token in the address of an export', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['foreign origin', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This request is not authorized'], {}],
    ['wrong host', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This request is not authorized'], {}],
    ['static without a token', 200, 'text/html', 'no-cache', None, ['bytes', None], {'ETag': 'yes'}],
    ['post without a token', 403, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This request is not authorized'], {}],
    ['model import, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected a model file'], {}],
    ['model import, size not a number', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "invalid literal for int() with base 10: 'x'"], {}],
    ['song import, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose a song zip exported from Chord Buddy.'], {}],
    ['song import, size not a number', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid request size'], {}],
    ['song import, not a zip', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This file is not a song exported from Chord Buddy.'], {}],
    ['import, not an mp3', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This file could not be read as an MP3'], {}],
    ['import, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The file or request is empty or too large'], {}],
    ['import, no name', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose a file name without folder paths'], {}],
    ['import, unknown setlist', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This file could not be read as an MP3'], {}],
    ['cue track upload, unknown song', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['cue track upload, not audio', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose an audio file: WAV, MP3, FLAC, OGG or M4A.'], {}],
    ['cue track upload, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The file or request is empty or too large'], {}],
    ['midi upload, unknown song', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That is not a valid MIDI file'], {}],
    ['midi upload, not midi', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That is not a valid MIDI file'], {}],
    ['midi upload, unique, not midi', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That is not a valid MIDI file'], {}],
    ['midi upload, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The file or request is empty or too large'], {}],
    ['json, a list', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected an object'], {}],
    ['json, not json', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expecting value: line 1 column 1 (char 0)'], {}],
    ['json, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The file or request is empty or too large'], {}],
    ['json, nan', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'A level must be between 0 and 1.'], {}],
    ['json, unknown address, empty', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The file or request is empty or too large'], {}],
    ['json, size not a number', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid request size'], {}],
    ['post to the event stream', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['post to a get route', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['settings, unknown device', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose Automatic, NVIDIA GPU Only, or CPU Only'], {}],
    ['settings, a list', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose Automatic, NVIDIA GPU Only, or CPU Only'], {}],
    ['gains, a string', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'A level must be between 0 and 1.'], {}],
    ['gains, too loud', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'A level must be between 0 and 1.'], {}],
    ['gains, fine', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['monitor cancel, a string', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That isn’t a time.'], {}],
    ['midi schedule, events not a list', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'MIDI events must be a list.'], {}],
    ['midi schedule, device not a string', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose a MIDI device.'], {}],
    ['midi schedule, a bad event', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That MIDI message isn’t valid.'], {}],
    ['lead sheet, song of another kind', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['lead sheet, entity', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This score cannot be opened.'], {}],
    ['analyze, stems not yes or no', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid stems setting'], {}],
    ['separate, rerun not yes or no', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid rerun setting'], {}],
    ['transcribe, odd edit policy', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The engine is not ready (test).'], {}],
    ['rename the song', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active_run', 'artist', 'created', 'deleted', 'duration', 'error', 'filename', 'folder', 'id', 'status', 'title']], {}],
    ['rename the song, title a number', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['song export sizes', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['bytes', 'stems_bytes', 'title']], {}],
    ['a setlist', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['id', 'name', 'song_ids']], {}],
    ['a setlist, no name', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['visual relay send', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Not a visualizer message'], {}],
    ['visual relay send, not a list', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected a list of messages'], {}],
    ['trash then restore the song', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active_run', 'artist', 'created', 'deleted', 'duration', 'error', 'filename', 'folder', 'id', 'status', 'title']], {}],
    ['restore the song', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active_run', 'artist', 'created', 'deleted', 'duration', 'error', 'filename', 'folder', 'id', 'status', 'title']], {}],
    ['POST /api/visual-relay/send {}', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected a list of messages'], {}],
    ['POST /api/visual-relay/send unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected a list of messages'], {}],
    ['POST /api/visual-relay/send lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Not a visualizer message'], {}],
    ['POST /api/visual-relay/send numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected a list of messages'], {}],
    ['POST /api/documents/d1/timing {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'timing'], {}],
    ['POST /api/documents/d1/timing unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/timing lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/timing numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/cleanup/preview {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/cleanup/apply {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'preview'], {}],
    ['POST /api/documents/d1/cleanup/apply unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/cleanup/apply lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/cleanup/apply numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/rhythm/propose {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/rhythm/preview {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'proposal_id'], {}],
    ['POST /api/documents/d1/rhythm/preview unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/rhythm/preview lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/rhythm/preview numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/documents/d1/rhythm/apply {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'preview_id'], {}],
    ['POST /api/documents/d1/rhythm/apply unknown', 409, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Preview expired or changed; refresh before applying'], {}],
    ['POST /api/documents/d1/rhythm/apply lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "unhashable type: 'list'"], {}],
    ['POST /api/documents/d1/rhythm/apply numbers', 409, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Preview expired or changed; refresh before applying'], {}],
    ['POST /api/songs/s1/analyze {}', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The stem separation models have not been downloaded yet. Use "Download models" first.'], {}],
    ['POST /api/songs/s1/analyze unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid stems setting'], {}],
    ['POST /api/songs/s1/analyze lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid stems setting'], {}],
    ['POST /api/songs/s1/analyze numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid stems setting'], {}],
    ['POST /api/analysis/a1/cancel {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown analysis job'], {}],
    ['POST /api/separate {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/separate unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid rerun setting'], {}],
    ['POST /api/separate lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid rerun setting'], {}],
    ['POST /api/separate numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Invalid rerun setting'], {}],
    ['POST /api/separation/cancel {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'job_id'], {}],
    ['POST /api/separation/cancel unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['POST /api/separation/cancel lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['POST /api/separation/cancel numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown separation run'], {}],
    ['POST /api/song {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/song unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['POST /api/song numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['POST /api/song/trash {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/song/trash unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song/trash lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/song/trash numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song/restore {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/song/restore unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song/restore lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/song/restore numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song/purge {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/song/purge unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song/purge lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/song/purge numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song-export/info {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/song-export/info unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song-export/info lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/song-export/info numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song-import/apply {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'token'], {}],
    ['POST /api/song-import/apply unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose how to import this song'], {}],
    ['POST /api/song-import/apply lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose how to import this song'], {}],
    ['POST /api/song-import/apply numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose how to import this song'], {}],
    ['POST /api/song-import/cancel {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'token'], {}],
    ['POST /api/song-import/cancel unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/song-import/cancel lists', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/song-import/cancel numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/setlist {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'name'], {}],
    ['POST /api/setlist unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['id', 'name', 'song_ids']], {}],
    ['POST /api/setlist lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['POST /api/setlist numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['POST /api/setlist/rename {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/setlist/rename unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/rename lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['POST /api/setlist/rename numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Enter a name between 1 and 200 characters'], {}],
    ['POST /api/setlist/delete {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/setlist/delete unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/delete lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/setlist/delete numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/order {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/setlist/order unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/order lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/setlist/order numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/add {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/setlist/add unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/add lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/setlist/add numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/remove {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/setlist/remove unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/setlist/remove lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/setlist/remove numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Set list not found'], {}],
    ['POST /api/prefs {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', []], {}],
    ['POST /api/prefs unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown preference'], {}],
    ['POST /api/prefs lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown preference'], {}],
    ['POST /api/prefs numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown preference'], {}],
    ['POST /api/models/download {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/models/cancel {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['active', 'bytes_missing', 'models', 'ready']], {}],
    ['POST /api/chord-model/download {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/chord-model/cancel {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['bytes_present', 'bytes_total', 'downloading', 'environment', 'error', 'folders', 'id', 'license', 'missing', 'progress', 'ready', 'role', 'title']], {}],
    ['POST /api/settings {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['beat_flag_threshold', 'beat_remove_threshold', 'chord_flag_threshold', 'chord_opacity_max', 'chord_opacity_min', 'device']], {}],
    ['POST /api/settings unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose Automatic, NVIDIA GPU Only, or CPU Only'], {}],
    ['POST /api/settings lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose Automatic, NVIDIA GPU Only, or CPU Only'], {}],
    ['POST /api/settings numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose Automatic, NVIDIA GPU Only, or CPU Only'], {}],
    ['POST /api/song-metadata {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/song-metadata unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song metadata must contain timing and chord overrides'], {}],
    ['POST /api/song-metadata lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song metadata must contain timing and chord overrides'], {}],
    ['POST /api/song-metadata numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song metadata must contain timing and chord overrides'], {}],
    ['POST /api/confirm-chord {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/confirm-chord unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/confirm-chord lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/confirm-chord numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/start-chord-at-measure {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/start-chord-at-measure unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/start-chord-at-measure lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/start-chord-at-measure numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/transcribe {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/transcribe unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The engine is not ready (test).'], {}],
    ['POST /api/transcribe lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The engine is not ready (test).'], {}],
    ['POST /api/transcribe numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The engine is not ready (test).'], {}],
    ['POST /api/activate-run {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/activate-run unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/activate-run lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/activate-run numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/cancel {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['value', None], {}],
    ['POST /api/lead-sheet/external {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/lead-sheet/external unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'The score is not valid MusicXML: syntax error: line 1, column 0'], {}],
    ['POST /api/lead-sheet/external lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'There is no score to open.'], {}],
    ['POST /api/lead-sheet/external numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'There is no score to open.'], {}],
    ['POST /api/midi/external {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/midi/external unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/midi/external lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/midi/external numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/open-folder {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/open-folder unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/open-folder lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/open-folder numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/update-page {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['opened']], {}],
    ['POST /api/monitor/schedule {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'events'], {}],
    ['POST /api/monitor/schedule unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/monitor/schedule lists', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/monitor/schedule numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/monitor/cancel {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['POST /api/monitor/cancel unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That isn’t a time.'], {}],
    ['POST /api/monitor/cancel lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That isn’t a time.'], {}],
    ['POST /api/monitor/cancel numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['POST /api/monitor/gains {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['POST /api/monitor/gains unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'A level must be between 0 and 1.'], {}],
    ['POST /api/monitor/gains lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'A level must be between 0 and 1.'], {}],
    ['POST /api/monitor/gains numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'A level must be between 0 and 1.'], {}],
    ['POST /api/monitor/load {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/monitor/load unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/monitor/load lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/monitor/load numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/cue-track/remove {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/cue-track/remove unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/cue-track/remove lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/cue-track/remove numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/midi/connect {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'name'], {}],
    ['POST /api/midi/connect unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/midi/connect lists', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/midi/connect numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/midi/disconnect {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'name'], {}],
    ['POST /api/midi/disconnect unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['input', 'name', 'output']], {}],
    ['POST /api/midi/disconnect lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "unhashable type: 'list'"], {}],
    ['POST /api/midi/disconnect numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['input', 'name', 'output']], {}],
    ['POST /api/midi/schedule {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'device'], {}],
    ['POST /api/midi/schedule unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'MIDI events must be a list.'], {}],
    ['POST /api/midi/schedule lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Choose a MIDI device.'], {}],
    ['POST /api/midi/schedule numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'MIDI events must be a list.'], {}],
    ['POST /api/midi/cancel {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/midi/cancel unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/midi/cancel lists', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/midi/cancel numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['cancelled']], {}],
    ['POST /api/midi/cleanup {}', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['POST /api/midi/cleanup unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['POST /api/midi/cleanup lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "unhashable type: 'list'"], {}],
    ['POST /api/midi/cleanup numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['ok']], {}],
    ['POST /api/power/acquire {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'holder'], {}],
    ['POST /api/power/acquire unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/power/acquire lists', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/power/acquire numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/power/release {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'holder'], {}],
    ['POST /api/power/release unknown', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/power/release lists', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/power/release numbers', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['keys', ['args', 'kwargs', 'stand-in']], {}],
    ['POST /api/performance/save {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'body'], {}],
    ['POST /api/performance/save unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This performance was made by a different version of Chord Buddy.'], {}],
    ['POST /api/performance/save lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This performance was made by a different version of Chord Buddy.'], {}],
    ['POST /api/performance/save numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This performance was made by a different version of Chord Buddy.'], {}],
    ['POST /api/performance/draft {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'body'], {}],
    ['POST /api/performance/draft unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This performance was made by a different version of Chord Buddy.'], {}],
    ['POST /api/performance/draft lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This performance was made by a different version of Chord Buddy.'], {}],
    ['POST /api/performance/draft numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This performance was made by a different version of Chord Buddy.'], {}],
    ['POST /api/performance/delete {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/performance/delete unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Performance not found'], {}],
    ['POST /api/performance/delete lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 2: type 'list' is not supported"], {}],
    ['POST /api/performance/delete numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Performance not found'], {}],
    ['POST /api/show/save {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'body'], {}],
    ['POST /api/show/save unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This show was made by a different version of Chord Buddy.'], {}],
    ['POST /api/show/save lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This show was made by a different version of Chord Buddy.'], {}],
    ['POST /api/show/save numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This show was made by a different version of Chord Buddy.'], {}],
    ['POST /api/show/draft {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'body'], {}],
    ['POST /api/show/draft unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This show was made by a different version of Chord Buddy.'], {}],
    ['POST /api/show/draft lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This show was made by a different version of Chord Buddy.'], {}],
    ['POST /api/show/draft numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'This show was made by a different version of Chord Buddy.'], {}],
    ['POST /api/show/import {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'bundle'], {}],
    ['POST /api/show/import unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That isn’t a Chord Buddy show file.'], {}],
    ['POST /api/show/import lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That isn’t a Chord Buddy show file.'], {}],
    ['POST /api/show/import numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'That isn’t a Chord Buddy show file.'], {}],
    ['POST /api/show/delete {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'id'], {}],
    ['POST /api/show/delete unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Show not found'], {}],
    ['POST /api/show/delete lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 2: type 'list' is not supported"], {}],
    ['POST /api/show/delete numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Show not found'], {}],
    ['POST /api/visual-patches {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'visual'], {}],
    ['POST /api/visual-patches unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/visual-patches lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown visualization'], {}],
    ['POST /api/visual-patches numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown visualization'], {}],
    ['POST /api/user-midi/settings {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/user-midi/settings unknown', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected settings'], {}],
    ['POST /api/user-midi/settings lists', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected settings'], {}],
    ['POST /api/user-midi/settings numbers', 400, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Expected settings'], {}],
    ['POST /api/user-midi/rename {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/user-midi/rename unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/rename lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/user-midi/rename numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/remove {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/user-midi/remove unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/remove lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/user-midi/remove numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/open {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/user-midi/open unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/open lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/user-midi/open numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/folder {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'song_id'], {}],
    ['POST /api/user-midi/folder unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/user-midi/folder lists', 500, 'application/json; charset=utf-8', 'no-store', 'close', ['error', "Chord Buddy could not complete this action: Error binding parameter 1: type 'list' is not supported"], {}],
    ['POST /api/user-midi/folder numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Song not found'], {}],
    ['POST /api/document/d1 {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'content'], {}],
    ['POST /api/document/d1 unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1 lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1 numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/export {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'revision'], {}],
    ['POST /api/document/d1/export unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/export lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/export numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/undo {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'revision'], {}],
    ['POST /api/document/d1/undo unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/undo lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/undo numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/d1/undo/more {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown document action'], {}],
    ['POST /api/document/ {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'content'], {}],
    ['POST /api/document/ unknown', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/ lists', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/document/ numbers', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Document not found'], {}],
    ['POST /api/nothing-here {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['POST /api/documents/d1/timing/more {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
    ['POST /nothing-here {}', 404, 'application/json; charset=utf-8', 'no-store', 'close', ['error', 'Unknown action'], {}],
]

EXPECTED_WIRED=[
    ['GET /api/update-check', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'update_check.check'}, {}, [['update_check.check', [], {}]]],
    ['GET /api/monitor/status', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'monitor.status'}, {}, [['monitor.status', [], {}]]],
    ['GET /api/cue-track/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'track': {'version': 'cue-v1', 'name': 'cue.wav'}}, {}, [['cue_tracks.get', ['s1'], {}]]],
    ['GET /api/cue-track/s1/more', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'track': {'version': 'cue-v1', 'name': 'cue.wav'}}, {}, [['cue_tracks.get', ['s1/more'], {}]]],
    ['GET /api/midi/ports', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.ports'}, {}, [['midi.ports', [], {}]]],
    ['GET /api/midi/status', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.status'}, {}, [['midi.status', [], {}]]],
    ['GET /api/midi/events', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.read_events'}, {}, [['midi.read_events', [0, 0.0], {}]]],
    ['GET /api/midi/events?after=7&wait=1.5', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.read_events'}, {}, [['midi.read_events', [7, 1.5], {}]]],
    ['GET /api/power', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'power.status'}, {}, [['power.status', [], {}]]],
    ['GET /api/shows', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.shows'}, {}, [['performances.shows', [], {}]]],
    ['GET /api/performances/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.performances_for_song'}, {}, [['performances.performances_for_song', ['s1'], {}]]],
    ['GET /api/show/w1/export', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.export_show'}, {}, [['performances.export_show', ['w1', '<visual_patches>'], {}]]],
    ['GET /api/performance/p1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.performance'}, {}, [['performances.performance', ['p1', None], {}]]],
    ['GET /api/performance/p1?revision=3', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.performance'}, {}, [['performances.performance', ['p1', 3], {}]]],
    ['GET /api/show/w1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.show'}, {}, [['performances.show', ['w1', None], {}]]],
    ['GET /api/show/w1?revision=4', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.show'}, {}, [['performances.show', ['w1', 4], {}]]],
    ['GET /api/show/w1/more?revision=4', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.show'}, {}, [['performances.show', ['w1/more', 4], {}]]],
    ['GET /api/visual-patches', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'visual_patches.read'}, {}, [['visual_patches.read', [], {}]]],
    ['GET /api/visual-patches/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'visual_patches.read'}, {}, [['visual_patches.read', ['s1'], {}]]],
    ['GET /api/user-midi/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'files': {'from': 'user_midi.list'}}, {}, [['user_midi.list', ['s1'], {}]]],
    ['GET /api/user-midi/s1/f1', 200, 'audio/midi', 'no-store', 'close', 'MThd-fixture', {}, [['user_midi.read', ['s1', 'f1'], {}]]],
    ['GET /api/documents/d1/rhythm/proposals/v1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'transcription_id': 'r1', 'source_sha256': 'abc', 'from': 'documents.timing.version'}, {}, [['documents.get', ['d1'], {}], ['documents.timing.version', ['v1'], {}], ['documents.revision_stamp', ['d1'], {}]]],
    ['GET /api/playback/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'playback_state'}, {'ETag': '"33843a56414e469aac3caff3"'}, [['playback_state', ['s1'], {}]]],
    ['GET /api/separation/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'separation_store.get_song_state'}, {'ETag': '"b4628a76c4e27f0b95936286"'}, [['separation_store.get_song_state', ['s1'], {}]]],
    ['GET /api/prefs', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.read_prefs'}, {}, [['library.read_prefs', [], {}]]],
    ['GET /api/models', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'models.status'}, {}, [['models.status', [], {}]]],
    ['GET /api/chord-model', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'chord_model.status'}, {}, [['chord_model.status', [], {}]]],
    ['GET /api/state', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'state'}, {'ETag': '"d2cbe699bd777467a29168ec"'}, [['state', [], {}]]],
    ['GET /api/song/s1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.song_detail'}, {}, [['documents.song_detail', ['s1'], {}]]],
    ['GET /api/document/d1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'id': 'd1', 'run_id': 'r1', 'from': 'documents.get'}, {}, [['documents.get', ['d1'], {}]]],
    ['GET /api/export/d1', 200, 'application/octet-stream', 'no-store', 'close', 'exported', {'Content-Disposition': "attachment; filename*=UTF-8''Song%20chart.abc"}, [['documents.export', ['d1'], {}]]],
    ['GET /api/export-midi/d1', 200, 'application/octet-stream', 'no-store', 'close', 'MThd-export', {'Content-Disposition': "attachment; filename*=UTF-8''Song%20%C3%A9.mid"}, [['documents.midi_download', ['d1', 'single'], {}]]],
    ['GET /api/export-midi/d1?mode=tracks', 200, 'application/octet-stream', 'no-store', 'close', 'MThd-export', {'Content-Disposition': "attachment; filename*=UTF-8''Song%20%C3%A9.mid"}, [['documents.midi_download', ['d1', 'tracks'], {}]]],
    ['GET /api/export-outputs/d1', 200, 'application/octet-stream', 'no-store', 'close', 'PK-zip', {'Content-Disposition': "attachment; filename*=UTF-8''Song%20outputs.zip"}, [['documents.outputs_zip', ['d1'], {}]]],
    ['GET /api/midi/log', 200, 'application/json; charset=utf-8', 'no-store', 'close', ['logged'], {}, []],
    ['POST /api/song-import', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transfer.receive'}, {}, [['transfer.receive', ['<callable>', 6], {}]]],
    ['POST /api/import?filename=Song.mp3', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.import_audio'}, {}, [['library.import_audio', ['Song.mp3', '<5 bytes>', 'default'], {}]]],
    ['POST /api/import?filename=Song.mp3&setlist=l1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.import_audio'}, {}, [['library.import_audio', ['Song.mp3', '<5 bytes>', 'l1'], {}]]],
    ['POST /api/cue-track/upload?song=s1&name=cue.wav', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'cue_tracks.add'}, {}, [['cue_tracks.add', ['s1', 'cue.wav', '<5 bytes>'], {}]]],
    ['POST /api/user-midi/upload?song=s1&name=a.mid', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'user_midi.add'}, {}, [['user_midi.add', ['s1', 'a.mid', '<4 bytes>', None], {}]]],
    ['POST /api/user-midi/upload?song=s1&name=a.mid&replace=f1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'user_midi.add'}, {}, [['user_midi.add', ['s1', 'a.mid', '<4 bytes>', 'f1'], {}]]],
    ['POST /api/user-midi/upload?song=s1&unique=1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'user_midi.add'}, {}, [['user_midi.next_name', ['s1', 'Custom MIDI'], {}], ['user_midi.add', ['s1', 'Custom MIDI 2', '<4 bytes>', None], {}]]],
    ['POST /api/user-midi/upload?song=s1&name=a.mid&unique=1', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'user_midi.add'}, {}, [['user_midi.next_name', ['s1', 'a.mid'], {}], ['user_midi.add', ['s1', 'Custom MIDI 2', '<4 bytes>', None], {}]]],
    ['POST /api/visual-relay/send all', 400, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Expected a list of messages'}, {}, []],
    ['POST /api/visual-relay/send needed', 400, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Expected a list of messages'}, {}, []],
    ['POST /api/documents/d1/timing all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.set_chart_timing'}, {}, [['documents.set_chart_timing', ['d1', 'v-timing', 'v-revision'], {}]]],
    ['POST /api/documents/d1/cleanup/preview all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.preview_cleanup'}, {}, [['documents.preview_cleanup', ['d1'], {}]]],
    ['POST /api/documents/d1/cleanup/apply all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_cleanup'}, {}, [['documents.apply_cleanup', ['d1', 'v-preview', 'v-revision'], {}]]],
    ['POST /api/documents/d1/rhythm/propose all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'propose_rhythm'}, {}, [['propose_rhythm', ['d1'], {}]]],
    ['POST /api/documents/d1/rhythm/preview all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'rhythm.preview'}, {}, [['rhythm.preview', ['d1', 'v-proposal_id', 'v-policy'], {}]]],
    ['POST /api/documents/d1/rhythm/apply all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'rhythm.apply'}, {}, [['rhythm.apply', ['d1', 'v-preview_id', 'v-stamp', 'v-policy'], {}]]],
    ['POST /api/songs/s1/analyze all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'analyze'}, {}, [['analyze', ['s1', 'v-invalidate', 'v-stems', 'v-edit_policy'], {}]]],
    ['POST /api/songs/s1/analyze needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'analyze'}, {}, [['analyze', ['s1', [], True, 'keep'], {}]]],
    ['POST /api/analysis/a1/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'analysis.cancel'}, {}, [['analysis.cancel', ['a1'], {}]]],
    ['POST /api/separate all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'separate'}, {}, [['separate', ['v-song_id', 'v-rerun'], {}]]],
    ['POST /api/separate needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'separate'}, {}, [['separate', ['v-song_id', False], {}]]],
    ['POST /api/separation/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'separation.cancel'}, {}, [['separation.cancel', ['v-job_id'], {}]]],
    ['POST /api/song all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.rename_song'}, {}, [['library.rename_song', ['v-id', 'v-title', 'v-artist'], {}]]],
    ['POST /api/song needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.rename_song'}, {}, [['library.rename_song', ['v-id', 'v-title', None], {}]]],
    ['POST /api/song/trash all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'trash_song'}, {}, [['trash_song', ['v-id'], {}]]],
    ['POST /api/song/restore all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.restore_song'}, {}, [['library.restore_song', ['v-id'], {}]]],
    ['POST /api/song/purge all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'purge_song'}, {}, [['purge_song', ['v-id'], {}]]],
    ['POST /api/song-export/info all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transfer.sizes'}, {}, [['_song_busy', ['v-song_id'], {}], ['transfer.sizes', ['v-song_id'], {}]]],
    ['POST /api/song-import/apply all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transfer.apply'}, {}, [['transfer.apply', ['v-token', 'v-mode', 'v-analysis', 'v-stems', 'v-setlist', 'v-target'], {}]]],
    ['POST /api/song-import/apply needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transfer.apply'}, {}, [['transfer.apply', ['v-token', None, False, False, 'default', None], {}]]],
    ['POST /api/song-import/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transfer.cancel'}, {}, [['transfer.cancel', ['v-token'], {}]]],
    ['POST /api/setlist all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.create_setlist'}, {}, [['library.create_setlist', ['v-name'], {}]]],
    ['POST /api/setlist/rename all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.rename_setlist'}, {}, [['library.rename_setlist', ['v-id', 'v-name'], {}]]],
    ['POST /api/setlist/delete all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.delete_setlist'}, {}, [['library.delete_setlist', ['v-id'], {}]]],
    ['POST /api/setlist/order all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.reorder_setlist'}, {}, [['library.reorder_setlist', ['v-id', 'v-song_ids'], {}]]],
    ['POST /api/setlist/add all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.add_to_setlist'}, {}, [['library.add_to_setlist', ['v-id', 'v-song_id'], {}]]],
    ['POST /api/setlist/remove all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.remove_from_setlist'}, {}, [['library.remove_from_setlist', ['v-id', 'v-song_id'], {}]]],
    ['POST /api/prefs all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.write_prefs'}, {}, [['library.write_prefs', [{'anything': 'v-anything'}], {}]]],
    ['POST /api/prefs needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.write_prefs'}, {}, [['library.write_prefs', [{}], {}]]],
    ['POST /api/models/download all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'models.start'}, {}, [['models.start', [], {}]]],
    ['POST /api/models/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'models.cancel'}, {}, [['models.cancel', [], {}]]],
    ['POST /api/chord-model/download all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'chord_model.start'}, {}, [['chord_model.start', [], {}]]],
    ['POST /api/chord-model/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'chord_model.cancel'}, {}, [['chord_model.cancel', [], {}]]],
    ['POST /api/settings all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.settings'}, {}, [['library.settings', [{'device': 'v-device'}], {}]]],
    ['POST /api/settings needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'library.settings'}, {}, [['library.settings', [{}], {}]]],
    ['POST /api/song-metadata all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_song_metadata'}, {}, [['documents.apply_song_metadata', ['v-song_id', 'v-metadata', 'v-revision'], {}]]],
    ['POST /api/song-metadata needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_song_metadata'}, {}, [['documents.apply_song_metadata', [None, {}, None], {}]]],
    ['POST /api/confirm-chord all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_song_metadata'}, {}, [['library.song_metadata', ['v-song_id'], {}], ['documents.apply_song_metadata', ['v-song_id', {'timing': {'bpm': 100}, 'chord_overrides': [{'id': 'other', 'label': 'kept'}, {'id': 'v-id', 'start': 'v-start', 'end': 'v-end', 'label': 'v-label', 'confirmed': True}]}, 'v-revision'], {}]]],
    ['POST /api/confirm-chord needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_song_metadata'}, {}, [['library.song_metadata', [None], {}], ['documents.apply_song_metadata', [None, {'timing': {'bpm': 100}, 'chord_overrides': [{'id': 'v-id', 'label': 'old'}, {'id': 'other', 'label': 'kept'}, {'confirmed': True}]}, None], {}]]],
    ['POST /api/start-chord-at-measure all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.start_chord_at_measure'}, {}, [['documents.start_chord_at_measure', ['v-song_id', 'v-chord_id', 'v-measure_id', 'v-revision', 'v-document_id'], {}]]],
    ['POST /api/start-chord-at-measure needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.start_chord_at_measure'}, {}, [['documents.start_chord_at_measure', ['v-song_id', 'v-chord_id', 'v-measure_id', None, None], {}]]],
    ['POST /api/transcribe all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transcribe'}, {}, [['transcribe', ['v-song_id', 'v-edit_policy'], {}]]],
    ['POST /api/transcribe needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transcribe'}, {}, [['transcribe', ['v-song_id', None], {}]]],
    ['POST /api/activate-run all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'activate_run'}, {}, [['activate_run', ['v-song_id', 'v-run_id'], {}]]],
    ['POST /api/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'engine.cancel'}, {}, [['engine.cancel', [], {}]]],
    ['POST /api/lead-sheet/external all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'open_external_score'}, {}, [['open_external_score', ['v-song_id', 'v-filename', 'v-xml'], {}]]],
    ['POST /api/lead-sheet/external needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'open_external_score'}, {}, [['open_external_score', ['v-song_id', None, None], {}]]],
    ['POST /api/midi/external all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'open_external_midi'}, {}, [['open_external_midi', ['v-song_id', 'v-document_id'], {}]]],
    ['POST /api/open-folder all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'ok': True}, {}, [['library.folder', ['v-song_id'], {}], ['os.startfile', ['F:/songs/s1'], {}]]],
    ['POST /api/update-page all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'opened': True}, {}, []],
    ['POST /api/monitor/schedule all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'monitor.schedule'}, {}, [['monitor.schedule', ['v-events'], {}]]],
    ['POST /api/monitor/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'monitor.cancel'}, {}, [['monitor.cancel', ['v-from'], {}]]],
    ['POST /api/monitor/cancel needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'monitor.cancel'}, {}, [['monitor.cancel', [None], {}]]],
    ['POST /api/monitor/gains all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'monitor.set_gains'}, {}, [['monitor.set_gains', ['v-click', 'v-cue'], {}]]],
    ['POST /api/monitor/gains needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'monitor.set_gains'}, {}, [['monitor.set_gains', [None, None], {}]]],
    ['POST /api/monitor/load all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'ready': True, 'key': 'cue-v1'}, {}, [['cue_tracks.get', ['v-song_id'], {}], ['cue_tracks.path', ['v-song_id'], {}], ['monitor.load_track', ['cue-v1', 'F:/songs/s1/my-cues/cue.wav'], {}]]],
    ['POST /api/cue-track/remove all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'ok': True}, {}, [['cue_tracks.remove', ['v-song_id'], {}]]],
    ['POST /api/midi/connect all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.connect'}, {}, [['midi.connect', ['v-name'], {'output': True, 'input': True}]]],
    ['POST /api/midi/connect needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.connect'}, {}, [['midi.connect', ['v-name'], {'output': True, 'input': True}]]],
    ['POST /api/midi/disconnect all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.disconnect'}, {}, [['midi.disconnect', ['v-name'], {}]]],
    ['POST /api/midi/schedule all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.schedule'}, {}, [['midi.schedule', ['v-device', 'v-events', 'v-generation'], {}]]],
    ['POST /api/midi/schedule needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.schedule'}, {}, [['midi.schedule', ['v-device', 'v-events', 0], {}]]],
    ['POST /api/midi/cancel all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.cancel'}, {}, [['midi.cancel', ['v-device', 'v-from', 'v-generation'], {}]]],
    ['POST /api/midi/cancel needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.cancel'}, {}, [['midi.cancel', [None, None, None], {}]]],
    ['POST /api/midi/cleanup all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.cleanup'}, {}, [['midi.cleanup', ['v-device'], {}]]],
    ['POST /api/midi/cleanup needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.cleanup'}, {}, [['midi.cleanup', [None], {}]]],
    ['POST /api/power/acquire all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'power.acquire'}, {}, [['power.acquire', ['v-holder'], {}]]],
    ['POST /api/power/release all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'power.release'}, {}, [['power.release', ['v-holder'], {}]]],
    ['POST /api/performance/save all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.save_performance'}, {}, [['performances.save_performance', ['v-body', 'v-base'], {}]]],
    ['POST /api/performance/draft all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.save_performance_draft'}, {}, [['performances.save_performance_draft', ['v-body', 'v-base'], {}]]],
    ['POST /api/performance/delete all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.delete_performance'}, {}, [['performances.delete_performance', ['v-id'], {}]]],
    ['POST /api/show/save all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.save_show'}, {}, [['performances.save_show', ['v-body', 'v-base'], {}]]],
    ['POST /api/show/draft all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.save_show_draft'}, {}, [['performances.save_show_draft', ['v-body', 'v-base'], {}]]],
    ['POST /api/show/import all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.import_show'}, {}, [['performances.import_show', ['v-bundle', '<visual_patches>'], {}]]],
    ['POST /api/show/delete all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'performances.delete_show'}, {}, [['performances.delete_show', ['v-id'], {}]]],
    ['POST /api/visual-patches all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'visual_patches.save'}, {}, [['visual_patches.save', ['v-visual', 'v-patch', 'v-song_id'], {}]]],
    ['POST /api/visual-patches needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'visual_patches.save'}, {}, [['visual_patches.save', ['v-visual', None, None], {}]]],
    ['POST /api/user-midi/settings all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'user_midi.save_settings'}, {}, [['user_midi.save_settings', ['v-song_id', 'v-id', 'v-settings'], {}]]],
    ['POST /api/user-midi/rename all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'user_midi.rename'}, {}, [['user_midi.rename', ['v-song_id', 'v-id', 'v-name'], {}]]],
    ['POST /api/user-midi/remove all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'ok': True}, {}, [['user_midi.remove', ['v-song_id', 'v-id'], {}]]],
    ['POST /api/user-midi/open all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'open_user_midi'}, {}, [['open_user_midi', ['v-song_id', 'v-id'], {}]]],
    ['POST /api/user-midi/folder all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'ok': True, 'path': 'F:/songs/s1/my-midi'}, {}, [['user_midi.folder_path', ['v-song_id'], {}], ['os.startfile', ['F:/songs/s1/my-midi'], {}]]],
    ['POST /api/document/d1 all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.save'}, {}, [['documents.save', ['d1', 'v-content', 'v-label', 'v-revision'], {}]]],
    ['POST /api/document/d1 needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.save'}, {}, [['documents.save', ['d1', 'v-content', 'Edit document', 'v-revision'], {}]]],
    ['POST /api/document/d1/export all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.retry_export'}, {}, [['documents.retry_export', ['d1', 'v-revision'], {}]]],
    ['POST /api/document/d1/undo all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.history'}, {}, [['documents.history', ['d1', 'undo', 'v-revision', 'v-position'], {}]]],
    ['POST /api/document/d1/undo needed', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.history'}, {}, [['documents.history', ['d1', 'undo', 'v-revision', None], {}]]],
    ['POST /api/document/d1/undo/more all', 404, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Unknown document action'}, {}, []],
    ['POST /api/document/ all', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.save'}, {}, [['documents.save', ['', 'v-content', 'Edit document', 'v-revision'], {}]]],
    ['POST /api/nothing-here all', 404, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Unknown action'}, {}, []],
    ['POST /api/documents/d1/timing/more all', 404, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Unknown action'}, {}, []],
    ['POST /nothing-here all', 404, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Unknown action'}, {}, []],
    ['POST /api/song-import/apply setlist empty', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'transfer.apply'}, {}, [['transfer.apply', ['t', None, False, False, 'default', None], {}]]],
    ['POST /api/midi/connect output off', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'midi.connect'}, {}, [['midi.connect', ['n'], {'output': False, 'input': True}]]],
    ['POST /api/song-metadata id only', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_song_metadata'}, {}, [['documents.apply_song_metadata', ['s1', {'timing': {'bpm': 90}}, None], {}]]],
    ['POST /api/song-metadata both ids', 200, 'application/json; charset=utf-8', 'no-store', 'close', {'from': 'documents.apply_song_metadata'}, {}, [['documents.apply_song_metadata', ['s1', {'chord_overrides': []}, 3], {}]]],
    ['GET /api/song-export/s1 busy', 409, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'This song is being analyzed. Wait for it to finish, then export it.'}, {}, [['_song_busy', ['s1'], {}]]],
    ['POST /api/song-export/info busy', 409, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'This song is being analyzed. Wait for it to finish, then export it.'}, {}, [['_song_busy', ['s1'], {}]]],
    ['POST /api/monitor/load no cue track', 404, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'This song has no cue track'}, {}, [['cue_tracks.get', ['s1'], {}]]],
    ['GET rhythm proposal of another source', 400, 'application/json; charset=utf-8', 'no-store', 'close', {'error': 'Proposal belongs to another source'}, {}, [['documents.get', ['d1'], {}], ['documents.timing.version', ['v1'], {}], ['documents.revision_stamp', ['d1'], {}]]],
]
