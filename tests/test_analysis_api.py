from pathlib import Path
from unittest.mock import Mock
import pytest
from chordbuddy.server import Application
from test_reprocess import seed

def test_application_has_shared_analysis_admission(tmp_path):
    app=Application(tmp_path,Path.cwd());seed(app.library)
    try:
        assert hasattr(app,'analysis'),'Analyze endpoint is not integrated'
        assert app.analysis.gate is app.inference_gate
        assert hasattr(app,'rhythm'),'Optional rhythm proposal service missing'
        app.analysis.start=Mock(return_value={'kind':'analysis'})
        assert app.analyze('song',[])=={'kind':'analysis'}
        app.analysis.start.assert_called_once_with('song',[],True,'keep')
        app.analysis.start.reset_mock()
        app.analyze('song',['transcription'],False,'replace')
        app.analysis.start.assert_called_once_with('song',['transcription'],False,'replace')
    finally:app.close()

def test_failed_admission_recovery_guidance_is_visible(tmp_path,monkeypatch):
    app=Application(tmp_path,Path.cwd());seed(app.library)
    def fail(value):raise OSError('storage unavailable')
    monkeypatch.setattr(app.analysis.store,'save_job',fail)
    try:
        with pytest.raises(OSError):app.analyze('song')
        assert 'Restart' in app.state()['job']['error']
    finally:app.library.close()
