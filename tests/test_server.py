import json
from pathlib import Path
import sys
import threading
import urllib.error
import urllib.request

import pytest
from unittest.mock import patch

from chordbuddy.server import make_server


@pytest.fixture
def service(tmp_path):
    server=make_server(tmp_path,port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join()


def request(server,path,data=None,headers=None):
    defaults={'X-ChordBuddy-Token':server.app.token}
    defaults.update(headers or {})
    return urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,data=data,headers=defaults))


def test_api_rejects_bad_tokens_and_foreign_origins(service):
    for headers in [{'X-ChordBuddy-Token':'wrong'}, {'Origin':'https://example.com'}]:
        with pytest.raises(urllib.error.HTTPError) as exc:
            request(service,'/api/state',headers=headers)
        assert exc.value.code==403
    state=json.load(request(service,'/api/state'))
    assert state['setlists'][0]['name']=='Default'
    model=state['engine']['model']
    assert model['id']=='m-a-p/SheetSage2'
    assert model['revision']=='7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384'
    assert model['base_model']['id']=='m-a-p/MERT-v2-FullSong'
    assert model['license']['name']=='CC BY-NC 4.0'


def test_upload_range_and_unknown_ids(service,mp3_bytes):
    song=json.load(request(service,'/api/import?filename=Test.mp3',mp3_bytes))
    with request(service,'/api/audio/'+song['id'],headers={'Range':'bytes=10-29'}) as response:
        assert response.status==206
        assert response.read()==mp3_bytes[10:30]
        assert response.headers['Content-Range']==f'bytes 10-29/{len(mp3_bytes)}'
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(service,'/api/audio/not-a-song')
    assert exc.value.code==404
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(service,'/api/audio/'+song['id'],headers={'Range':'bytes=99999999-'})
    assert exc.value.code==416


def test_static_traversal_is_rejected_and_import_errors_are_json(service):
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(service,'/../library.sqlite3')
    assert exc.value.code==404
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(service,'/api/import?filename=bad.mp3',b'bad')
    assert exc.value.code==400
    assert 'MP3' in json.load(exc.value)['error']


def test_invalid_settings_leave_current_choice(service):
    body=json.dumps({'device':'cpu'}).encode()
    assert json.load(request(service,'/api/settings',body,{'Content-Type':'application/json'}))=={'device':'cpu','beat_flag_threshold':50,'beat_remove_threshold':0,'chord_flag_threshold':50,'chord_opacity_min':40,'chord_opacity_max':100}
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(service,'/api/settings',b'{"device":"magic"}',{'Content-Type':'application/json'})
    assert exc.value.code==400
    assert json.load(request(service,'/api/state'))['settings']['device']=='cpu'


def test_start_chord_at_measure_uses_the_guarded_document_operation(service):
    payload={'song_id':'song','chord_id':'am','measure_id':'m0','document_id':'chart','revision':4}
    with patch.object(service.app.documents,'start_chord_at_measure',return_value={'revision':5}) as start:
        result=json.load(request(service,'/api/start-chord-at-measure',json.dumps(payload).encode(),{'Content-Type':'application/json'}))
    assert result=={'revision':5}
    start.assert_called_once_with('song','am','m0',4,'chart')


@pytest.mark.parametrize('status', ['starting','running','cancelling'])
def test_busy_transcription_returns_conflict_without_creating_a_run(service, mp3_bytes, status):
    song=json.load(request(service,'/api/import?filename=Test.mp3',mp3_bytes))
    with patch.object(service.app.engine,'snapshot',return_value={'status':status}), \
            patch.object(service.app.engine,'readiness',return_value={'ready':True}), \
            patch.object(service.app.engine,'start',side_effect=RuntimeError('A transcription is already running')):
        with pytest.raises(urllib.error.HTTPError) as exc:
            request(service,'/api/transcribe',json.dumps({'song_id':song['id']}).encode())
    assert exc.value.code==409
    assert service.app.library.runs(song['id'])==[]
    assert service.app.library.song(song['id'])['status']=='imported'


