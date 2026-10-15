"""Install everything Chord Buddy needs to run on Windows, into this folder only.

Run it by double-clicking InstallWindowsDependencies.cmd (which fetches a small Python first if there is none yet), or:
    runtime\\python.exe install_windows_dependencies.py [--device auto|cuda|cpu] [--only STEP,STEP] [--hf-login]

Steps (each can be repeated safely; finished ones are skipped):
    python      the app's own Python 3.11 (the "embeddable" build from python.org)
    pip         a pinned copy of pip, used only by this script
    app         window and file libraries   (requirements.txt)           -> runtime\\app-packages
    engine      PyTorch and the transcription libraries (requirements-engine.txt) -> runtime\\engine-packages
    separation  the stem engine's own small Python and libraries         -> .models\\separation
    ffmpeg      the audio converter                                      -> tools\\ffmpeg.exe
    models      the stem separation models (hash-checked)                -> .models\\separation
    check       confirms the engine starts, then marks the install ready
    sheetsage   optional: the SheetSage2 model (needs a Hugging Face login, see --hf-login)

Nothing is installed outside this folder. Every download is checked against a SHA-256 fingerprint
(installer-pins.json, or pinned in requirements files), except pip's own package downloads, which pip verifies itself.
"""
from __future__ import annotations
import argparse
import getpass
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PINS = json.loads((ROOT / 'installer-pins.json').read_text(encoding='utf-8'))
RUNTIME = ROOT / 'runtime'
PY = RUNTIME / 'python.exe'
MODELS_DIR = ROOT / '.models'
SEPARATION = MODELS_DIR / 'separation'
STATE = MODELS_DIR / 'installer-state.json'
STEPS = ['python', 'pip', 'app', 'engine', 'separation', 'ffmpeg', 'models', 'check']
OPTIONAL = ['sheetsage']
BACKSLASH = chr(92)


class Failure(Exception):
    pass


def say(text=''):
    print(text, flush=True)


# ---------------------------------------------------------------- helpers
def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def download(url, dest, sha256, label):
    """Download to `dest` (kept if it already matches); refuse anything whose fingerprint differs."""
    dest = Path(dest)
    if dest.is_file() and sha256_of(dest) == sha256:
        return dest
    if not url.startswith('https://'):
        raise Failure('Refusing a non-HTTPS download: ' + url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + '.partial')
    say(f'  downloading {label}…')
    digest = hashlib.sha256()
    done = 0
    shown = -1
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'ChordBuddy-installer'})
        with urllib.request.urlopen(request, timeout=60) as response, open(partial, 'wb') as out:
            total = int(response.headers.get('Content-Length') or 0)
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                out.write(block)
                digest.update(block)
                done += len(block)
                percent = int(100 * done / total) // 10 * 10 if total else -1
                if percent != shown and percent >= 0:
                    shown = percent
                    say(f'    {percent}% of {total / 1024 ** 2:.0f} MB')
    except OSError as exc:
        partial.unlink(missing_ok=True)
        raise Failure(f'Could not download {label}: {exc}') from exc
    if digest.hexdigest() != sha256:
        partial.unlink(missing_ok=True)
        raise Failure(f'{label} did not match its expected fingerprint, so it was discarded. (Expected {sha256[:12]}…, got {digest.hexdigest()[:12]}…)')
    os.replace(partial, dest)
    return dest


def load_state():
    try:
        return json.loads(STATE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1, sort_keys=True), encoding='utf-8')


def inputs_key(*files, extra=''):
    digest = hashlib.sha256(extra.encode())
    for name in files:
        digest.update(Path(name).read_bytes())
    return digest.hexdigest()[:20]


def local_env():
    """Caches and temporary files stay inside this folder, like the app itself."""
    env = os.environ.copy()
    for name, folder in {'PIP_CACHE_DIR': 'pip', 'TMP': 'tmp', 'TEMP': 'tmp', 'TMPDIR': 'tmp'}.items():
        (MODELS_DIR / folder).mkdir(parents=True, exist_ok=True)
        env[name] = str(MODELS_DIR / folder)
    env.update(PYTHONNOUSERSITE='1', PIP_DISABLE_PIP_VERSION_CHECK='1', PYTHONDONTWRITEBYTECODE='1')
    env.pop('PYTHONPATH', None)
    return env


def pip_wheel():
    return RUNTIME / 'bootstrap' / 'pip-24.0-py3-none-any.whl'


def run_pip(args):
    code = f'import sys; sys.path.insert(0, {str(pip_wheel())!r}); from pip._internal.cli.main import main; sys.exit(main(sys.argv[1:]))'
    command = [str(PY), '-c', code, *args, '--disable-pip-version-check', '--no-warn-script-location']
    say('  pip ' + ' '.join(args[:3]) + ' …')
    if subprocess.run(command, cwd=ROOT, env=local_env()).returncode:
        raise Failure('pip could not install the libraries (see the messages above). Check your internet connection and try again.')


