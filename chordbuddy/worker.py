"""Real model execution. This module is launched only in .engine-venv."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import traceback

# Direct-script launch deliberately avoids importing the app dependency tree.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chordbuddy.engine import MODEL_ID, MODEL_REVISION, PROGRESS_PREFIX, discover_outputs, local_environment
from chordbuddy.model_cache import configure_hub_copy_fallback
from chordbuddy.confidence import confidence_defaults, validate_confidence_settings, install_capture


def emit(value):
    print(PROGRESS_PREFIX + json.dumps(value, default=str, ensure_ascii=True), flush=True)

def limit_gpu_memory(cuda):
    free,total=cuda.mem_get_info()
    if free<5*1024**3:raise RuntimeError('Insufficient free GPU memory; no automatic retry')
    cuda.set_per_process_memory_fraction(min(1.,4*1024**3/total))


def explain_error(exc):
    text = str(exc)
    lower = text.lower()
    if "out of memory" in lower or "cuda error" in lower:
        return "The GPU could not run this transcription (memory or CUDA error). Select CPU Only and try again. " + text
    if any(word in lower for word in ("gated", "401", "403", "unauthorized", "access to model")):
        return ("Hugging Face refused the model download. SheetSage2 and MERT-v2-FullSong are public, so check that no "
                "expired HF_TOKEN is set, then download the chord model again from Chord Buddy. " + text)
    if "ffmpeg" in lower:
        return "FFmpeg could not decode this file. Install FFmpeg, put its bin folder on PATH, and restart Chord Buddy. " + text
    return text


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    os.environ.update(local_environment(args.project))
    try:
        if sys.version_info[:2] != (3, 11):
            raise RuntimeError("SheetSage2 engine requires Python 3.11")
        configure_hub_copy_fallback(os.environ["HF_HUB_CACHE"])
        import torch
        import torchaudio
        from transformers import AutoModel
        if not shutil.which("ffmpeg"):
            raise RuntimeError("FFmpeg executable is missing from PATH")
        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but no usable CUDA GPU is available; choose CPU Only")
        device = "cuda" if args.device != "cpu" and torch.cuda.is_available() else "cpu"
        if device=='cuda' and not args.check:limit_gpu_memory(torch.cuda)
        if args.check:
            emit({"stage": "ready", "device": device, "torch": torch.__version__, "torchaudio": torchaudio.__version__})
            return 0
        if args.audio is None or args.output is None:
            parser.error("--audio and --output are required for transcription")
        args.output.mkdir(parents=True, exist_ok=True)
        options_path = args.output / "run-options.json"
        options = json.loads(options_path.read_text(encoding="utf-8")) if options_path.exists() else {}
        thresholds = validate_confidence_settings(options.get("confidence", confidence_defaults()))
        emit({"stage": "loading", "device": device, "revision": MODEL_REVISION, "message": "Loading bundled model on " + (torch.cuda.get_device_name(0) if device == "cuda" else "CPU")})
        model = AutoModel.from_pretrained(MODEL_ID, revision=MODEL_REVISION, code_revision=MODEL_REVISION,
                                         trust_remote_code=True, cache_dir=os.environ["HF_HUB_CACHE"],
                                         torch_dtype=torch.float32).eval().to(device)
        with torch.inference_mode(), install_capture(model, args.output, thresholds):
            result = model.transcribe(str(args.audio.resolve()), output_dir=str(args.output.resolve()),
                                      progress=emit, dtype="bf16" if device == "cuda" else "fp32")
        if result.get("abc_error"):
            emit({"stage": "error", "error": "Some outputs are available, but the lead sheet could not be generated: " + str(result["abc_error"])})
            return 1
        if device == "cuda":
            torch.cuda.synchronize()
            emit({"stage": "complete", "device": device, "message": f"Transcription complete on {torch.cuda.get_device_name(0)} · peak GPU memory {torch.cuda.max_memory_allocated()/1024**3:.2f} GiB", "outputs": discover_outputs(args.output)})
        else:
            emit({"stage": "complete", "outputs": discover_outputs(args.output)})
        return 0
    except Exception as exc:
        traceback.print_exc()
        emit({"stage": "error", "error": explain_error(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
