"""Manage one isolated real SheetSage2 inference subprocess at a time."""
from collections import deque
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

PROGRESS_PREFIX = "CHORDBUDDY_PROGRESS "
MODEL_ID = "m-a-p/SheetSage2"
MODEL_REVISION = "7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384"
MODEL_URL = f"https://huggingface.co/{MODEL_ID}"
BASE_MODEL_ID = "m-a-p/MERT-v2-FullSong"
BASE_MODEL_URL = f"https://huggingface.co/{BASE_MODEL_ID}"
MODEL_LICENSE = "CC BY-NC 4.0"
MODEL_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/"
ACTIVE_STATUSES = {"starting", "running", "cancelling"}


def model_attribution():
    """Public provenance for the exact engine packaged with Chord Buddy."""
    return {
        "name": "SheetSage2",
        "id": MODEL_ID,
        "revision": MODEL_REVISION,
        "url": MODEL_URL,
        "base_model": {"name": "MERT-v2-FullSong", "id": BASE_MODEL_ID, "url": BASE_MODEL_URL},
        "license": {"name": MODEL_LICENSE, "url": MODEL_LICENSE_URL},
        "citation": [
            {"name": "YuE", "url": "https://arxiv.org/abs/2503.08638"},
            {"name": "MERT", "url": "https://proceedings.iclr.cc/paper_files/paper/2024/hash/33dffa2e3d2ab74a783d1a8c292f66d9-Abstract-Conference.html"},
        ],
        "notice": "Chord Buddy uses the model to create an editable draft from your recording. Review the result before sharing or performing from it.",
    }


