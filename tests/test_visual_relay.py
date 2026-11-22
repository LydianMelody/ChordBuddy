import json
import queue
import socket
import sys
import threading
import types
import urllib.error
import urllib.request

import pytest

from chordbuddy.__main__ import STABLE_PORT,allow_sound_window,is_sound_window,keep_drawing_arguments,start_server
from chordbuddy.server import make_server
from chordbuddy.visual_relay import VisualRelay,stream_key


@pytest.fixture
def service(tmp_path):
    server=make_server(tmp_path,port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join()


def url(server,path):
    return f'http://127.0.0.1:{server.server_port}'+path


def request(server,path,body=None):
    data=None if body is None else json.dumps(body).encode()
    headers={'X-ChordBuddy-Token':server.app.token,'Content-Type':'application/json'}
    return urllib.request.urlopen(urllib.request.Request(url(server,path),data=data,headers=headers),timeout=5)


def listen(response):
    """The data lines of a server-sent event stream, on a queue, read in the background."""
    lines=queue.Queue()
    def read():
        try:
            for raw in response:
                line=raw.decode().rstrip('\n')
                if line.startswith('data: '):lines.put(json.loads(line[6:]))
        except Exception:
            pass
    threading.Thread(target=read,daemon=True).start()
    return lines


def wait_for(check,timeout=5):
    import time
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if check():return True
        time.sleep(0.02)
    return False


def test_relay_says_hello_for_viewers_and_carries_only_visualizer_messages():
    relay=VisualRelay();player=queue.Queue();viewer=queue.Queue()
    threading.Thread(target=relay.stream,args=('player',player.put),daemon=True).start()
    assert player.get(timeout=2)==': connected\n\n'
    assert player.get(timeout=2)=='data: {"type":"viewers","connected":0,"drawing":0}\n\n'
    threading.Thread(target=relay.stream,args=('viewer',viewer.put),daemon=True).start()
    assert viewer.get(timeout=2)==': connected\n\n'
    assert player.get(timeout=2)=='data: {"type": "hello"}\n\n'
    assert player.get(timeout=2)=='data: {"type":"viewers","connected":1,"drawing":1}\n\n'
    assert relay.send([{'type':'clock','seconds':1.5}])==1
    assert viewer.get(timeout=2)=='data: {"type":"clock","seconds":1.5}\n\n'
    assert relay.send([{'type':'perform','state':{'scene':'a'}}])==1          # a show's actions reach OBS too
    assert viewer.get(timeout=2)=='data: {"type":"perform","state":{"scene":"a"}}\n\n'
    for bad in [{'type':'mix'},'clock',None]:
        with pytest.raises(ValueError):relay.send([bad])
    relay.close()
    assert wait_for(lambda:not relay.viewers and not relay.players)


def test_player_connecting_after_a_viewer_is_greeted_at_once():
    relay=VisualRelay();viewer=queue.Queue();player=queue.Queue()
    threading.Thread(target=relay.stream,args=('viewer',viewer.put),daemon=True).start()
    assert wait_for(lambda:relay.viewers)
    threading.Thread(target=relay.stream,args=('player',player.put),daemon=True).start()
    assert player.get(timeout=2)==': connected\n\n' and player.get(timeout=2)=='data: {"type": "hello"}\n\n'
    assert player.get(timeout=2)=='data: {"type":"viewers","connected":1,"drawing":1}\n\n'
    relay.close()


def test_stream_key_is_made_once_and_kept(tmp_path):
    path=tmp_path/'visualizer-stream.key'
    assert stream_key(path) is None and not path.exists()
    key=stream_key(path,True)
    assert stream_key(path)==key==stream_key(path,True)
    path.write_text('bad key!','utf-8')
    assert stream_key(path) is None


def test_obs_viewer_gets_the_players_messages_through_the_server(service):
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(url(service,'/visual-stream?key=nothing-made-yet-000000'),timeout=5)
    assert exc.value.code==403
    address=json.load(request(service,'/api/visual-relay/address'))
    assert address['url'].startswith(url(service,'/visualizer.html?stream='))
    key=address['url'].split('stream=')[1]
    assert json.load(request(service,'/api/visual-relay/address'))['url']==address['url']      # the same address every time
    assert (service.app.library.root/'visualizer-stream.key').read_text('utf-8')==key
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(url(service,'/visual-stream?key=wrong'+key[5:]),timeout=5)
    assert exc.value.code==403
    with pytest.raises(urllib.error.HTTPError) as exc:                           # the player's side needs the session token
        urllib.request.urlopen(url(service,'/api/visual-relay/player?token=wrong'),timeout=5)
    assert exc.value.code==403

    player=listen(urllib.request.urlopen(url(service,'/api/visual-relay/player?token='+service.app.token),timeout=5))
    assert json.load(request(service,'/api/visual-relay/send',{'messages':[{'type':'clock','seconds':1}]}))=={'viewers':0}
    viewer_response=urllib.request.urlopen(url(service,'/visual-stream?key='+key),timeout=5)
    assert viewer_response.headers['Content-Type'].startswith('text/event-stream')
    viewer=listen(viewer_response)
    assert player.get(timeout=5)=={'type':'viewers','connected':0,'drawing':0}
    assert player.get(timeout=5)=={'type':'hello'}
    assert player.get(timeout=5)=={'type':'viewers','connected':1,'drawing':1}
    sent=[{'type':'scene','songId':'s1','token':'t'},{'type':'clock','seconds':12.5,'playing':True,'at':1}]
    assert json.load(request(service,'/api/visual-relay/send',{'messages':sent}))=={'viewers':1}
    assert [viewer.get(timeout=5),viewer.get(timeout=5)]==sent
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(service,'/api/visual-relay/send',{'messages':[{'type':'command','action':{}}]})
    assert exc.value.code==400


def test_the_app_keeps_one_address_between_launches(tmp_path):
    first=start_server(tmp_path/'a')
    try:
        if first.server_port!=STABLE_PORT:pytest.skip('the stable port is in use on this computer')
        second=start_server(tmp_path/'b')                 # taken: another free port, never a shared one
        try:assert second.server_port not in (0,STABLE_PORT)
        finally:second.server_close()
    finally:
        first.server_close()


def test_desktop_windows_keep_drawing_when_covered():
    args=keep_drawing_arguments(None).split()
    assert args[0]=='--disable-features=ElasticOverscroll,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling'
    assert '--disable-renderer-backgrounding' in args and '--disable-backgrounding-occluded-windows' in args
    mine=keep_drawing_arguments('--remote-debugging-port=9333 --disable-features=Foo,ElasticOverscroll').split()
    assert mine[0].endswith(',Foo') and mine.count('--remote-debugging-port=9333')==1 and sum(a.startswith('--disable-features') for a in mine)==1


def test_only_the_sound_page_stays_in_the_app():
    assert is_sound_window('http://127.0.0.1:51730/obs-sound.html')
    for url in ('https://example.com/obs-sound.html','http://example.com/obs-sound.html','http://127.0.0.1.example.com/obs-sound.html',
                'http://127.0.0.1:51730/visualizer.html','https://github.com/LydianMelody'):
        assert not is_sound_window(url)


def test_other_new_windows_still_go_where_pywebview_sends_them(monkeypatch):
    sent=[]

    class EdgeChrome:
        def on_new_window_request(self,sender,args):
            sent.append(args.get_Uri())

    class Args:
        def __init__(self,url):self.url=url
        def get_Uri(self):return self.url

    module=types.ModuleType('webview.platforms.edgechromium');module.EdgeChrome=EdgeChrome
    monkeypatch.setitem(sys.modules,'webview.platforms.edgechromium',module)
    allow_sound_window()
    EdgeChrome().on_new_window_request(None,Args('http://127.0.0.1:51730/obs-sound.html'))
    assert sent==[]
    EdgeChrome().on_new_window_request(None,Args('https://example.com/'))
    assert sent==['https://example.com/']


def test_players_hear_how_many_viewers_are_drawing():
    relay=VisualRelay();player=queue.Queue();obs=queue.Queue();other=queue.Queue()
    threading.Thread(target=relay.stream,args=('player',player.put),daemon=True).start()
    assert player.get(timeout=2)==': connected\n\n' and json.loads(player.get(timeout=2)[6:])=={'type':'viewers','connected':0,'drawing':0}
    threading.Thread(target=relay.stream,args=('viewer',obs.put),kwargs={'viewer':'obs-1'},daemon=True).start()
    threading.Thread(target=relay.stream,args=('viewer',other.put),kwargs={'viewer':'obs-2','drawing':False},daemon=True).start()
    assert wait_for(lambda:relay.status()=={'type':'viewers','connected':2,'drawing':1})
    assert relay.set_drawing('obs-1',False) and relay.status()['drawing']==0
    assert not relay.set_drawing('nobody',True)
    for bad in [(None,True),('',True),('obs-1','yes')]:
        with pytest.raises(ValueError):relay.set_drawing(*bad)
    seen=[]
    def latest():          # the player's stream delivers on its own thread: read until the newest count has arrived
        while not player.empty():
            line=player.get()
            if line.startswith('data: '):seen.append(json.loads(line[6:]))
        return seen and seen[-1]=={'type':'viewers','connected':2,'drawing':0}
    assert wait_for(latest)
    relay.close()
    assert wait_for(lambda:relay.status()['connected']==0)


def test_a_viewer_in_obs_may_only_say_whether_it_is_drawing(service):
    key=json.load(request(service,'/api/visual-relay/address'))['url'].split('stream=')[1]
    player=listen(urllib.request.urlopen(url(service,'/api/visual-relay/player?token='+service.app.token),timeout=5))
    assert player.get(timeout=5)['connected']==0
    listen(urllib.request.urlopen(url(service,'/visual-stream?key='+key+'&id=obs-a'),timeout=5))
    assert player.get(timeout=5)=={'type':'hello'} and player.get(timeout=5)=={'type':'viewers','connected':1,'drawing':1}
    def post(path,body,stream=key):
        headers={'X-ChordBuddy-Stream':stream,'Content-Type':'application/json'}
        return urllib.request.urlopen(urllib.request.Request(url(service,path),data=json.dumps(body).encode(),headers=headers),timeout=5)
    assert json.load(post('/api/visual-relay/viewer-state',{'viewer':'obs-a','drawing':False}))=={'known':True}
    assert player.get(timeout=5)=={'type':'viewers','connected':1,'drawing':0}
    for path,body,stream in [('/api/visual-relay/viewer-state',{'viewer':'obs-a','drawing':True},'wrong'+key[5:]),
                             ('/api/visual-relay/send',{'messages':[]},key)]:          # the key opens nothing else
        with pytest.raises(urllib.error.HTTPError) as exc:post(path,body,stream)
        assert exc.value.code==403


def test_stream_controls_can_stay_on_top_and_let_go(monkeypatch):
    import chordbuddy.__main__ as app
    real=app.set_topmost
    asked=[]
    monkeypatch.setattr(app,'set_topmost',lambda title,on:asked.append((title,on)) or True)
    api=app.WindowApi('http://127.0.0.1:1')
    assert api.stream_controls_on_top(1) is True and api.stream_controls_on_top(0) is True
    assert asked==[('Chord Buddy sound for OBS',True),('Chord Buddy sound for OBS',False)]
    assert real('No window has this title 7f3a',True) is False      # nothing found, nothing changed
