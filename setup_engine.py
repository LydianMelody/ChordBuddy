"""Install the official model runtime without touching the app environment."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

from chordbuddy.engine import MODEL_ID, MODEL_REVISION, local_environment


def run(command, env, cwd):
    subprocess.run(command, env=env, cwd=cwd, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Set up real SheetSage2 inference with project-local caches.")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu",
                        help="cpu works without an NVIDIA GPU; cuda installs official CUDA 12.6 wheels")
    parser.add_argument("--login", action="store_true", help="Sign in to Hugging Face; token stored only in this project's .models")
    parser.add_argument("--download", action="store_true", help="Download pinned SheetSage2 and parent weights now")
    args = parser.parse_args(argv)
    project = Path(__file__).resolve().parent
    if sys.version_info[:2] != (3, 11):
        print("Run this setup using Python 3.11: py -3.11 setup_engine.py", file=sys.stderr)
        return 1
    environment = local_environment(project)
    os.environ.update(environment)
    target = project / ".engine-venv"
    marker = target / "chordbuddy-ready.json"
    marker.unlink(missing_ok=True)
    try:
        print("Creating isolated Python 3.11 inference environment…", flush=True)
        venv.EnvBuilder(with_pip=True).create(target)
        python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        run([str(python), "-m", "pip", "install", "--upgrade", "pip"], environment, project)
        index = "https://download.pytorch.org/whl/" + ("cu126" if args.device == "cuda" else "cpu")
        print("Installing official Torch 2.8 and SheetSage2 dependencies…", flush=True)
        run([str(python), "-m", "pip", "install", "torch==2.8.0", "torchaudio==2.8.0", "--index-url", index], environment, project)
        run([str(python), "-m", "pip", "install", "-r", str(project / "requirements-engine.txt")], environment, project)
        if args.login:
            print("Use an HF read token with access to SheetSage2 and MERT-v2-FullSong. Token stays in project .models.", flush=True)
            run([str(python), "-c", "from huggingface_hub import login; login(add_to_git_credential=False)"], environment, project)
        run([str(python), str(project / "chordbuddy" / "worker.py"), "--project", str(project), "--check",
             "--device", args.device], environment, project)
        if args.download:
            print("Downloading pinned SheetSage2 and its pinned MERT parent…", flush=True)
            code = ("import json,os; from pathlib import Path; "
                    "from chordbuddy.model_cache import configure_hub_copy_fallback; "
                    "configure_hub_copy_fallback(os.environ['HF_HUB_CACHE']); "
                    "from huggingface_hub import snapshot_download; "
                    f"p=snapshot_download({MODEL_ID!r},revision={MODEL_REVISION!r},cache_dir=os.environ['HF_HUB_CACHE']); "
                    "c=json.loads((Path(p)/'config.json').read_text()); "
                    "snapshot_download(c['base_model_name_or_path'],revision=c['base_model_revision'],cache_dir=os.environ['HF_HUB_CACHE'])")
            run([str(python), "-c", code], environment, project)
        marker.write_text(json.dumps({"python": "3.11", "revision": MODEL_REVISION, "device": args.device}), encoding="utf8")
        print("Engine setup complete. Start Chord Buddy. First transcription loads real model weights.", flush=True)
        return 0
    except subprocess.CalledProcessError as exc:
        print("Setup failed. Review the error above. FFmpeg must be on PATH. The models (m-a-p/SheetSage2 and "
              "m-a-p/MERT-v2-FullSong) are public and need no account; check your internet connection. "
              f"Failed command exited {exc.returncode}.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