def test_server_close_waits_for_worker_ingestion_before_closing_library(tmp_path, mp3_bytes):
    server=make_server(tmp_path)
    song=server.app.library.import_audio('Song.mp3',mp3_bytes)
    run=server.app.library.create_run(song['id'])
    script=tmp_path/'fixture_worker.py'
    script.write_text(f"from pathlib import Path\np=Path({str(run)!r})\n(p/'score.abc').write_text('X:1\\nK:C\\nC4|')\n")
    entered,released,callback_done,closed=threading.Event(),threading.Event(),threading.Event(),threading.Event()
    failures=[]
    def ingest(*args):
        entered.set()
        released.wait(10)
        try:
            server.app.documents.ingest(*args)
        except Exception as exc:
            failures.append(exc)
            raise
        finally:
            callback_done.set()
    server.app.engine.on_complete=ingest
    def close_server():
        server.server_close()
        closed.set()
    closer=None
    try:
        with patch.object(server.app.engine,'readiness',return_value={'ready':True}), \
                patch.object(server.app.engine,'_command',return_value=[sys.executable,'-u',str(script)]):
            server.app.engine.start(song['id'],server.app.library.source_path(song['id']),run)
            assert entered.wait(10)
            closer=threading.Thread(target=close_server)
            closer.start()
            assert not closed.wait(.2), 'SQLite closed while worker ingestion callback was still active'
            released.set()
            assert closed.wait(10)
            assert callback_done.is_set()
            assert failures==[]
    finally:
        released.set()
        if closer is not None:
            closer.join(10)
        server.app.engine._thread.join(10)
        if not closed.is_set():
            server.server_close()


class FixtureWindow:
    def __init__(self):
        self.pending=False
        self.callback=None
        self.destroyed=False
        self.messages=[]
        self.guard=None
        self.callback_ready=threading.Event()
        self.destroyed_event=threading.Event()
        self.evaluation_threads=[]
        self.message_ready=threading.Event()

    def evaluate_js(self,script,callback=None):
        self.evaluation_threads.append(threading.get_ident())
        if callback is not None:
            self.callback=callback
            self.callback_ready.set()
            return True
        if 'chordBuddyHasPendingEdits' in script:
            return self.pending
        self.messages.append(script)
        self.message_ready.set()

    def destroy(self):
        if self.guard.on_closing() is not False:
            self.destroyed=True
            self.destroyed_event.set()


def native_guard():
    from chordbuddy import __main__ as launcher
    guard_type=getattr(launcher,'NativeCloseGuard',None)
    assert guard_type is not None, 'Native pending-save closing hook is missing'
    window=FixtureWindow()
    window.guard=guard_type(window)
    window.guard.on_loaded()
    return window,window.guard


def test_native_clean_close_is_allowed():
    window,guard=native_guard()
    caller=threading.get_ident()
    assert guard.on_closing() is False
    assert window.destroyed_event.wait(5)
    assert window.callback is None
    assert caller not in window.evaluation_threads, 'JavaScript evaluation blocked the native UI closing thread'


def test_native_pending_save_vetoes_until_async_flush_succeeds():
    window,guard=native_guard()
    window.pending=True
    assert guard.on_closing() is False
    assert window.callback_ready.wait(5)
    assert callable(window.callback)
    assert not window.destroyed
    window.pending=False
    window.callback({'ok':True,'pending':[]})
    assert window.destroyed_event.wait(5)


def test_native_failed_flush_keeps_edits_and_allows_retry():
    window,guard=native_guard()
    window.pending=True
    assert guard.on_closing() is False
    assert window.callback_ready.wait(5)
    window.callback({'ok':False,'pending':[{'id':'d1','error':'Disk full'}]})
    assert window.message_ready.wait(5)
    assert not window.destroyed
    assert window.pending
    assert any('chordBuddyShowCloseError' in message and 'Disk full' in message for message in window.messages)
    window.callback=None
    window.callback_ready.clear()
    assert guard.on_closing() is False
    assert window.callback_ready.wait(5)
    assert callable(window.callback)


def test_native_close_rechecks_edits_created_after_flush():
    window,guard=native_guard()
    window.pending=True
    assert guard.on_closing() is False
    assert window.callback_ready.wait(5)
    first=window.callback
    window.callback_ready.clear()
    first({'ok':True,'pending':[]})
    assert window.callback_ready.wait(5)
    assert not window.destroyed
    assert window.callback is not first



def test_bundled_woff2_fonts_have_a_font_mime_type():
    import mimetypes
    import chordbuddy.server  # noqa: F401  registers the type
    assert mimetypes.guess_type('BricolageGrotesque.woff2')[0]=='font/woff2'
