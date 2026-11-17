"""Stem files as a split stores them, read one way whatever their format.

New splits store each stem as lossless 24-bit FLAC, about a third the size of the float WAV the separation model writes. Older splits keep
their float WAVs, and a song can hold both (Replace a Stem writes FLAC beside the shared files of an older split). Everything that reads a
stem goes through index() and read_frames() here, which hand back the same 44.1 kHz stereo float32 samples for either.

separation_audio.py is never changed: the separation recipe pins its exact contents, so editing it would mark every song's stems stale.
This module wraps it for WAV and adds FLAC.

FLAC holds whole numbers, so a sample louder than full scale would be cut off. A stem that peaks above 1.0 (drum hits often do, up to
about 1.9) is stored divided by a power of two and multiplied back on reading. A power of two makes both steps exact, so the only change
to the audio is the 24-bit rounding, far below hearing. The scale is written inside the FLAC itself (its comment tag, "chordbuddy scale
2"), so whatever opens the file knows it, and is copied into the manifest entry, which is what reading uses.

Open FLAC files are kept for a few seconds between reads: playback asks for the next second of all seven stems many times, and reopening
a FLAC means reading its header and searching for the place again each time. A file idle for IDLE_SECONDS is closed, and release() closes
every file under a folder at once, because Windows will not delete a file that is open.
"""
import array
import math
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

from .separation_audio import index_wav, read_frames as read_wav_frames
from .separation_contract import TRACKS, SAMPLE_RATE, file_hash

FLAC = 'flac24'                       # the `format` a FLAC stem's manifest entry carries; float WAVs carry 'float32le'
SCALE_TAG = 'chordbuddy scale '       # the FLAC's comment tag: this, then the scale
FULL = 8388608                        # 2 ** 23: a 24-bit sample's full scale
BLOCK = SAMPLE_RATE * 10              # frames compressed or decoded at a time, so a whole stem never has to be in memory twice
MAX_SCALE = 256.0                     # a stem 48 dB over full scale is broken, not loud
IDLE_SECONDS = 10.0
MAX_OPEN = 32                         # four songs' worth of stems


def _soundfile():
    import soundfile                  # imported on first use: the app opens even if it is missing, and only FLAC stems need it
    return soundfile


# ------------------------------------------------------------------ reading

def is_flac(info):
    return info.get('format') == FLAC


def index(path):
    """What read_frames() needs to know about a stem file: a float WAV's header, or a FLAC's length and format."""
    path = Path(path)
    if path.suffix.lower() != '.flac':
        return index_wav(path)
    with _soundfile().SoundFile(str(path)) as meta:
        if meta.samplerate != SAMPLE_RATE or meta.channels != 2 or meta.format != 'FLAC' or meta.subtype != 'PCM_24':
            raise ValueError('Expected stereo 44100 Hz 24-bit FLAC')
        if meta.frames <= 0:
            raise ValueError('Empty audio')
        tag = meta.comment or ''
    if tag and not tag.startswith(SCALE_TAG):
        raise ValueError('Not a stem Chord Buddy stored')
    try:
        scale = float(tag[len(SCALE_TAG):]) if tag else 1.0
    except ValueError:
        raise ValueError('Invalid stem scale') from None
    info = {'frames': int(meta.frames), 'sample_rate': SAMPLE_RATE, 'channels': 2, 'format': FLAC, 'scale': scale}
    _scale(info)
    return info


def _scale(info):
    scale = info.get('scale', 1.0)
    if type(scale) not in (int, float) or not 1 <= scale <= MAX_SCALE or math.log2(scale) % 1:
        raise ValueError('Invalid stem scale')
    return float(scale)


def read_frames(path, info, start, count):
    """`count` frames (at most one second) from frame `start` on, as interleaved float32 in an array('f'): the same as
    separation_audio.read_frames gives for a WAV, which is what this does for one."""
    if not is_flac(info):
        return read_wav_frames(path, info, start, count)
    if type(start) != int or type(count) != int or start < 0 or not 1 <= count <= SAMPLE_RATE or start >= info['frames']:
        raise ValueError('Invalid PCM frame bounds')
    count = min(count, info['frames'] - start)
    values = _read_flac(path, start, count)
    if values.shape != (count, 2):
        raise ValueError('Truncated audio')
    scale = _scale(info)
    if scale != 1:
        values *= np.float32(scale)
    result = array.array('f')
    result.frombytes(values.astype('<f4', copy=False).tobytes())
    if sys.byteorder != 'little':
        result.byteswap()
    return result


