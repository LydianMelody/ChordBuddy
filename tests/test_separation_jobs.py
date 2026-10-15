import threading
import time
import pytest
from test_separation_store import seed
from chordbuddy.separation import SeparationManager
from chordbuddy.inference_jobs import InferenceGate
def test_cancel_before_pipeline_finishes_preserves_library(tmp_path):
    lib,store=seed(tmp_path);entered=threading.Event()
    def pipeline(manager,run):
        entered.set()
        while not manager.cancelled.wait(.01):pass
        manager.check_cancel()
    manager=SeparationManager(tmp_path,store,InferenceGate(),pipeline=pipeline,recipe_factory=lambda:{'test':1})
    job=manager.start('song','cpu')
    assert entered.wait(3)
    manager.cancel(job['id']);manager.wait()
    assert manager.snapshot()['status']=='cancelled'
    assert lib.song('song')['status']=='imported'
    assert store.get_song_state('song')['active'] is None
    lib.close()
def test_pipeline_failure_persists_and_releases_gate(tmp_path):
    lib,store=seed(tmp_path);gate=InferenceGate()
    def fail(manager,run):raise ValueError('fixture failure')
    manager=SeparationManager(tmp_path,store,gate,pipeline=fail,recipe_factory=lambda:{'test':1})
    manager.start('song','cpu');manager.wait()
    assert manager.snapshot()['status']=='failed'
    assert 'fixture failure' in manager.snapshot()['error']
    assert gate.try_acquire('test','s','j')
    lib.close()

