"""Render the practice stems with the user's mixer settings and encode them as an MP3 (streamed, bounded memory)."""
import subprocess
import threading
from pathlib import Path
import numpy as np
from .separation_audio import read_frames
from .separation_contract import SAMPLE_RATE, STEMS

# Order of the mixer's seven channels (the same order the player uses). Never reorder.
MIX_ORDER = ('bass', 'drums', 'other', 'vocals', 'piano', 'lead', 'rhythm')
assert set(MIX_ORDER) == set(STEMS)


def parse_levels(raw, master):
    """Seven per-stem levels (0..1.5) and a master level (0..1.5) from query strings."""
    parts = str(raw).split(',')
    if len(parts) != 7:
        raise ValueError('Expected seven stem levels')
    try:
        levels = [float(p) for p in parts]
        master = float(master)
    except ValueError:
        raise ValueError('Mixer levels must be numbers') from None
    if not all(0 <= v <= 1.5 and v == v for v in levels + [master]):
        raise ValueError('Mixer levels must be between 0 and 1.5')
    return levels, master


def mix_blocks(root, manifest, levels, master):
    """Yield float32 stereo blocks (interleaved bytes) of the weighted stem sum, clipped to [-1, 1]."""
    by_role = {a['role']: a for a in manifest['assets']}
    gain = float(manifest.get('common_gain', 1.0)) * master
    active = [(by_role[role], levels[i] * gain) for i, role in enumerate(MIX_ORDER) if levels[i] > 0]
    total = manifest['frames']
    for start in range(0, total, SAMPLE_RATE):
        count = min(SAMPLE_RATE, total - start)
        block = np.zeros(count * 2, dtype=np.float32)
        for asset, weight in active:
            block += np.frombuffer(read_frames(Path(root) / asset['relative_path'], asset, start, count), dtype=np.float32) * np.float32(weight)
        np.clip(block, -1.0, 1.0, out=block)
        yield block.astype('<f4').tobytes()


def encode_mix(project, root, manifest, levels, master, write, bitrate='192k'):
    """Encode the mix through the bundled ffmpeg, handing MP3 bytes to `write` as they appear."""
    ffmpeg = Path(project) / 'tools' / 'ffmpeg.exe'
    if not ffmpeg.is_file():
        raise OSError('The audio encoder (tools/ffmpeg.exe) is missing')
    argv = [str(ffmpeg), '-nostdin', '-v', 'error', '-f', 'f32le', '-ar', str(SAMPLE_RATE), '-ac', '2', '-i', 'pipe:0',
            '-c:a', 'libmp3lame', '-b:a', bitrate, '-id3v2_version', '3', '-f', 'mp3', 'pipe:1']
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    failure = []

    def feed():
        try:
            for block in mix_blocks(root, manifest, levels, master):
                proc.stdin.write(block)
        except (OSError, ValueError) as exc:
            failure.append(exc)
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    feeder = threading.Thread(target=feed, daemon=True)
    feeder.start()
    try:
        while True:
            data = proc.stdout.read(65536)
            if not data:
                break
            write(data)
    finally:
        if proc.poll() is None:
            proc.kill()
        feeder.join(timeout=5)
        proc.wait()
    if failure:
        raise OSError(f'Could not read the stems: {failure[0]}')
    if proc.returncode:
        raise OSError('The audio encoder failed')


# How each stem is named in an "Export stems" file: <song title>_Vocals, <song title>_LeadGtr and so on.
STEM_FILE_NAMES = {'vocals': 'Vocals', 'lead': 'LeadGtr', 'rhythm': 'RhythmGtr', 'bass': 'Bass', 'drums': 'Drums', 'piano': 'Piano', 'other': 'Other'}
assert set(STEM_FILE_NAMES) == set(STEMS)


def stem_levels(role):
    """Mixer levels that play one stem alone, untouched by the faders."""
    return [1.0 if name == role else 0.0 for name in MIX_ORDER]


def export_stems(project, root, manifest, title, write):
    """Stream a zip holding one MP3 per stem (full length, at its own level). The MP3s are already compressed, so the zip only stores them."""
    import zipfile
    roles = {asset['role'] for asset in manifest['assets']}
    with zipfile.ZipFile(_Sink(write), 'w', zipfile.ZIP_STORED) as archive:
        for role in STEM_FILE_NAMES:
            if role not in roles:
                continue
            with archive.open(f'{title}_{STEM_FILE_NAMES[role]}.mp3', 'w', force_zip64=True) as member:
                encode_mix(project, root, manifest, stem_levels(role), 1.0, member.write)


class _Sink:
    """A write-only stream for zipfile, so the archive can leave while it is still being made."""
    def __init__(self, write):
        self.write_bytes = write

    def write(self, data):
        self.write_bytes(data)
        return len(data)

    def flush(self):
        pass