def read_all(path, info):
    """The whole stem as a (frames, 2) float32 array."""
    if not is_flac(info):
        return np.memmap(path, dtype='<f4', mode='r', offset=info['data_offset'], shape=(info['frames'], 2))
    frames = info['frames']
    out = np.empty((frames, 2), dtype=np.float32)
    for start in range(0, frames, BLOCK):
        count = min(BLOCK, frames - start)
        block = _read_flac(path, start, count)
        if block.shape != (count, 2):
            raise ValueError('Truncated audio')
        out[start:start + count] = block
    scale = _scale(info)
    if scale != 1:
        out *= np.float32(scale)
    return out


class FlacFrames:
    """A FLAC stem that reads like a (frames, 2) float32 array, decoding only the stretch a slice asks for (a preview of a few seconds
    does not decode the whole song). np.asarray() of it decodes everything."""
    dtype = np.dtype(np.float32)
    ndim = 2

    def __init__(self, path, info):
        self.path, self.info = Path(path), info
        self.shape = (info['frames'], 2)

    def __len__(self):
        return self.shape[0]

    def __array__(self, dtype=None, copy=None):
        whole = read_all(self.path, self.info)
        return whole if dtype is None else whole.astype(dtype, copy=False)

    def __getitem__(self, key):
        if isinstance(key, slice) and key.step in (None, 1):
            start, stop, _ = key.indices(self.shape[0])
            if stop <= start:
                return np.zeros((0, 2), dtype=np.float32)
            block = _read_flac(self.path, start, stop - start)
            if block.shape != (stop - start, 2):
                raise ValueError('Truncated audio')
            scale = _scale(self.info)
            return block * np.float32(scale) if scale != 1 else block
        return np.asarray(self)[key]


def frames(path, info):
    """The stem as a (frames, 2) float32 array-like: a memory map for a float WAV, a FlacFrames for a FLAC. Slicing reads only that part."""
    if not is_flac(info):
        return np.memmap(path, dtype='<f4', mode='r', offset=info['data_offset'], shape=(info['frames'], 2))
    return FlacFrames(path, info)


def wire_chunk(root, manifest, start, count):
    """The bytes the player streams: `count` frames of every track in TRACKS order, as separation_audio.wire_chunk makes them, for
    either format."""
    if type(count) != int or not 1 <= count <= SAMPLE_RATE or type(start) != int or not 0 <= start < manifest['frames']:
        raise ValueError('Invalid PCM frame bounds')
    actual = min(count, manifest['frames'] - start)
    by_role = {a['role']: a for a in manifest['assets']}
    if set(by_role) != set(TRACKS):
        raise ValueError('Invalid playback roles')
    payload = []
    for role in TRACKS:
        a = by_role[role]
        values = read_frames(Path(root) / a['relative_path'], a, start, actual)
        if sys.byteorder != 'little':
            values.byteswap()
        payload.append(values.tobytes())
    return b''.join(payload), actual


# ------------------------------------------------------------------ open files

class _Open:
    __slots__ = ('file', 'lock', 'used', 'stamp')


_open = {}
_guard = threading.Lock()
_sweeper = None


def _key(path):
    return os.path.normcase(os.path.abspath(path))


def _read_flac(path, start, count):
    key = _key(path)
    stat = os.stat(key)
    stamp = (stat.st_size, stat.st_mtime_ns)
    with _guard:
        handle = _open.get(key)
        if handle is not None and handle.stamp != stamp:      # the file was replaced: never read the old one's frames
            _close(key, handle)
            handle = None
        if handle is None:
            handle = _Open()
            handle.file = _soundfile().SoundFile(key)
            handle.lock = threading.Lock()
            handle.stamp = stamp
            _open[key] = handle
            _trim()
            _start_sweeper()
        handle.used = time.monotonic()
    with handle.lock:
        if handle.file.closed:                                 # closed by release() between the two locks: read this once on its own
            with _soundfile().SoundFile(key) as once:
                once.seek(start)
                return once.read(count, dtype='float32', always_2d=True)
        handle.file.seek(start)
        return handle.file.read(count, dtype='float32', always_2d=True)


def _close(key, handle):
    _open.pop(key, None)
    with handle.lock:
        handle.file.close()


def _trim():
    while len(_open) > MAX_OPEN:
        key, handle = min(_open.items(), key=lambda item: item[1].used)
        _close(key, handle)


