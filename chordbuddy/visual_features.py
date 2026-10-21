"""What each stem is doing, frame by frame, for the visualizer: loudness, frequency bands, brightness and hits.

Worked out once per separation run (a few seconds) and saved beside its stems, so visuals can look any moment up by song time. That keeps
them exactly in step at any practice speed, while paused, scrubbing or looping. The values are measured before the mixer: the visualizer
applies the mixer's levels and mutes itself when it reads them.
"""
import base64
import json
import threading
from pathlib import Path
import numpy as np
from .separation_contract import SAMPLE_RATE, TRACKS

VERSION = 1
FPS = 100                                   # frames per second of song time: one every 10 ms
HOP = SAMPLE_RATE // FPS
WINDOW = 2048
BAND_EDGES = (30, 80, 180, 400, 900, 2000, 4500, 10000, 18000)   # eight bands, bass to air
FLOOR_DB = -60.0                            # loudness and band values map -60..0 dBFS onto 0..255
MIN_GAP = 0.06                              # two hits on one stem are at least this far apart (seconds)
CACHE_NAME = 'visual-features.json'
_locks = {}
_locks_guard = threading.Lock()


def _mono(path, info):
    """The stem as mono float32, read straight from its float WAV."""
    data = np.fromfile(path, dtype='<f4', count=info['frames'] * 2, offset=info['data_offset'])
    return data.reshape(-1, 2).mean(axis=1, dtype=np.float32)


def _to_byte(db):
    return np.clip(np.round((db - FLOOR_DB) / -FLOOR_DB * 255), 0, 255).astype(np.uint8)


def _encode(values):
    return base64.b64encode(np.ascontiguousarray(values, dtype=np.uint8).tobytes()).decode('ascii')


def _onsets(flux, gap_frames):
    """Hits: peaks of the spectral flux that stand out from their surroundings. Returns [(frame, strength 0..1)]."""
    if not len(flux) or flux.max() <= 0:
        return []
    width = FPS // 2
    padded = np.pad(flux, width, mode='edge')
    local = np.lib.stride_tricks.sliding_window_view(padded, 2 * width + 1)
    threshold = np.median(local, axis=1) + 0.1
    peaks = np.flatnonzero((flux > threshold) & (flux >= np.roll(flux, 1)) & (flux > np.roll(flux, -1)))
    hits = []
    for frame in peaks:
        if hits and frame - hits[-1][0] < gap_frames:
            if flux[frame] > flux[hits[-1][0]]:
                hits[-1] = (int(frame), float(flux[frame]))
            continue
        hits.append((int(frame), float(flux[frame])))
    return hits


def stem_features(samples):
    """Per-frame features of one mono stem. Every array has one value per frame (bands: eight per frame)."""
    frames = max(1, -(-len(samples) // HOP))
    padded = np.pad(samples, (WINDOW // 2, WINDOW // 2 + frames * HOP - len(samples)))
    window = np.hanning(WINDOW).astype(np.float32)
    freqs = np.fft.rfftfreq(WINDOW, 1 / SAMPLE_RATE)
    band_of = np.digitize(freqs, BAND_EDGES) - 1                      # -1 or 8: outside the bands
    centroid_bins = (freqs >= 60) & (freqs <= 12000)
    level = np.empty(frames, np.float32); bands = np.empty((frames, 8), np.float32)
    brightness = np.empty(frames, np.float32); flux = np.zeros(frames, np.float32)
    previous = None
    for start in range(0, frames, 2048):                              # bounded memory: 2048 frames (about 20 s) at a time
        count = min(2048, frames - start)
        chunk = padded[start * HOP:(start + count - 1) * HOP + WINDOW]
        blocks = np.lib.stride_tricks.sliding_window_view(chunk, WINDOW)[::HOP][:count]
        power = np.abs(np.fft.rfft(blocks * window, axis=1)) ** 2 / (window.sum() ** 2 / 4)
        rms = np.sqrt(np.mean(blocks[:, WINDOW // 4: 3 * WINDOW // 4] ** 2, axis=1))
        level[start:start + count] = 20 * np.log10(rms + 1e-9)
        for band in range(8):
            bands[start:start + count, band] = 10 * np.log10(power[:, band_of == band].sum(axis=1) + 1e-12)
        weights = power[:, centroid_bins]
        centroid = (weights * freqs[centroid_bins]).sum(axis=1) / (weights.sum(axis=1) + 1e-12)
        brightness[start:start + count] = np.clip(np.log2(np.maximum(centroid, 100) / 100) / np.log2(80), 0, 1)
        magnitude = np.log1p(np.sqrt(power) * 100)
        before = previous if previous is not None else magnitude[:1]
        flux[start:start + count] = np.maximum(np.diff(np.vstack([before, magnitude]), axis=0), 0).mean(axis=1)
        previous = magnitude[-1:]
    quiet = level < FLOOR_DB + 6                                      # no hits in near-silence (separation bleed)
    flux[quiet] = 0
    scale = np.percentile(flux[flux > 0], 99) if (flux > 0).any() else 1
    flux = np.clip(flux / (scale or 1), 0, 1)
    return {
        'level': _encode(_to_byte(level)),
        'bands': _encode(_to_byte(bands).reshape(-1)),
        'brightness': _encode(np.round(brightness * 255)),
        'flux': _encode(np.round(flux * 255)),
        'hits': [[round(frame / FPS, 3), round(strength, 3)] for frame, strength in _onsets(flux, int(MIN_GAP * FPS))],
        'peak_db': round(float(level.max()), 2),
    }, frames


def compute(root, manifest):
    """Features for every track of a published separation run (the original recording too)."""
    root = Path(root)
    tracks = {}
    frames = None
    for asset in manifest['assets']:
        values, count = stem_features(_mono(root / asset['relative_path'], asset))
        tracks[asset['role']] = values
        frames = count if frames is None else min(frames, count)
    return {
        'version': VERSION, 'run_id': manifest['run_id'], 'fps': FPS, 'frames': frames, 'duration': manifest['frames'] / SAMPLE_RATE,
        'band_edges_hz': list(BAND_EDGES), 'floor_db': FLOOR_DB, 'tracks': tracks,
        'source': {a['role']: a['file_sha256'] for a in manifest['assets']},
    }


def load_or_compute(root, manifest):
    """The saved features for this run, worked out first if they are missing or were made from other audio or an older version."""
    if [a['role'] for a in manifest['assets']] != list(TRACKS):
        raise ValueError('Invalid playback roles')
    path = Path(root) / CACHE_NAME
    with _locks_guard:
        lock = _locks.setdefault(manifest['run_id'], threading.Lock())
    with lock:                                                        # two windows asking at once compute it once
        try:
            saved = json.loads(path.read_text(encoding='utf-8'))
            if saved.get('version') == VERSION and saved.get('source') == {a['role']: a['file_sha256'] for a in manifest['assets']}:
                return saved
        except (OSError, ValueError):
            pass
        result = compute(root, manifest)
        partial = path.with_name(CACHE_NAME + '.partial')
        partial.write_text(json.dumps(result, separators=(',', ':')), encoding='utf-8')
        partial.replace(path)
        return result
