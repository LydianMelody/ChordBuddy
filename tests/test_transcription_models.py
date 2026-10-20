import io
import threading
from pathlib import Path

from chordbuddy import transcription_models as tm


class FakeProcess:
    def __init__(self, lines, code=0, on_wait=None, block=None):
        self.stdout = io.StringIO(''.join(line + '\n' for line in lines))
        self.code, self.on_wait, self.block, self.killed = code, on_wait, block, False

    def wait(self, timeout=None):
        if self.block:
            self.block.wait(5)
        if self.on_wait:
            self.on_wait()
        return self.code

    def kill(self):
        self.killed = True
        if self.block:
            self.block.set()


def install(project):
    for ident, (rev, names) in tm.REQUIRED.items():
        folder = tm.snapshot(project, ident)
        folder.mkdir(parents=True, exist_ok=True)
        for name in names:
            (folder / name).write_text('x')


def manager(tmp_path, process, calls=None):
    python = tmp_path / 'runtime' / 'python.exe'
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text('')

    def spawn(argv, cwd, env):
        if calls is not None:
            calls.append((argv, cwd, env))
        return process
    return tm.TranscriptionModels(tmp_path, python, spawn)


def test_missing_until_every_required_file_is_in_the_pinned_snapshot(tmp_path):
    models = manager(tmp_path, None)
    status = models.status()
    assert status['ready'] is False and status['downloading'] is False and status['environment'] is True
    assert [f['repo'] for f in status['folders']] == ['m-a-p/SheetSage2', 'm-a-p/MERT-v2-FullSong']
    assert status['folders'][0]['path'].endswith(tm.MODEL_REVISION)
    install(tmp_path)
    (tm.snapshot(tmp_path, tm.BASE_MODEL_ID) / 'model.safetensors').unlink()
    assert models.ready() is False and models.status()['missing'] == ['m-a-p/MERT-v2-FullSong/model.safetensors']
    install(tmp_path)
    assert models.ready() is True and models.status()['bytes_present'] == tm.APPROX_BYTES


def test_download_runs_the_engine_python_anonymously_at_the_pinned_revisions(tmp_path, monkeypatch):
    monkeypatch.setenv('HF_TOKEN', 'stale')
    monkeypatch.setenv('HF_HUB_OFFLINE', '1')
    calls = []
    models = manager(tmp_path, FakeProcess(['Fetching 40 files'], on_wait=lambda: install(tmp_path)), calls)
    models.start()
    models.wait()
    argv, cwd, env = calls[0]
    assert argv[-4:] == [tm.MODEL_ID, tm.MODEL_REVISION, tm.BASE_MODEL_ID, tm.BASE_MODEL_REVISION]
    assert 'token=False' in argv[3] and Path(cwd) == tmp_path.resolve()
    assert 'HF_TOKEN' not in env and 'HF_HUB_OFFLINE' not in env
    assert Path(env['HF_HUB_CACHE']) == tmp_path.resolve() / '.models' / 'hf' / 'hub'
    status = models.status()
    assert status['ready'] is True and status['error'] is None


def test_a_failed_download_explains_itself_and_can_be_retried(tmp_path):
    models = manager(tmp_path, FakeProcess(['requests.exceptions.ConnectionError: getaddrinfo failed'], code=1))
    models.start()
    models.wait()
    assert 'internet connection' in models.status()['error']
    models.spawn = lambda *a: FakeProcess([], on_wait=lambda: install(tmp_path))
    models.start()
    models.wait()
    assert models.status()["error"] is None and models.ready()


def test_stop_kills_the_download_without_reporting_an_error(tmp_path):
    gate = threading.Event()
    process = FakeProcess([], code=1, block=gate)
    models = manager(tmp_path, process)
    models.start()
    for _ in range(100):
        if models.process is not None:
            break
        threading.Event().wait(.01)
    assert models.status()['downloading'] is True
    models.cancel()
    models.wait()
    assert process.killed and models.status()['error'] is None and models.status()['downloading'] is False


def test_without_the_engine_the_download_cannot_start(tmp_path):
    models = tm.TranscriptionModels(tmp_path, tmp_path / 'nothing.exe', lambda *a: None)
    assert models.status()['environment'] is False
    try:
        models.start()
    except ValueError as exc:
        assert 'InstallWindowsDependencies' in str(exc)
    else:
        raise AssertionError('expected a ValueError')
