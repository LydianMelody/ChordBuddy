import json
import os
from unittest.mock import patch
from chordbuddy.engine import Engine, MODEL_REVISION


def test_portable_engine_uses_bundled_interpreter_and_ffmpeg(tmp_path):
    (tmp_path/'portable.json').write_text('{}')
    (tmp_path/'runtime').mkdir()
    (tmp_path/'runtime'/'python.exe').touch()
    (tmp_path/'runtime'/'chordbuddy-ready.json').write_text(json.dumps({'python':'3.11','revision':MODEL_REVISION}))
    (tmp_path/'tools').mkdir()
    (tmp_path/'tools'/'ffmpeg.exe').touch()
    engine=Engine(tmp_path,lambda *args:None)
    assert engine.python_path==tmp_path/'runtime'/'python.exe'
    with patch('shutil.which',return_value=None):
        assert engine.readiness()['ready']
    assert engine._command('input.mp3','out','cpu')[0]==str(tmp_path/'runtime'/'python.exe')


def test_portable_environment_keeps_model_access_offline(tmp_path):
    from portable_start import configure
    (tmp_path/'portable.json').write_text('{}')
    with patch.dict(os.environ,{'PATH':'system-path','HF_TOKEN':'not-for-transfer'},clear=False):
        root=configure(tmp_path)
        assert root==tmp_path/'Data'
        assert os.environ['PATH'].split(os.pathsep)[0]==str(tmp_path/'tools')
        assert os.environ['HF_HUB_OFFLINE']=='1'
        assert 'HF_TOKEN' not in os.environ
