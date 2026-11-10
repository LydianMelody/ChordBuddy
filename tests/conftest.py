import io
import math
import shutil
import struct
import subprocess
import wave

import pytest


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
