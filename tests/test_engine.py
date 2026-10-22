import json
import os
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

try:
    from chordbuddy.engine import Engine, PROGRESS_PREFIX, discover_outputs, local_environment
except ImportError:
    Engine = None
    PROGRESS_PREFIX = "CHORDBUDDY_PROGRESS "
    discover_outputs = None
    local_environment = None


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Engine, "Real subprocess engine is not implemented")
        if os.environ.get('CHORDBUDDY_RETAIN_TEST_ARTIFACTS')=='1':
            # Keep execution evidence under the caller's configured project-local
            # TMP directory; Windows sync clients can hold these after process exit.
            self.root=Path(tempfile.mkdtemp(prefix='engine-test-'))
        else:
            self.temp = tempfile.TemporaryDirectory()
            self.addCleanup(self.temp.cleanup)
            self.root = Path(self.temp.name)
        self.audio = self.root / "song.mp3"
        self.audio.write_bytes(b"explicit test fixture, not real audio")
        self.run = self.root / "run"
        self.done = threading.Event()
        self.results = []
        def complete(*args):
            self.results.append(args)
            self.done.set()
        self.engine = Engine(self.root, complete)
        self.addCleanup(self.engine.cancel)

    def fixture_worker(self, body):
        script = self.root / "fixture_worker.py"
        script.write_text("import json,time\nfrom pathlib import Path\n" + body, encoding="utf8")
        return patch.object(self.engine, "_command", return_value=[sys.executable, "-u", str(script)])

    def await_completion(self):
        self.assertTrue(self.done.wait(10), "Subprocess failed to complete")
        return self.engine.snapshot()

    def test_dependency_missing_is_actionable_and_start_is_rejected(self):
        status = self.engine.readiness()
        self.assertFalse(status["ready"])
        self.assertIn("setup_engine.py", status["message"])
        with self.assertRaisesRegex(RuntimeError, "setup_engine.py"):
            self.engine.start("s1", self.audio, self.run)

    def test_readiness_says_whether_the_installer_kept_a_working_gpu(self):
        from chordbuddy.engine import MODEL_REVISION
        (self.root / "portable.json").write_text("{}", encoding="utf8")
        (self.root / "runtime").mkdir()
        (self.root / "runtime" / "python.exe").write_bytes(b"")
        (self.root / "tools").mkdir()
        (self.root / "tools" / "ffmpeg.exe").write_bytes(b"")
        marker = self.root / "runtime" / "chordbuddy-ready.json"
        for device, gpu in (("cuda", True), ("cpu", False)):
            marker.write_text(json.dumps({"python": "3.11", "revision": MODEL_REVISION, "device": device}), encoding="utf8")
            status = self.engine.readiness()
            self.assertTrue(status["ready"])
            self.assertIs(status["gpu"], gpu)

    def test_real_shaped_progress_and_discovered_outputs(self):
        body = (
            f"print({PROGRESS_PREFIX!r} + json.dumps(dict(stage='decoding',window=2,windows=3,tokens=64)),flush=True)\n"
            "print('ordinary model log',flush=True)\n"
            f"output=Path({str(self.run)!r});output.mkdir(parents=True,exist_ok=True)\n"
            "(output/'score.abc').write_text('X:1\\nK:C\\nC D E F|')\n"
            "(output/'events.json').write_text('[]')\n"
            "time.sleep(.2)\n"
        )
        with self.fixture_worker(body), patch.object(self.engine, "readiness", return_value={"ready":True,"message":"Test fixture"}):
            self.engine.start("s1", self.audio, self.run)
            job = self.await_completion()
        self.assertEqual(job["status"], "completed")
        self.assertEqual((job["window"], job["windows"], job["tokens"]), (2,3,64))
        self.assertEqual(job["outputs"], ["events.json", "score.abc"])
        self.assertEqual(self.results[0][2:], ("completed", None))
        self.assertTrue((self.run/'worker.log').exists())

    def test_failure_keeps_partial_real_outputs_and_error(self):
        body = (
            f"output=Path({str(self.run)!r});output.mkdir(parents=True,exist_ok=True)\n"
            "(output/'chords.lab').write_text('0 1 C:maj')\n"
            f"print({PROGRESS_PREFIX!r}+json.dumps(dict(stage='error',error='ABC generation failed')),flush=True)\n"
            "raise SystemExit(1)\n"
        )
        with self.fixture_worker(body), patch.object(self.engine, "readiness", return_value={"ready":True,"message":"Test fixture"}):
            self.engine.start("s1", self.audio, self.run)
            job = self.await_completion()
        self.assertEqual(job["status"], "partial")
        self.assertIn("ABC generation failed", job["error"])
        self.assertEqual(self.results[0][2], "partial")

    def test_cancel_stops_subprocess_and_rejects_overlapping_job(self):
        with self.fixture_worker("print('started',flush=True)\ntime.sleep(30)\n"), patch.object(self.engine, "readiness", return_value={"ready":True,"message":"Test fixture"}):
            self.engine.start("s1", self.audio, self.run)
            with self.assertRaisesRegex(RuntimeError, "already"):
                self.engine.start("s2", self.audio, self.root/'other')
            job = self.engine.cancel()
            self.assertIn(job["status"], ("cancelling", "cancelled"))
            job = self.await_completion()
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(len(self.results), 1)

    def test_success_without_outputs_is_failure(self):
        with self.fixture_worker("print('no output')\n"), patch.object(self.engine, "readiness", return_value={"ready":True,"message":"Test fixture"}):
            self.engine.start("s1", self.audio, self.run)
            job = self.await_completion()
        self.assertEqual(job["status"], "failed")
        self.assertIn("No transcription", job["error"])

    def test_output_discovery_excludes_logs_and_symlinks(self):
        self.run.mkdir()
        (self.run/'score.abc').write_text('X:1')
        (self.run/'worker.log').write_text('log')
        (self.run/'result.json').write_text('{}')
        (self.run/'tokens.json').write_text('[]')
        (self.run/'transcription.mid').write_bytes(b'MThd')
        self.assertEqual(discover_outputs(self.run), ['score.abc','transcription.mid'])

    def test_cache_and_token_storage_override_inherited_home_paths(self):
        with patch.dict('os.environ', {'HF_TOKEN_PATH':'C:/outside/token','HF_ASSETS_CACHE':'C:/outside/assets'}):
            env = local_environment(self.root)
        for name in ('HF_HOME','HF_HUB_CACHE','HF_MODULES_CACHE','HF_TOKEN_PATH','HF_ASSETS_CACHE',
                     'TORCH_HOME','TMP','PIP_CACHE_DIR'):
            self.assertTrue(Path(env[name]).is_relative_to(self.root / '.models'), name)

    def test_log_open_failure_stops_child_and_closes_pipe_before_callback(self):
        real_open, real_popen = Path.open, subprocess.Popen
        children, callback_state = [], []
        def open_file(path, *args, **kwargs):
            if path.name == 'worker.log':
                raise OSError('disk full opening worker.log')
            return real_open(path, *args, **kwargs)
        def launch(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child
        def complete(*args):
            callback_state.append((children[0].poll(), children[0].stdout.closed))
            self.done.set()
        self.engine.on_complete = complete
        try:
            with self.fixture_worker('time.sleep(30)\n'), patch.object(self.engine, 'readiness', return_value={'ready':True}), \
                    patch('chordbuddy.engine.subprocess.Popen', side_effect=launch), patch.object(Path, 'open', open_file):
                self.engine.start('s1', self.audio, self.run)
                job = self.await_completion()
            self.assertEqual(job['status'], 'failed')
            self.assertIn('disk full', job['error'])
            self.assertIsNotNone(callback_state[0][0], 'Callback ran while inference process was still alive')
            self.assertTrue(callback_state[0][1], 'Worker stdout was not closed')
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
                child.stdout.close()

    def test_failed_requested_download_does_not_leave_ready_marker(self):
        import setup_engine
        fake_module = self.root / 'setup_engine.py'
        def create_environment(target):
            target.mkdir()
        def installer(command, env, cwd):
            if '-c' in command and 'snapshot_download' in command[-1]:
                raise subprocess.CalledProcessError(1, command)
        with patch.object(setup_engine, '__file__', str(fake_module)), patch.object(setup_engine.venv.EnvBuilder, 'create', side_effect=create_environment), \
                patch.object(setup_engine, 'run', side_effect=installer), patch.dict('os.environ'), \
                patch('sys.stdout', new_callable=io.StringIO), patch('sys.stderr', new_callable=io.StringIO):
            result = setup_engine.main(['--download'])
        self.assertEqual(result, 1)
        self.assertFalse((self.root / '.engine-venv' / 'chordbuddy-ready.json').exists(), 'Failed requested download marked the engine ready')


if __name__ == '__main__':
    unittest.main()