def local_environment(project_dir):
    """Keep Hugging Face, Torch, pip, temporary files and bytecode local."""
    project = Path(project_dir).resolve()
    cache = project / ".models"
    env = os.environ.copy()
    env.update({"HF_HOME": str(cache / "hf"), "HF_HUB_CACHE": str(cache / "hf" / "hub"),
                "HF_MODULES_CACHE": str(cache / "modules"), "HF_XET_CACHE": str(cache / "xet"),
                "HF_TOKEN_PATH": str(cache / "hf" / "token"), "HF_ASSETS_CACHE": str(cache / "hf" / "assets"),
                "HF_DATASETS_CACHE": str(cache / "hf" / "datasets"),
                "TORCH_HOME": str(cache / "torch"), "XDG_CACHE_HOME": str(cache / "cache"),
                "PIP_CACHE_DIR": str(cache / "pip"), "TMP": str(cache / "tmp"),
                "TEMP": str(cache / "tmp"), "TMPDIR": str(cache / "tmp"),
                "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})
    for name in ("tmp", "hf", "modules", "torch", "cache", "pip", "xet"):
        (cache / name).mkdir(parents=True, exist_ok=True)
    if (project / "tools" / "ffmpeg.exe").is_file():
        env["PATH"] = str(project / "tools") + os.pathsep + env.get("PATH", "")
    env.pop("TRANSFORMERS_CACHE", None)
    return env


def discover_outputs(run_dir):
    """Return user documents only; metadata/logs are retained but not editors."""
    root = Path(run_dir).resolve()
    if not root.is_dir():
        return []
    return sorted(path.name for path in root.iterdir()
                  if path.is_file() and not path.is_symlink()
                  and (path.suffix.lower() in {".abc", ".mid", ".midi", ".lab"}
                       or path.name == "events.json"))


class Engine:
    def __init__(self, project_dir, on_complete):
        self.project_dir = Path(project_dir).resolve()
        self.on_complete = on_complete
        self._lock = threading.RLock()
        self._job = None
        self._process = None
        self._thread = None
        self._cancelled = False

    @property
    def python_path(self):
        if (self.project_dir / 'portable.json').is_file():
            return self.project_dir / 'runtime' / 'python.exe'
        base = self.project_dir / ".engine-venv"
        return base / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    def readiness(self):
        marker = self.project_dir / ".engine-venv" / "chordbuddy-ready.json"
        if (self.project_dir / 'portable.json').is_file():
            marker = self.project_dir / 'runtime' / 'chordbuddy-ready.json'
        if not self.python_path.is_file() or not marker.is_file():
            return {"ready": False, "message": "Run Python 3.11 setup_engine.py to install the transcription engine."}
        try:
            info = json.loads(marker.read_text(encoding="utf8"))
            if info.get("revision") != MODEL_REVISION or info.get("python") != "3.11":
                raise ValueError("Engine version changed")
        except (OSError, ValueError):
            return {"ready": False, "message": "Engine setup is incomplete or outdated. Run setup_engine.py again."}
        if not shutil.which("ffmpeg") and not (self.project_dir/'tools'/'ffmpeg.exe').is_file():
            return {"ready": False, "message": "Install FFmpeg and add its bin folder to PATH, then restart Chord Buddy."}
        if (self.project_dir/'portable.json').is_file():
            return {"ready": True, "message": "Portable engine ready (CUDA-enabled runtime). Automatic uses an available NVIDIA GPU." if info.get("device")=="cuda" else "Portable CPU engine ready. GPU support is not installed; Automatic uses CPU."}
        return {"ready": True, "message": "Engine installed."}

    def attribution(self):
        return model_attribution()

    status = readiness

    def snapshot(self):
        with self._lock:
            return copy.deepcopy(self._job)

    def wait(self,timeout=None):
        """Wait until subprocess cleanup and its ingestion callback finish."""
        with self._lock:
            thread=self._thread
        if thread is None:
            return True
        if thread is threading.current_thread():
            return False
        thread.join(timeout)
        return not thread.is_alive()

    def _command(self, audio_path, run_dir, device):
        return [str(self.python_path), "-u", str(Path(__file__).with_name("worker.py")),
                "--project", str(self.project_dir), "--audio", str(audio_path),
                "--output", str(run_dir), "--device", device]

    def start(self, song_id, audio_path, run_dir, device="auto"):
        if device not in {"auto", "cpu", "cuda"}:
            raise ValueError("Device must be auto, cpu, or cuda")
        audio_path, run_dir = Path(audio_path).resolve(), Path(run_dir).resolve()
        with self._lock:
            if self._job and self._job["status"] in ACTIVE_STATUSES:
                raise RuntimeError("A transcription is already running")
            ready = self.readiness()
            if not ready["ready"]:
                raise RuntimeError(ready["message"])
            if not audio_path.is_file():
                raise ValueError("Original audio does not exist")
            if run_dir.exists() and any(path.name!='run-options.json' or not path.is_file() or path.is_symlink()
                                        for path in run_dir.iterdir()):
                raise ValueError("Transcription output directory must be empty")
            run_dir.mkdir(parents=True, exist_ok=True)
            self._cancelled = False
            self._job = {"song_id": song_id, "stage": "starting", "message": "Starting transcription engine…",
                         "window": None, "windows": None, "tokens": None, "status": "starting",
                         "device": device, "error": None, "outputs": []}
            self._thread = threading.Thread(target=self._run, args=(song_id, audio_path, run_dir, device), daemon=True)
            self._thread.start()
            return self.snapshot()

    def cancel(self):
        with self._lock:
            if not self._job or self._job["status"] not in ACTIVE_STATUSES:
                return self.snapshot()
            self._cancelled = True
            self._job.update(status="cancelling", message="Cancelling transcription…")
            process = self._process
        if process is not None and process.poll() is None:
            # Kill the Windows process tree too: FFmpeg decoding may be running.
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW, check=False)
            # Restricted Windows environments can deny taskkill even for our
            # own child. Popen's existing process handle still permits stopping it.
            if process.poll() is None:
                process.terminate()
        return self.snapshot()

    def _progress(self, value):
        messages = {"loading": "Loading model and downloading missing weights…", "audio": "Decoding original audio…",
                    "encoding": "Analyzing audio…", "decoding": "Transcribing notes and chords…",
                    "window_complete": "Finished audio window", "notation": "Writing score and MIDI…",
                      "complete": "Transcription outputs written"}
        if (self.project_dir/'portable.json').is_file():
            messages['loading'] = 'Loading bundled model…'
        with self._lock:
            if not self._job:
                return
            for key in ("stage", "window", "windows", "tokens", "device", "error"):
                if key in value:
                    self._job[key] = value[key]
            stage = value.get("stage", "")
            self._job["message"] = str(value.get("message") or messages.get(stage, stage.replace("_", " ").capitalize()))
            if not self._cancelled:
                self._job["status"] = "running"

    def _run(self, song_id, audio_path, run_dir, device):
        tail = deque(maxlen=12)
        error = None
        returncode = 1
        process = None
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            process = subprocess.Popen(self._command(audio_path, run_dir, device), cwd=self.project_dir,
                                       env=local_environment(self.project_dir), stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, encoding="utf8", errors="replace",
                                       creationflags=flags)
            with self._lock:
                self._process = process
                cancelled = self._cancelled
            if cancelled:
                self.cancel()
            with (run_dir / "worker.log").open("w", encoding="utf8") as log:
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    if line.startswith(PROGRESS_PREFIX):
                        try:
                            value = json.loads(line[len(PROGRESS_PREFIX):])
                            if isinstance(value, dict):
                                self._progress(value)
                                error = value.get("error") or error
                        except (ValueError, TypeError):
                            tail.append(line.rstrip())
                    else:
                        tail.append(line.rstrip())
            returncode = process.wait()
        except Exception as exc:
            error = str(exc)
        finally:
            # Never publish a terminal job or discard its handle until the
            # inference process has exited, including log/pipe I/O failures.
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                finally:
                    if process.stdout is not None:
                        process.stdout.close()
        try:
            outputs = discover_outputs(run_dir)
        except OSError as exc:
            outputs = []
            error = (error + "; " if error else "") + f"Could not inspect transcription outputs: {exc}"
        with self._lock:
            if self._cancelled:
                status, error = "cancelled", "Transcription cancelled. Any completed outputs were preserved."
            elif returncode != 0 or error:
                status = "partial" if outputs else "failed"
                error = error or "Transcription process failed: " + "\n".join(tail)[-2000:]
            elif not outputs:
                status, error = "failed", "No transcription outputs were produced. See worker.log in the run folder."
            else:
                status = "completed"
            self._job.update(status=status, stage=status, error=error, outputs=outputs,
                             message=error or "Transcription complete")
            self._process = None
            # Hold the lock through ingestion so a newer run cannot overtake this callback.
            try:
                self.on_complete(song_id, run_dir, status, error)
            except Exception as exc:
                self._job.update(status="failed", error=f"Could not import transcription outputs: {exc}",
                                 message=f"Could not import transcription outputs: {exc}")
