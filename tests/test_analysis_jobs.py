import importlib.util
import threading
import pytest
from chordbuddy.library import Library
from chordbuddy.inference_jobs import InferenceGate
from test_reprocess import seed

def coordinator(tmp_path,runner):
    assert importlib.util.find_spec('chordbuddy.analysis'), 'Unified coordinator missing'
    from chordbuddy.analysis import AnalysisCoordinator
    lib=Library(tmp_path);seed(lib)
    return lib,AnalysisCoordinator(tmp_path,lib,None,None,None,None,InferenceGate(),stage_runner=runner)

def test_partial_results_survive_failure(tmp_path):
    calls=[]
    def runner(kind,*args):
        calls.append(kind)
        if kind=='separation':raise ValueError('No GPU')
        return {'id':kind}
    lib,job=coordinator(tmp_path,runner);job.start('song');job.wait()
    assert calls==['source','separation','transcription','chart']
    assert job.snapshot()['status']=='partial'
    assert job.gate.owner is None
    lib.close()

def test_cancel_waits_for_child(tmp_path):
    entered=threading.Event();release=threading.Event()
    def runner(kind,*args):entered.set();release.wait(5);args[-1]();return {'id':kind}
    lib,job=coordinator(tmp_path,runner);snap=job.start('song');assert entered.wait(2)
    job.cancel(snap['id']);assert job.gate.owner is not None
    with pytest.raises(RuntimeError):job.start('song')
    release.set();job.wait();assert job.snapshot()['status']=='cancelled' and job.gate.owner is None
    lib.close()

def test_terminal_persist_failure_retains_gate(tmp_path,monkeypatch):
    lib,job=coordinator(tmp_path,lambda kind,*args:{'id':kind})
    original=job.store.save_job
    def save(value):
        if value['status']=='completed':raise OSError('disk full')
        original(value)
    monkeypatch.setattr(job.store,'save_job',save)
    job.start('song');job.wait()
    assert job.gate.owner is not None and 'persist' in job.snapshot()['error'].lower()
    lib.close()

def test_source_changes_before_publish(tmp_path):
    lib=None
    def runner(kind,*args):
        if kind=='source':lib.source_path('song').write_bytes(b'changed')
        return {'id':kind}
    lib,job=coordinator(tmp_path,runner);job.start('song');job.wait()
    assert job.snapshot()['status']=='failed'
    lib.close()

def test_restart_marks_interrupted(tmp_path):
    lib,job=coordinator(tmp_path,lambda *args:None)
    job.store.save_job({'id':'old','status':'running'})
    job.recover_interrupted()
    assert 'interrupted' in lib.db.execute('SELECT snapshot FROM analysis_jobs').fetchone()[0]
    lib.close()

def test_transcription_adapter_passes_complete_options_and_reuses_cache(tmp_path,monkeypatch):
    import json
    from unittest.mock import Mock
    from chordbuddy.documents import DocumentStore
    from chordbuddy.separation_contract import file_hash
    from chordbuddy.confidence import validate_confidence_settings
    lib,job=coordinator(tmp_path,None);job.documents=DocumentStore(lib)
    job.job={'id':'job','song_id':'song','status':'running','stage':'transcription','stages':{}}
    job.source_hash=file_hash(lib.source_path('song'));job.prepared=lib.source_path('song')
    monkeypatch.setattr('chordbuddy.analysis.transcription_recipe',lambda *args:{'fixture':'model'})
    calls=[]
    def start(song_id,source,run,device):
        calls.append(1);options=json.loads((run/'run-options.json').read_text())
        validate_confidence_settings(options['confidence'])
        (run/'score.abc').write_text('X:1\nK:C\nC4|')
        (run/'beat.lab').write_text('0 1 4 4\n1 2 4 4\n')
        job.engine_result=(song_id,run,'completed',None)
    job.engine=Mock(start=start,wait=lambda:None)
    ref=job.run_stage('transcription','job','owner',{'manifest_sha256':'prepared'},lambda:None)
    again=job.run_stage('transcription','job','owner',{'manifest_sha256':'prepared'},lambda:None)
    assert ref==again and len(calls)==1
    chart=job.run_stage('chart','job','owner',{'manifest_sha256':'prepared'},lambda:None)
    assert chart['kind']=='chart'
    assert job.run_stage('chart','job','owner',{'manifest_sha256':'prepared'},lambda:None)==chart
    lib.close()

def test_child_terminal_persistence_failure_retains_owner(tmp_path):
    job=None
    def runner(kind,*args):
        if kind=='separation':
            job.terminal_error='Child terminal state could not persist'
            raise OSError('disk full')
        return {'id':kind}
    lib,job=coordinator(tmp_path,runner);job.start('song');job.wait()
    assert job.gate.owner is not None
    assert 'transcription' not in job.snapshot()['stages']
    lib.close()

def test_admission_failure_keeps_gate_if_terminal_save_also_fails(tmp_path,monkeypatch):
    lib,job=coordinator(tmp_path,lambda kind,*args:{'id':kind})
    def fail(value):raise OSError('persistent disk failure')
    monkeypatch.setattr(job.store,'save_job',fail)
    with pytest.raises(OSError):job.start('song')
    assert job.gate.owner is not None
    assert 'persist' in job.snapshot()['error'].lower()
    lib.close()

def test_edit_during_inference_keeps_chart(tmp_path,monkeypatch):
    import json
    from unittest.mock import Mock
    from chordbuddy.documents import DocumentStore
    from chordbuddy.separation_contract import file_hash
    from test_reprocess import ingest
    lib,job=coordinator(tmp_path,None);job.documents=DocumentStore(lib)
    old=ingest(job.documents)
    original=next(d for d in job.documents.for_song('song') if d['kind']=='chart')
    job.job={'id':'job','song_id':'song','status':'running','stage':'transcription','stages':{}}
    job.source_hash=file_hash(lib.source_path('song'));job.prepared=lib.source_path('song')
    monkeypatch.setattr('chordbuddy.analysis.transcription_recipe',lambda *args:{'fixture':'model'})
    def start(song_id,source,run,device):
        edited=job.documents.get(original['id']);edited['content']['sections'][0]['lyrics']='Typed while inference runs'
        job.documents.save(original['id'],edited['content'],'Live typing',edited['revision'])
        (run/'score.abc').write_text('X:1\nK:C\nC4|');job.engine_result=(song_id,run,'completed',None)
    job.engine=Mock(start=start,wait=lambda:None)
    job.run_stage('transcription','job','owner',{'manifest_sha256':'prepared'},lambda:None)
    retained=job.documents.get(original['id'])
    assert retained['kept'] and retained['run_id']==old
    assert retained['content']['sections'][0]['lyrics']=='Typed while inference runs'
    assert retained['can_undo'];lib.close()
