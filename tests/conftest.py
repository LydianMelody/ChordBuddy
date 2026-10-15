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