def has_nvidia():
    try:
        return subprocess.run(['nvidia-smi', '-L'], capture_output=True, timeout=15).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ---------------------------------------------------------------- steps
def build_pure_wheels():
    """Pack small pure-Python source-only packages into wheels pip can install (the embeddable Python cannot build them itself)."""
    folder = MODELS_DIR / 'wheels'
    folder.mkdir(parents=True, exist_ok=True)
    for pin in PINS.get('pure_python_sources', []):
        name, version = pin['name'], pin['version']
        wheel = folder / f'{name}-{version}-py3-none-any.whl'
        if wheel.is_file():
            continue
        archive = download(pin['url'], MODELS_DIR / 'downloads' / f'{name}-{version}.tar.gz', pin['sha256'], f'{name} {version} (source)')
        files = {}
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                parts = member.name.split('/')
                if member.isfile() and len(parts) > 2 and parts[1] == pin['package']:
                    files['/'.join(parts[1:])] = bundle.extractfile(member).read()
        if not files:
            raise Failure(f'{name} did not contain the expected package folder.')
        info = f'{name}-{version}.dist-info'
        meta = ['Metadata-Version: 2.1', f'Name: {name}', f'Version: {version}', f'License: {pin["license"]}', *[f'Requires-Dist: {r}' for r in pin.get('requires', [])], '']
        files[f'{info}/METADATA'] = '\n'.join(meta).encode()
        files[f'{info}/WHEEL'] = '\n'.join(['Wheel-Version: 1.0', 'Generator: chordbuddy-installer', 'Root-Is-Purelib: true', 'Tag: py3-none-any', '']).encode()
        files[f'{info}/top_level.txt'] = (pin['package'] + '\n').encode()

        def record_line(path, data):
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
            return f'{path},sha256={digest},{len(data)}'
        lines = [record_line(path, data) for path, data in files.items()] + [f'{info}/RECORD,,']
        files[f'{info}/RECORD'] = ('\n'.join(lines) + '\n').encode()
        with zipfile.ZipFile(wheel, 'w', zipfile.ZIP_DEFLATED) as out:
            for path, data in files.items():
                out.writestr(path, data)
    return folder


def step_python(ctx):
    if PY.is_file():
        version = subprocess.run([str(PY), '--version'], capture_output=True, text=True).stdout.strip()
        if not version.startswith('Python 3.11'):
            raise Failure(f'{PY} is {version}; Chord Buddy needs Python 3.11.')
        say(f'  Python is already here ({version}).')
        return
    pin = PINS['python']
    archive = download(pin['url'], MODELS_DIR / 'downloads' / 'python-embed.zip', pin['sha256'], 'Python ' + pin['version'])
    RUNTIME.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(RUNTIME)
    write_runtime_pth()
    say('  Python installed into the runtime folder.')


def write_runtime_pth():
    lines = ['python311.zip', '.', 'app-packages', 'engine-packages', '..', 'import site']
    (RUNTIME / 'python311._pth').write_bytes(('\r\n'.join(lines) + '\r\n').encode())
    (RUNTIME / 'app-packages').mkdir(exist_ok=True)
    (RUNTIME / 'engine-packages').mkdir(exist_ok=True)


def step_pip(ctx):
    pin = PINS['pip']
    download(pin['url'], pip_wheel(), pin['sha256'], 'pip 24.0')


def step_app(ctx):
    key = inputs_key(ROOT / 'requirements.txt', ROOT / 'constraints-app.txt')
    if ctx['state'].get('app') == key and (RUNTIME / 'app-packages' / 'webview').exists():
        say('  already installed.')
        return
    wheels = build_pure_wheels()
    run_pip(['install', '--target', str(RUNTIME / 'app-packages'), '--upgrade', '--only-binary=:all:', '--find-links', str(wheels),
             '-r', str(ROOT / 'requirements.txt'), '-c', str(ROOT / 'constraints-app.txt')])
    ctx['state']['app'] = key


def step_engine(ctx):
    device = ctx['device']
    key = inputs_key(ROOT / 'requirements-engine.txt', ROOT / 'constraints-engine.txt', extra=device)
    if ctx['state'].get('engine') == key and (RUNTIME / 'engine-packages' / 'torch').exists():
        say('  already installed.')
        return
    say(f'  PyTorch for {"an NVIDIA graphics card" if device == "cuda" else "the processor (CPU only)"}. This is a large download (a few GB).')
    run_pip(['install', '--target', str(RUNTIME / 'engine-packages'), '--upgrade', '--only-binary=:all:',
             '--find-links', str(build_pure_wheels()), '-r', str(ROOT / 'requirements-engine.txt'), '-c', str(ROOT / 'constraints-engine.txt'),
             '--extra-index-url', PINS['torch_index'][device]])
    ctx['state']['engine'] = key


