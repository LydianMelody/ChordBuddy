"""Download the chord and melody model (SheetSage2 and its base, MERT-v2-FullSong) from inside the app.

Both are public on Hugging Face, so no account or token is needed. They are fetched at the pinned revisions into the
app's own cache (.models/hf/hub), by the engine's Python in a separate process that the app can stop at any time.
"""
import os
from pathlib import Path
import subprocess
import threading

from .engine import MODEL_ID, MODEL_REVISION, BASE_MODEL_ID, local_environment

BASE_MODEL_REVISION = 'd8ba1c745e733b3908ce6ad16ebeb17ac7600a42'   # what SheetSage2's config.json names at MODEL_REVISION
APPROX_BYTES = 2_763_414_656                                       # both snapshots at these revisions, for the progress bar
# Without these the model cannot load; the rest of each repository (readme, benchmarks, sounds) is fetched too but not checked.
REQUIRED = {
    MODEL_ID: (MODEL_REVISION, ('config.json', 'model.safetensors', 'modeling_sheetsage2.py', 'pipeline_sheetsage2.py', 'processor_config.json')),
    BASE_MODEL_ID: (BASE_MODEL_REVISION, ('config.json', 'model.safetensors', 'modeling_mert2.py', 'preprocessor_config.json')),
}
TITLE = 'SheetSage2 chord and melody model'
ROLE = 'Works out the chords, the melody and the sections. Chord Buddy needs it to analyze a song. It is built on MERT-v2-FullSong, which is downloaded with it.'
LICENSE = 'CC BY-NC 4.0 (free for non-commercial use, with attribution), by the Music AI Project (m-a-p).'

# Run by the engine's Python: the same download the installer does, at the pinned revisions, with no token.
DOWNLOAD = ("import os,sys; sys.path.insert(0,os.getcwd()); "
            "from chordbuddy.model_cache import configure_hub_copy_fallback; configure_hub_copy_fallback(os.environ['HF_HUB_CACHE']); "
            "from huggingface_hub import snapshot_download; "
            "[snapshot_download(repo,revision=rev,cache_dir=os.environ['HF_HUB_CACHE'],token=False) for repo,rev in "
            "((sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4]))]")


def model_folder(project, ident):
    return Path(project) / '.models' / 'hf' / 'hub' / ('models--' + ident.replace('/', '--'))


def snapshot(project, ident):
    return model_folder(project, ident) / 'snapshots' / REQUIRED[ident][0]


def missing_files(project):
    return [f'{ident}/{name}' for ident, (_, names) in REQUIRED.items() for name in names if not (snapshot(project, ident) / name).is_file()]


def bytes_on_disk(project):
    """What has arrived so far: finished files in the snapshots, and files still downloading in the blobs folders."""
    total = 0
    for ident in REQUIRED:
        folder = model_folder(project, ident)
        for sub in ('snapshots', 'blobs'):
            for path in (folder / sub).rglob('*') if (folder / sub).is_dir() else ():
                try:
                    if path.is_file():
                        total += path.stat().st_size
                except OSError:
                    pass
    return total


def default_spawn(argv, cwd, env):
    if os.name == 'nt':
        from .owned_process import OwnedProcess
        return OwnedProcess(argv, cwd=cwd, env=env)
    return subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')


class TranscriptionModels:
    def __init__(self, project, python=None, spawn=default_spawn):
        self.project = Path(project).resolve()
        self.python = Path(python) if python else self.project / 'runtime' / 'python.exe'
        self.spawn = spawn
        self.lock = threading.RLock()
        self.thread = None
        self.process = None
        self.cancelled = False
        self.error = None

    def ready(self):
        return not missing_files(self.project)

    def status(self):
        with self.lock:
            active = bool(self.thread and self.thread.is_alive())
            ready = self.ready()
            done = min(bytes_on_disk(self.project), APPROX_BYTES) if active or not ready else APPROX_BYTES
            return {'id': 'transcription', 'title': TITLE, 'role': ROLE, 'license': LICENSE, 'ready': ready,
                    'downloading': active, 'error': None if active else self.error, 'environment': self.python.is_file(),
                    'bytes_total': APPROX_BYTES, 'bytes_present': done,
                    'progress': {'done': done, 'size': APPROX_BYTES, 'path': 'SheetSage2 and MERT-v2-FullSong', 'source': 'huggingface.co'} if active else None,
                    'folders': [{'repo': ident, 'revision': rev, 'url': f'https://huggingface.co/{ident}/tree/{rev}',
                                 'path': str(snapshot(self.project, ident).relative_to(self.project))} for ident, (rev, _) in REQUIRED.items()],
                    'missing': missing_files(self.project)}

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return self.status()
            if not self.python.is_file():
                raise ValueError('The transcription engine is not installed. Run InstallWindowsDependencies.cmd first.')
            self.cancelled = False
            self.error = None
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        return self.status()

    def cancel(self):
        with self.lock:
            self.cancelled = True
            process = self.process
        if process is not None:
            try:
                (process.cancel if hasattr(process, 'cancel') else process.kill)()
            except OSError:
                pass
        return self.status()

    def wait(self):
        thread = self.thread
        if thread:
            thread.join()

    def _run(self):
        argv = [str(self.python), '-u', '-c', DOWNLOAD, MODEL_ID, MODEL_REVISION, BASE_MODEL_ID, BASE_MODEL_REVISION]
        env = local_environment(self.project)
        for name in ('HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PYTHONPATH'):
            env.pop(name, None)
        tail = []
        try:
            with self.lock:
                if self.cancelled:
                    return
                self.process = process = self.spawn(argv, str(self.project), env)
            for line in process.stdout:
                line = line.strip()
                if line:
                    tail = (tail + [line])[-6:]
            code = process.wait()
            if hasattr(process, 'close'):
                process.close()
            with self.lock:
                if self.cancelled:
                    self.error = None
                elif code or not self.ready():
                    self.error = explain(tail)
        except Exception as exc:          # could not start the process at all
            with self.lock:
                self.error = str(exc)
        finally:
            with self.lock:
                self.process = None


def explain(tail):
    text = ' '.join(tail).lower()
    if any(word in text for word in ('connection', 'timed out', 'timeout', 'getaddrinfo', 'resolve', 'offline', 'ssl')):
        return 'Could not reach huggingface.co. Check your internet connection and try again.'
    if 'no space' in text or 'disk' in text:
        return 'There is not enough free disk space (the model needs about 2.8 GB).'
    return 'The download stopped: ' + (tail[-1] if tail else 'unknown error') + ' Try again; finished files are kept.'
