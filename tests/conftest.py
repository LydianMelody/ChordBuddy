import getpass
import io
import math
import os
import shutil
import struct
import subprocess
import tempfile
import uuid
import wave
from pathlib import Path

import pytest

# --- A short temporary folder ------------------------------------------------------------------------------------
# Chord Buddy refuses to work in a folder whose generated paths would pass 240 characters (chordbuddy/path_policy.py),
# and many tests use pytest's tmp_path as the install folder. On Windows the usual place,
# C:/Users/<name>/AppData/Local/Temp/pytest-of-<name>/pytest-N, is already about 60 characters, which is too long.
# So when the usual place is long, this run gets its own folder near the top of the drive and removes it afterwards.
LONGEST_BASETEMP = 40      # the install folder may be 89 long; a test's own folder takes up to 34, and a few tests add a subfolder
SHORT_PARENT_NAME = 'cbt-tmp'
_made = {}                 # what this run created (and so may delete): 'base' and, if it did not exist before, 'parent'


def _usual_basetemp_length():
    try:
        user = getpass.getuser()
    except Exception:
        user = 'unknown'
    return len(os.path.join(tempfile.gettempdir(), 'pytest-of-' + user, 'pytest-999'))


def _short_parents():
    if os.name == 'nt':
        yield Path(os.environ.get('SystemDrive', 'C:') + os.sep) / SHORT_PARENT_NAME
        yield Path(Path.cwd().anchor) / SHORT_PARENT_NAME
    else:
        yield Path('/tmp') / SHORT_PARENT_NAME


@pytest.hookimpl(tryfirst=True)
def pytest_configure(config):
    if getattr(config.option, 'basetemp', None) or hasattr(config, 'workerinput'):
        return             # the person chose a folder (--basetemp), or this is a pytest-xdist worker using its parent's folder
    if 'base' in _made or _usual_basetemp_length() <= LONGEST_BASETEMP:
        return
    for parent in _short_parents():
        created_parent = False
        try:
            if not parent.exists():
                parent.mkdir()
                created_parent = True
            base = parent / f'{os.getpid():x}-{uuid.uuid4().hex[:6]}'      # unique, so two runs at once never share a folder
            base.mkdir()                                                    # fails if it exists: never adopt someone else's folder
        except OSError:
            continue
        if len(str(base)) > LONGEST_BASETEMP:
            base.rmdir()
            if created_parent:
                parent.rmdir()
            continue
        _made['base'] = base
        if created_parent:
            _made['parent'] = parent
        config.option.basetemp = str(base)
        # If this file was loaded after pytest had already prepared its temporary folders, prepare them again.
        factory = getattr(config, '_tmp_path_factory', None)
        if factory is not None and getattr(factory, '_basetemp', None) is None:
            try:
                config._tmp_path_factory = type(factory).from_config(config, _ispytest=True)
            except Exception:
                pass
        return


def pytest_report_header(config):
    if 'base' in _made:
        return f'short temporary folder: {_made["base"]} (removed when the run ends)'
    if not getattr(config.option, 'basetemp', None) and _usual_basetemp_length() > LONGEST_BASETEMP:
        return 'WARNING: no short temporary folder could be made, so tests that use one as the install folder may fail. Pass --basetemp=<a short folder>.'


def pytest_unconfigure(config):
    base = _made.pop('base', None)
    if base is not None:
        shutil.rmtree(base, ignore_errors=True)
    parent = _made.pop('parent', None)
    if parent is not None:
        try:
            parent.rmdir()     # succeeds only if it is empty: another run may be using it
        except OSError:
            pass


# --- FFmpeg ------------------------------------------------------------------------------------------------------
# The app only ever runs <install folder>/tools/ffmpeg.exe, which the installer downloads (it is not in the repository).
PROJECT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope='session')
def ffmpeg_exe():
    """A real FFmpeg: the installed one beside the code if there is one, otherwise the one on PATH. Skips without either."""
    bundled = PROJECT / 'tools' / 'ffmpeg.exe'
    if bundled.is_file():
        return bundled
    found = shutil.which('ffmpeg')
    if not found:
        pytest.skip('needs FFmpeg: tools/ffmpeg.exe is not installed and there is no ffmpeg on PATH')
    return Path(found).resolve()


@pytest.fixture
def ffmpeg_project(tmp_path, ffmpeg_exe):
    """tmp_path made into a small install folder that has tools/ffmpeg.exe, for code that keeps its files inside the install folder."""
    target = tmp_path / 'tools' / 'ffmpeg.exe'
    target.parent.mkdir()
    try:
        os.link(ffmpeg_exe, target)        # no copy of a large file when both are on one drive
    except OSError:
        shutil.copyfile(ffmpeg_exe, target)
    return tmp_path


@pytest.fixture
def mp3_bytes():
    if not shutil.which('ffmpeg'):
        pytest.skip('FFmpeg is required for the real MP3 fixture')
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(24000)
        f.writeframes(b''.join(struct.pack('<h', int(2000 * math.sin(2 * math.pi * 220 * i / 24000))) for i in range(12000)))
    return subprocess.run(['ffmpeg', '-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'], input=stream.getvalue(), capture_output=True, check=True).stdout


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """A test that needs the downloaded stem or chord models is skipped, not failed, on a copy that does not have them (a fresh checkout)."""
    outcome = yield
    report = outcome.get_result()
    if call.when == 'call' and report.failed and call.excinfo is not None and 'models have not been downloaded' in str(call.excinfo.value):
        report.outcome = 'skipped'
        report.longrepr = (str(item.path), item.location[1] or 0, 'Skipped: needs the downloaded models (use "Download models" in the app)')
