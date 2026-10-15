import ctypes,json,os,threading,time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import pytest
from chordbuddy.confidence import _write,install_capture,confidence_defaults
from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.separation_store import SeparationStore
from chordbuddy.playback_ready import PlaybackReadiness
from test_reprocess import seed,ingest,edited_chart

@contextmanager
def deny_replace(path):
    if os.name!='nt':pytest.skip('Windows file-sharing reproduction')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_void_p]
    kernel.CreateFileW.restype=ctypes.c_void_p;kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.CreateFileW(str(path),0x80000000,3,None,3,0,None)
    assert handle!=ctypes.c_void_p(-1).value
    released=False
    def release():
        nonlocal released
        if not released:released=True;kernel.CloseHandle(handle)
    try:yield release
    finally:release()

def test_identical_confidence_rewrite_survives_windows_reader(tmp_path):
    path=tmp_path/'confidence.json';value={'filter_status':'unchanged','beats':[1]};_write(path,value)
    with deny_replace(path):_write(path,value)
    assert json.loads(path.read_text())==value

def test_changed_confidence_retries_short_windows_sharing_block(tmp_path):
    path=tmp_path/'confidence.json';_write(path,{'value':'old'})
    with deny_replace(path) as release:
        timer=threading.Timer(.1,release);timer.start()
        try:_write(path,{'value':'new'})
        finally:timer.join()
    assert json.loads(path.read_text())=={'value':'new'}

def test_permanent_confidence_lock_preserves_original_and_useful_error(tmp_path):
    path=tmp_path/'confidence.json';_write(path,{'value':'old'})
    with deny_replace(path),pytest.raises(PermissionError,match='confidence metadata'):_write(path,{'value':'new'})
    assert json.loads(path.read_text())=={'value':'old'}
    assert path.with_name(path.name+'.tmp').exists()

def test_export_error_is_not_masked_by_error_sidecar_failure(tmp_path,monkeypatch):
    from chordbuddy import confidence
    calls=[]
    def writer(*args):
        calls.append(args)
        if len(calls)>1:raise PermissionError('sidecar blocked')
    def export(*args,**kwargs):raise ValueError('original notation failure')
    monkeypatch.setattr(confidence,'_write',writer)
    pipeline=SimpleNamespace(constrained_prompt_generate=lambda:None,export_result=export)
    with install_capture(SimpleNamespace(tokenizer=None),tmp_path,confidence_defaults(),pipeline=pipeline):
        with pytest.raises(ValueError,match='original notation failure'):pipeline.export_result({'events':[]},None,tmp_path,1)

def test_legacy_chart_validated_stems_unlock_without_promoting_provenance(tmp_path):
    lib=Library(tmp_path);seed(lib);documents=DocumentStore(lib);run=ingest(documents);edited=edited_chart(documents)
    store=AnalysisStore(lib);sep=SeparationStore(lib)
    sep.get_song_state=lambda song:{'active':{'run_id':'saved','song_id':song,'frames':882000},'error':None}
    reader=PlaybackReadiness(store,sep)
    before=[tuple(r) for r in lib.db.execute('SELECT * FROM edits')]
    try:
        state=reader.state('song',{'kind':'analysis','song_id':'song','status':'partial','error':'confidence blocked'})
        assert state['ready'] and state['legacy'] and state['active']['run_id']=='saved'
        assert state['analysis_id'] is None
        assert [tuple(r) for r in lib.db.execute('SELECT * FROM edits')]==before
        assert lib.db.execute('SELECT count(*) FROM analysis_stages').fetchone()[0]==0
        assert not reader.state('song',{'kind':'analysis','song_id':'song','status':'running'})['ready']
        sep.get_song_state=lambda song:{'active':None,'error':'Source changed'}
        assert not reader.state('song')['ready']
    finally:lib.close()

def test_failed_first_transcription_with_stems_is_not_legacy_success(tmp_path):
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib);ingest(docs,status='failed')
    sep=SeparationStore(lib);sep.get_song_state=lambda song:{'active':{'run_id':'saved'}}
    try:assert not PlaybackReadiness(AnalysisStore(lib),sep).state('song')['ready']
    finally:lib.close()

def test_separation_store_initialization_does_not_commit_outer_savepoint(tmp_path):
    lib=Library(tmp_path);seed(lib);SeparationStore(lib)
    try:
        with pytest.raises(ValueError,match='rollback sentinel'):
            with lib.transaction() as db:
                db.execute("UPDATE songs SET title='Must roll back' WHERE id='song'")
                with lib.transaction():SeparationStore(lib)
                raise ValueError('rollback sentinel')
        assert lib.song('song')['title']=='Test'
    finally:lib.close()

def test_legacy_fallback_rejects_known_contrary_source_provenance(tmp_path):
    from chordbuddy.separation_contract import file_hash
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib);run=ingest(docs)
    store=AnalysisStore(lib);asset=lib.folder('song')/'proof.json';asset.write_text('{}')
    store.publish('song','transcription',{'source_sha256':file_hash(lib.source_path('song'))},{'run_id':run,'assets':[{'path':str(asset.relative_to(lib.root)),'sha256':file_hash(asset)}]})
    sep=SeparationStore(lib);sep.get_song_state=lambda song:{'active':{'run_id':'saved'}}
    try:
        lib.source_path('song').write_bytes(b'other recording')
        assert not PlaybackReadiness(store,sep).state('song')['ready']
    finally:lib.close()