def separation_pth_lines():
    up = BACKSLASH.join(['..'] * 3)
    if (RUNTIME / 'Lib').is_dir():          # a full Python layout (the developer machine)
        stdlib = [up + BACKSLASH + 'runtime' + BACKSLASH + 'Lib', up + BACKSLASH + 'runtime' + BACKSLASH + 'DLLs']
    else:                                   # the embeddable build this script installs
        stdlib = [up + BACKSLASH + 'runtime' + BACKSLASH + 'python311.zip', up + BACKSLASH + 'runtime']
    return ['..' + BACKSLASH + 'packages', *stdlib, up + BACKSLASH + 'runtime' + BACKSLASH + 'engine-packages']


def step_separation(ctx):
    key = inputs_key(ROOT / 'requirements-separation.txt')
    packages = SEPARATION / 'packages'
    if ctx['state'].get('separation') != key or not (packages / 'einops').exists():
        run_pip(['install', '--target', str(packages), '--upgrade', '--no-deps', '--only-binary=:all:', '-r', str(ROOT / 'requirements-separation.txt')])
        ctx['state']['separation'] = key
    runtime = SEPARATION / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    for name in ('python.exe', 'python3.dll', 'python311.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        source = RUNTIME / name
        if source.is_file() and not (runtime / name).is_file():
            shutil.copyfile(source, runtime / name)
    pth = ('\r\n'.join(separation_pth_lines()) + '\r\n').encode()
    for name in ('python._pth', 'python311._pth'):
        (runtime / name).write_bytes(pth)
    say('  the stem engine\'s Python and libraries are ready.')


def step_ffmpeg(ctx):
    target = ROOT / 'tools' / 'ffmpeg.exe'
    if target.is_file():
        say('  ffmpeg is already here.')
        return
    pin = PINS['ffmpeg']
    archive = download(pin['url'], MODELS_DIR / 'downloads' / 'ffmpeg.zip', pin['sha256'], 'ffmpeg 6.0')
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        with bundle.open(pin['inside'] + '/bin/ffmpeg.exe') as src, open(target, 'wb') as out:
            shutil.copyfileobj(src, out)
        license_folder = ROOT / 'tools' / 'licenses'
        license_folder.mkdir(exist_ok=True)
        with bundle.open(pin['inside'] + '/LICENSE') as src, open(license_folder / 'LICENSE-ffmpeg.txt', 'wb') as out:
            shutil.copyfileobj(src, out)
    say('  ffmpeg installed. ' + pin['license'])


def step_models(ctx):
    command = [str(PY), '-m', 'chordbuddy.model_downloads', '--project', str(ROOT)]
    if subprocess.run(command, cwd=ROOT, env=local_env()).returncode:
        raise Failure('The stem separation models could not all be downloaded. Run this again, or start Chord Buddy and use the download panel (it also accepts files you already have).')


def step_check(ctx):
    device = ctx['device']
    env = local_env()
    env['HF_HOME'] = str(MODELS_DIR / 'hf')
    env['HF_HUB_CACHE'] = str(MODELS_DIR / 'hf' / 'hub')
    result = subprocess.run([str(PY), str(ROOT / 'chordbuddy' / 'worker.py'), '--project', str(ROOT), '--check', '--device', device],
                            cwd=ROOT, env=env, capture_output=True, text=True)
    if result.returncode:
        say((result.stdout + result.stderr)[-1500:])
        raise Failure('The transcription engine did not start. The messages above say why.')
    pins = json.loads((ROOT / 'portable.json').read_text(encoding='utf-8'))
    marker = {'python': '3.11', 'revision': pins['model_revision'], 'device': device}
    (RUNTIME / 'chordbuddy-ready.json').write_text(json.dumps(marker), encoding='utf-8')
    say('  the engine starts; install marked ready.')


def step_sheetsage(ctx):
    """SheetSage2 is gated on Hugging Face: it needs an account that has been granted access and a read token."""
    pins = json.loads((ROOT / 'portable.json').read_text(encoding='utf-8'))
    code = ("import json,os; from pathlib import Path; "
            "from chordbuddy.model_cache import configure_hub_copy_fallback; configure_hub_copy_fallback(os.environ['HF_HUB_CACHE']); "
            "from huggingface_hub import snapshot_download; "
            f"p=snapshot_download('m-a-p/SheetSage2',revision={pins['model_revision']!r},cache_dir=os.environ['HF_HUB_CACHE']); "
            "c=json.loads((Path(p)/'config.json').read_text()); "
            "snapshot_download(c['base_model_name_or_path'],revision=c['base_model_revision'],cache_dir=os.environ['HF_HUB_CACHE'])")
    from_env = local_env()
    hf = MODELS_DIR / 'hf'
    hf.mkdir(parents=True, exist_ok=True)
    from_env.update(HF_HOME=str(hf), HF_HUB_CACHE=str(hf / 'hub'), HF_TOKEN_PATH=str(hf / 'token'), HF_HUB_DISABLE_TELEMETRY='1')
    if subprocess.run([str(PY), '-c', code], cwd=ROOT, env=from_env).returncode:
        raise Failure('SheetSage2 could not be downloaded. It needs a Hugging Face account that has been granted access to m-a-p/SheetSage2 and m-a-p/MERT-v2-FullSong, '
                      'and a read token (run this script again with --hf-login).')


# ---------------------------------------------------------------- extras
def check_webview2():
    try:
        import winreg
    except ImportError:
        return True
    keys = [(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'),
            (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'),
            (winreg.HKEY_CURRENT_USER, r'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')]
    for hive, key in keys:
        try:
            with winreg.OpenKey(hive, key) as handle:
                if winreg.QueryValueEx(handle, 'pv')[0] not in ('', '0.0.0.0'):
                    return True
        except OSError:
            continue
    return False


def hf_login():
    say('Paste a Hugging Face READ token (from huggingface.co/settings/tokens). It is saved only in this folder (.models\\hf\\token).')
    token = getpass.getpass('Token (hidden): ').strip()
    if not token:
        say('No token entered; skipped.')
        return
    folder = MODELS_DIR / 'hf'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'token').write_text(token, encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--device', choices=['auto', 'cuda', 'cpu'], default='auto', help='graphics card (cuda) or processor only (cpu); auto looks for an NVIDIA card')
    parser.add_argument('--only', help='comma-separated steps to run: ' + ', '.join(STEPS + OPTIONAL))
    parser.add_argument('--hf-login', action='store_true', help='save a Hugging Face token and download SheetSage2')
    parser.add_argument('--no-pause', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--skip-models', action='store_true', help='do not download the stem separation models now (the app offers it on first run)')
    args = parser.parse_args(argv)
    if sys.platform != 'win32':
        say('This installer is for Windows.')
        return 1
    if len(str(ROOT)) > 100:
        say(f'Note: this folder\'s path is {len(str(ROOT))} characters long. Windows limits paths to 260, so keep it under about 100 (for example C:\\ChordBuddy).')
    device = args.device if args.device != 'auto' else ('cuda' if has_nvidia() else 'cpu')
    say(f'Installing into {ROOT}')
    say(f'Processing: {"NVIDIA graphics card (CUDA)" if device == "cuda" else "CPU only"}')
    chosen = [s.strip() for s in args.only.split(',')] if args.only else list(STEPS)
    if args.hf_login:
        hf_login()
        chosen = [*chosen, 'sheetsage'] if 'sheetsage' not in chosen else chosen
    if args.skip_models and 'models' in chosen:
        chosen.remove('models')
    unknown = [s for s in chosen if s not in STEPS + OPTIONAL]
    if unknown:
        say('Unknown step: ' + ', '.join(unknown))
        return 2
    ctx = {'device': device, 'state': load_state()}
    functions = {'python': step_python, 'pip': step_pip, 'app': step_app, 'engine': step_engine, 'separation': step_separation,
                 'ffmpeg': step_ffmpeg, 'models': step_models, 'check': step_check, 'sheetsage': step_sheetsage}
    started = time.time()
    try:
        for name in [s for s in STEPS + OPTIONAL if s in chosen]:
            say(f'\n== {name}')
            functions[name](ctx)
            save_state(ctx['state'])
    except Failure as exc:
        save_state(ctx['state'])
        say('\nStopped: ' + str(exc))
        return 1
    except KeyboardInterrupt:
        say('\nStopped by you. Run it again to carry on.')
        return 1
    if not check_webview2():
        say('\nThe Microsoft WebView2 runtime was not found. Chord Buddy\'s window needs it (it is built into Windows 11 and most updated Windows 10).')
        say('Install the "Evergreen Standalone" runtime from https://developer.microsoft.com/microsoft-edge/webview2/ or use "Start in browser.cmd" instead.')
    say(f'\nDone in {time.time() - started:.0f} s. Start Chord Buddy with "Start Chord Buddy.cmd".')
    if not (MODELS_DIR / 'hf' / 'hub').exists():
        say('Note: the transcription model (SheetSage2) is downloaded the first time you analyze a song and needs a free Hugging Face account with access to')
        say('m-a-p/SheetSage2 and m-a-p/MERT-v2-FullSong. To fetch it now, run this script again with --hf-login.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