def _sweep():
    global _sweeper
    while True:
        time.sleep(IDLE_SECONDS / 2)
        with _guard:
            now = time.monotonic()
            for key, handle in list(_open.items()):
                if now - handle.used >= IDLE_SECONDS and handle.lock.acquire(blocking=False):
                    try:
                        _open.pop(key, None)
                        handle.file.close()
                    finally:
                        handle.lock.release()
            if not _open:
                _sweeper = None
                return


def _start_sweeper():
    global _sweeper
    if _sweeper is None:
        _sweeper = threading.Thread(target=_sweep, name='stem-audio-close', daemon=True)
        _sweeper.start()


def release(folder=None):
    """Close every open stem file under `folder` (all of them when None), so the files can be deleted or replaced."""
    prefix = None if folder is None else _key(folder).rstrip('\\/') + os.sep
    with _guard:
        for key, handle in list(_open.items()):
            if prefix is None or key.startswith(prefix):
                _close(key, handle)


def open_count():
    with _guard:
        return len(_open)


# ------------------------------------------------------------------ writing

def scale_for(peak):
    """The power of two a stem is divided by so it fits inside full scale (1 when it already does)."""
    if not math.isfinite(peak):
        raise ValueError('Nonfinite audio')
    scale = 1.0 if peak <= 1 else 2.0 ** math.ceil(math.log2(peak))
    if scale > MAX_SCALE:
        raise ValueError('Stem is far louder than full scale')
    return scale


def _quantize(block, scale):
    """float32 frames -> what a 24-bit file holds, as int32 with the sample in the top 24 bits (how libsndfile takes 24-bit integers)."""
    whole = np.rint(np.asarray(block, dtype=np.float64) / scale * FULL)
    return (np.clip(whole, -FULL, FULL - 1).astype(np.int32) << 8)


def write_flac(path, audio):
    """Store (frames, 2) float32 audio as a 24-bit FLAC at `path`, check it decodes to exactly what was meant, and return its manifest
    fields. Written beside the target first, so `path` is either the finished file or absent."""
    path = Path(path)
    audio = np.asarray(audio)
    if audio.ndim != 2 or audio.shape[1] != 2 or not len(audio):
        raise ValueError('Expected stereo audio')
    peak = 0.0
    for start in range(0, len(audio), BLOCK):
        block = np.asarray(audio[start:start + BLOCK], dtype=np.float32)
        if not np.isfinite(block).all():
            raise ValueError('Nonfinite audio')
        peak = max(peak, float(np.abs(block).max()))
    scale = scale_for(peak)
    sf = _soundfile()
    temp = path.with_name(path.name + '.part')
    try:
        with sf.SoundFile(str(temp), 'w', SAMPLE_RATE, 2, 'PCM_24', format='FLAC') as out:
            out.comment = f'{SCALE_TAG}{scale:g}'               # before any audio: FLAC keeps its tags at the front
            for start in range(0, len(audio), BLOCK):
                out.write(_quantize(audio[start:start + BLOCK], scale))
        with sf.SoundFile(str(temp)) as check:
            if check.frames != len(audio) or check.comment != f'{SCALE_TAG}{scale:g}':
                raise ValueError('FLAC frame count mismatch')
            for start in range(0, len(audio), BLOCK):
                block = audio[start:start + BLOCK]
                decoded = check.read(len(block), dtype='int32', always_2d=True)
                if not np.array_equal(decoded, _quantize(block, scale)):
                    raise ValueError('FLAC did not decode to the audio it was given')
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return {'frames': len(audio), 'sample_rate': SAMPLE_RATE, 'channels': 2, 'format': FLAC, 'scale': scale}


def compress_assets(root, manifest, roles):
    """Turn the float WAV stems named in a validated manifest into FLAC beside them, and return the manifest with those entries pointing
    at the FLACs. The WAVs stay until the caller has published (and can then delete them with drop_wavs)."""
    root = Path(root)
    assets = []
    for asset in manifest['assets']:
        if asset['role'] in roles and not is_flac(asset):
            wav = root / asset['relative_path']
            name = asset['role'] + '.flac'
            fields = write_flac(root / name, read_all(wav, asset))
            asset = dict(fields, role=asset['role'], relative_path=name, file_sha256=file_hash(root / name))
        assets.append(asset)
    return dict(manifest, assets=assets)


def drop_wavs(root, roles):
    """Delete the float WAVs of `roles` once their FLACs are published. A WAV that is still needed elsewhere (a hard link) only loses
    this name."""
    for role in roles:
        try:
            (Path(root) / (role + '.wav')).unlink()
        except FileNotFoundError:
            pass
