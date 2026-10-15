"""Pure admission checks: no server, audio, file mutation, or fixture cleanup."""
import importlib.util
from pathlib import Path
import sys,threading
from types import SimpleNamespace
import pytest

def harness():
    root=Path(__file__).resolve().parents[1]/'qa/p14'
    spec=importlib.util.spec_from_file_location('practice_qa_serve',root/'serve.py')
    module=importlib.util.module_from_spec(spec)
    sys.path.insert(0,str(root))
    try:spec.loader.exec_module(module)
    finally:sys.path.remove(str(root))
    return module

def test_fixture_deletion_permission_is_enforced_on_every_admission():
    serve=harness()
    for scenario in ('success','existing','fail','cancel'):
        state={'count':0,'calls':[]}
        db=SimpleNamespace(execute=lambda *_:SimpleNamespace(fetchone=lambda:(state['count'],)))
        def analyze():state['calls'].append('analyze')
        def separate():state['calls'].append('separate')
        app=SimpleNamespace(library=SimpleNamespace(db=db,lock=threading.RLock()),analyze=analyze,separate=separate)
        serve.install_admission_guard(app,scenario,False)
        app.analyze();state['count']=1
        if scenario in ('fail','cancel'):app.analyze()
        else:
            with pytest.raises(ValueError,match='deletion approval'):app.analyze()
        with pytest.raises(ValueError,match='deletion approval'):app.separate()
        assert state['calls']==(['analyze','analyze'] if scenario in ('fail','cancel') else ['analyze'])
