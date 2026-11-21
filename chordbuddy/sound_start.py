"""When a recording first makes a sound, so the chart can tell silence before the music from a bar of music.

The model always writes an opening downbeat, with a chord, at 0.00 s. When the recording begins with a moment of silence, that
becomes a short bar with a chord over nothing (Wonderland: one beat of C#m over the first 0.33 s). The chart's own rule hides
silence by its "no chord" placeholders, so it needs to know where the sound really starts to hide a bar the model gave a chord.

Read-only: it reads the analysis' prepared copy of the recording (44.1 kHz stereo float WAV) and changes nothing.
"""
import math
from functools import lru_cache
from pathlib import Path

from .separation_audio import index_wav, read_frames, SAMPLE_RATE

WINDOW = SAMPLE_RATE // 100      # 10 ms
THRESHOLD_DB = -60.0             # quieter than this is silence (an MP3's encoder noise sits far below it)
LIMIT = 30.0                     # only the opening is searched; a song silent for longer is left alone


def sound_start(path):
    """Seconds into the recording at `path` where it first rises above silence, or None when that cannot be told."""
    try:
        stat = Path(path).stat()
    except OSError:
        return None
    return _sound_start(str(path), stat.st_size, stat.st_mtime_ns)


@lru_cache(maxsize=64)
def _sound_start(path, size, mtime):
    try:
        info = index_wav(path)
    except (OSError, ValueError):
        return None
    floor = (10 ** (THRESHOLD_DB / 20)) ** 2 * WINDOW * 2
    frames = min(info['frames'], int(LIMIT * SAMPLE_RATE))
    try:
        for block in range(0, frames, SAMPLE_RATE):
            values = read_frames(path, info, block, min(SAMPLE_RATE, frames - block))
            for at in range(0, len(values) // 2 - WINDOW + 1, WINDOW):
                window = values[at * 2:(at + WINDOW) * 2]
                if sum(x * x for x in window) > floor:
                    return round((block + at) / SAMPLE_RATE, 3) if all(math.isfinite(x) for x in window) else None
    except (OSError, ValueError):
        return None
    return None


def song_sound_start(song_folder):
    """The sound start of a song's newest prepared recording (every analysis of one source prepares the same copy)."""
    try:
        recordings = sorted(Path(song_folder).glob('analysis/*/original.wav'), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    except OSError:
        return None
    for path in recordings:
        value = sound_start(path)
        if value is not None:
            return value
    return None


END_LIMIT = 60.0                 # only the last minute is searched; a song that is quiet for longer than that is left alone


def sound_end(path):
    """Seconds into the recording at `path` where it last falls to silence (a fade-out or ring-out ends here), or None when that cannot be
    told. The model keeps its beat grid and its last chord going to the very end of the file; this is where the sound really stops."""
    try:
        stat = Path(path).stat()
    except OSError:
        return None
    return _sound_end(str(path), stat.st_size, stat.st_mtime_ns)


@lru_cache(maxsize=64)
def _sound_end(path, size, mtime):
    try:
        info = index_wav(path)
    except (OSError, ValueError):
        return None
    floor = (10 ** (THRESHOLD_DB / 20)) ** 2 * WINDOW * 2
    total = info['frames']
    stop = max(0, total - int(END_LIMIT * SAMPLE_RATE))
    try:
        block_end = total
        while block_end > stop:
            block_start = max(stop, block_end - SAMPLE_RATE)
            values = read_frames(path, info, block_start, block_end - block_start)
            for at in range((len(values) // 2 - WINDOW) // 1, -1, -WINDOW):
                window = values[at * 2:(at + WINDOW) * 2]
                if len(window) < WINDOW * 2:
                    continue
                if sum(x * x for x in window) > floor:
                    return round((block_start + at + WINDOW) / SAMPLE_RATE, 3) if all(math.isfinite(x) for x in window) else None
            block_end = block_start
    except (OSError, ValueError):
        return None
    return None


def song_sound_end(song_folder):
    """The sound end of a song's newest prepared recording."""
    try:
        recordings = sorted(Path(song_folder).glob('analysis/*/original.wav'), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    except OSError:
        return None
    for path in recordings:
        value = sound_end(path)
        if value is not None:
            return value
    return None
