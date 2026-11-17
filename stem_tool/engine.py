"""The work of replacing a stem: read the new audio, find where it lines up, set a safe level, and publish a new version of the song's stems.

How Chord Buddy keeps stems (read from its code, which this module only calls and never changes):
  * A split is a "run": a folder <song>/separation/<run id>/ holding original.wav and seven stem files (44.1 kHz stereo: 32-bit float WAV, or
    24-bit FLAC since stems were compressed, read the same way through chordbuddy/stem_audio.py), and a
    manifest.json that pins every file with a SHA-256 checksum. A run is never edited after it is published.
  * manifest['common_gain'] = min(1, 0.95 / peak), where peak is the loudest moment of the recording or of all stems added together. Playback
    multiplies everything by it, so the mix can never clip. Any new stem therefore cannot make the song clip: at worst the whole song is turned down.
  * The song's playable run is named in two places: the table song_separations, and the "separation" stage of the song's analysis job.

So a replacement is a NEW run: the other files are shared with the old run (hard links, no extra disk space where the drive allows), the new stem is
written beside them, Chord Buddy's own checker builds and verifies the manifest, and both places are pointed at the new run. The old run is left
exactly as it was, and the replaced stem is also kept in the new run under another name, so "put the original back" always works, even after the
app has tidied the old run's stems away.
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
from scipy.signal import correlate

from chordbuddy.analysis_contract import digest
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.library import Library
from chordbuddy.stem_audio import frames as stem_frames, index as stem_index, release, write_flac
from chordbuddy.separation_checks import validate_mix
from chordbuddy.separation_contract import SAMPLE_RATE, STEMS, TRACKS, file_hash
from chordbuddy.separation_store import SeparationStore

RATE = SAMPLE_RATE
STEM_WORDS = {'vocals': 'Vocals', 'bass': 'Bass', 'drums': 'Drums', 'piano': 'Piano', 'other': 'Other', 'lead': 'Lead guitar', 'rhythm': 'Rhythm guitar'}
MAX_SECONDS = 30 * 60            # longer than any song; a wrong file (an album, a podcast) is turned away
MAX_BOOST_DB = 24.0              # a very quiet file is never boosted more than this: past it, its noise would come up too
SILENT_DB = -50.0                # a stem quieter than this has nothing to match a level to (bleed and rounding noise)
SIT_BELOW_MIX_DB = -3.0          # with nothing to match, the new stem is set to sing this much below the loudness of the whole recording
LIMIT_FLOOR = .25                # the peak limiter never turns a moment down by more than this ratio (12 dB): past it, the stem itself is lowered
LIMIT_WINDOW = .012              # seconds the limiter looks ahead and eases in and out over
MAX_CUT_DB = 30.0
MAX_SONG_DROP_DB = 1.5           # the new stem may turn the WHOLE song down by at most this much to make room; past it, the stem itself is lowered
TRIM_RANGE_DB = (-12.0, 6.0)     # how far the level may be nudged by hand from the matched one
SEARCH_SECONDS = 30.0            # how far either way the start is looked for
EDGE_FADE = 0.01                 # seconds: a file that starts or stops mid-sound gets no click
DRIFT_WARN_MS = 40.0
BACKUP_SUFFIX = '.before-replacement.wav'      # beside an older float WAV stem; a FLAC stem's copy ends .before-replacement.flac
BACKUP_NAMES = ('.before-replacement.flac', BACKUP_SUFFIX)


class StemError(ValueError):
    """Something a person can fix, said in plain words."""


def db(value):
    return 20 * np.log10(max(float(value), 1e-12))


def gain_of(decibels):
    return float(10 ** (decibels / 20))


# ---------------------------------------------------------------- reading audio
def decode(ffmpeg, path):
    """Any audio file as 44.1 kHz stereo float samples, shape (frames, 2). ffmpeg does the reading, as it does for the app."""
    ffmpeg, path = Path(ffmpeg), Path(path)
    if not ffmpeg.is_file():
        raise StemError('The audio decoder (tools/ffmpeg.exe) is missing from the Chord Buddy folder.')
    if not path.is_file():
        raise StemError('That file is not there any more.')
    run = subprocess.run([str(ffmpeg), '-nostdin', '-v', 'error', '-i', str(path), '-vn', '-ar', str(RATE), '-ac', '2', '-t', str(MAX_SECONDS + 1),
                          '-f', 'f32le', 'pipe:1'], capture_output=True, timeout=300, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if run.returncode or not run.stdout:
        raise StemError('That file could not be read as audio. WAV, FLAC, MP3 and M4A all work.')
    audio = np.frombuffer(run.stdout, dtype='<f4', count=len(run.stdout) // 8 * 2).reshape(-1, 2)
    return check_audio(audio)


def check_audio(audio):
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim != 2 or audio.shape[1] != 2 or len(audio) < RATE // 2:
        raise StemError('That file has less than half a second of sound in it.')
    if len(audio) > MAX_SECONDS * RATE:
        raise StemError('That file is longer than 30 minutes, which is not one song. Choose the one song’s vocal file.')
    if not np.isfinite(audio).all():
        raise StemError('That file has damaged samples in it. Export it again from the program that made it.')
    if float(np.abs(audio).max()) < 1e-5:
        raise StemError('That file is silent.')
    return audio


def read_wav(path, info):
    """One of the app's own stem files (float WAV or FLAC), as a (frames, 2) array-like whose slices read only that part."""
    return stem_frames(path, info)


def backup_file(root, role):
    """The copy of `role`'s stem kept from before it was replaced, in folder `root`: its path, or None."""
    for suffix in BACKUP_NAMES:
        path = Path(root) / (role + suffix)
        if path.is_file():
            return path
    return None


def write_wav(path, audio):
    audio = np.ascontiguousarray(audio, dtype='<f4')
    size = audio.size * 4
    with open(path, 'wb') as out:
        out.write(struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + size, b'WAVE', b'fmt ', 16, 3, 2, RATE, RATE * 8, 8, 32, b'data', size))
        audio.tofile(out)


# ---------------------------------------------------------------- lining up
def envelope(audio, hop):
    """How loud the sound is over time (one number per `hop` frames), on a decibel-like scale so a quiet verse counts as much as a loud chorus."""
    mono = np.asarray(audio, dtype=np.float32).mean(axis=1) if np.ndim(audio) == 2 else np.asarray(audio, dtype=np.float32)
    count = len(mono) // hop
    if count < 4:
        return np.zeros(0, dtype=np.float32)
    power = np.sqrt((mono[:count * hop].reshape(count, hop).astype(np.float64) ** 2).mean(axis=1))
    return np.log1p(power * 200).astype(np.float32)


def _best_lag(new, ref, max_lag):
    """The shift (in envelope steps) of `new` that fits `ref` best, and how clearly it wins (0 to 1)."""
    if len(new) < 8 or len(ref) < 8:
        return 0, 0.0
    a, b = ref - ref.mean(), new - new.mean()
    scale = float(np.linalg.norm(a) * np.linalg.norm(b))
    if scale <= 0:
        return 0, 0.0
    full = correlate(a, b, mode='full', method='fft')
    lags = np.arange(-(len(b) - 1), len(a))
    keep = np.abs(lags) <= max_lag
    scores, lags = full[keep] / scale, lags[keep]
    return int(lags[int(np.argmax(scores))]), float(max(0.0, scores.max()))


def find_offset(new, ref, search_seconds=SEARCH_SECONDS):
    """Where the new audio belongs in the song: {offset (frames; positive: it starts later than the file does), confidence 0-1, drift_ms, words}.

    The two are compared by their loudness over time, not by their exact sound, so another singer's take of the same song still lines up.
    First to the nearest 10 ms over the whole song, then to the nearest millisecond near that. drift_ms compares the fit at the start of the
    song with the fit at the end: a large value means the two were not recorded to the same tempo."""
    coarse_hop, fine_hop = RATE // 100, RATE // 1000
    lag, confidence = _best_lag(envelope(new, coarse_hop), envelope(ref, coarse_hop), int(search_seconds * 100))
    offset = lag * coarse_hop
    def both(begin, length):
        """The part of [begin, begin+length) of the song that the new audio also covers, as (song start, file start, frames)."""
        first = max(begin, offset, 0)
        last = min(begin + length, offset + len(new), len(ref))
        return first, first - offset, max(0, last - first)

    # finer, within 30 ms either side of the rough answer, on up to a minute where both have sound
    at, src, count = both(0, len(ref))
    if count > 60 * RATE:                                   # the middle minute of what they share
        at, src, count = both(at + (count - 60 * RATE) // 2, 60 * RATE)
    if count >= 2 * RATE:
        fine, _ = _best_lag(envelope(new[src:src + count], fine_hop), envelope(ref[at:at + count], fine_hop), 30)
        offset += fine * fine_hop
    # the fit of the first and last thirds of what they share, separately
    drift = 0.0
    at, src, count = both(0, len(ref))
    third = count // 3
    if third > 6 * RATE:
        fits = []
        for begin in (at, at + count - third):
            a_from, n_from, n = both(begin, third)
            fits.append(_best_lag(envelope(new[n_from:n_from + n], fine_hop), envelope(ref[a_from:a_from + n], fine_hop), 400)[0] * fine_hop)
        drift = (fits[1] - fits[0]) / RATE * 1000
    if confidence >= .6:
        words = 'A clear match.'
    elif confidence >= .35:
        words = 'A likely match. Listen to the preview before replacing.'
    else:
        words = 'No clear match was found, so this is a guess. Listen to the preview and set the start by hand if it is off.'
    if abs(drift) > DRIFT_WARN_MS:
        words += f' The start and the end of the song disagree by {abs(drift):.0f} ms, which usually means this was recorded to a different version or tempo. It may sound in time at first and drift later.'
    return {'offset': int(offset), 'confidence': round(confidence, 3), 'drift_ms': round(float(drift), 1), 'words': words}


# ---------------------------------------------------------------- level
def loudness_db(audio):
    """How loud the audio is while there is sound in it: silent stretches are left out, so a vocal that rests for half the song is not called quiet."""
    mono = np.asarray(audio, dtype=np.float32)
    block, hop = int(.4 * RATE), int(.1 * RATE)
    if len(mono) < block:
        return db(np.sqrt(float((mono.astype(np.float64) ** 2).mean())))
    squares = (mono.astype(np.float64) ** 2).mean(axis=1) if mono.ndim == 2 else mono.astype(np.float64) ** 2
    sums = np.concatenate(([0.0], np.cumsum(squares)))
    starts = np.arange(0, len(squares) - block + 1, hop)
    power = (sums[starts + block] - sums[starts]) / block
    loud = power[power > 1e-7]                       # above about -70 dB
    if not len(loud):
        return -120.0
    kept = loud[loud > loud.mean() * .1]             # and within 10 dB of the average of those
    return db(np.sqrt(float((kept if len(kept) else loud).mean())))


def place(new, frames, offset, gain=1.0):
    """The new audio as a whole stem for the song: moved to its place, cut or padded to the song's length, its cut ends faded, at this gain."""
    out = np.zeros((frames, 2), dtype=np.float32)
    src_from, dst_from = max(0, -offset), max(0, offset)
    count = min(len(new) - src_from, frames - dst_from)
    if count <= 0:
        raise StemError('With that start, none of the new audio falls inside the song.')
    out[dst_from:dst_from + count] = new[src_from:src_from + count]
    fade = min(int(EDGE_FADE * RATE), count // 2)
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)[:, None]
        if src_from > 0 or abs(float(new[src_from].max())) > 1e-4:
            out[dst_from:dst_from + fade] *= ramp
        out[dst_from + count - fade:dst_from + count] *= ramp[::-1]
    if gain != 1.0:
        out *= np.float32(gain)
    return out


def _peaks(root, manifest, role, new, old=None):
    """The loudest moment with the old stem, and with the new one in its place (both counting the recording itself, as the app's rule does).
    old: the stem to count as the old one (the song's own), when that is not the one in the song now."""
    assets = {a['role']: a for a in manifest['assets']}
    maps = {r: read_wav(Path(root) / a['relative_path'], a) for r, a in assets.items()}
    old_peak = new_peak = 0.0
    for start in range(0, manifest['frames'], RATE * 4):
        end = min(manifest['frames'], start + RATE * 4)
        rest = np.zeros((end - start, 2), dtype=np.float64)
        for r in STEMS:
            if r != role:
                rest += np.abs(maps[r][start:end])
        original = float(np.abs(maps['original'][start:end]).max())
        old_peak = max(old_peak, original, float((rest + np.abs((maps[role] if old is None else old)[start:end])).max()))
        new_peak = max(new_peak, original, float((rest + np.abs(new[start:end])).max()))
    return old_peak, new_peak


def _headroom(root, manifest, role, new, allowed):
    """The largest gain for `new` at which the stems never add up to more than `allowed` (found exactly, sample by sample)."""
    assets = {a['role']: a for a in manifest['assets']}
    maps = {r: read_wav(Path(root) / assets[r]['relative_path'], assets[r]) for r in STEMS if r != role}
    most = np.inf
    for start in range(0, manifest['frames'], RATE * 4):
        end = min(manifest['frames'], start + RATE * 4)
        rest = np.zeros((end - start, 2), dtype=np.float64)
        for m in maps.values():
            rest += np.abs(m[start:end])
        loud = np.abs(new[start:end]).astype(np.float64)
        sounding = loud > 1e-9
        if sounding.any():
            most = min(most, float((np.maximum(allowed - rest[sounding], 0) / loud[sounding]).min()))
    return most if np.isfinite(most) else 1.0


def ease_to_headroom(root, manifest, role, stem, allowed):
    """The new stem with its loudest moments eased down, only as far as needed, so that it and the other stems never add up to more than
    `allowed` (and never by more than LIMIT_FLOOR at any moment). Returns (stem, {'reduction_db': the most it was turned down, 'share': the part of
    the song it was turned down by more than half a decibel}).

    A vocal recorded with its peaks near full scale has a low average level: bringing its average up to where a vocal sits in a mix would push those
    peaks past what the recording had room for, and the app would then turn the WHOLE song down to fit them. Easing just the peaks leaves the song
    as loud as it was. (Easing a brief peak by many decibels is not audible; easing a long stretch is, which is why there is a floor.) The gain follows a short look-ahead (a minimum over LIMIT_WINDOW, then an average of the same width), which can never turn a
    moment down less than it needs and changes the gain smoothly, so it does not crackle."""
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    assets = {a['role']: a for a in manifest['assets']}
    maps = {r: read_wav(Path(root) / assets[r]['relative_path'], assets[r]) for r in STEMS if r != role}
    frames = manifest['frames']
    need = np.ones(frames, dtype=np.float32)
    for start in range(0, frames, RATE * 4):
        end = min(frames, start + RATE * 4)
        rest = np.zeros((end - start, 2), dtype=np.float64)
        for m in maps.values():
            rest += np.abs(m[start:end])
        rest = rest.max(axis=1)
        loud = np.abs(stem[start:end]).max(axis=1).astype(np.float64)
        room = np.maximum(allowed * .999 - rest, 0)
        ratio = np.where(loud > 1e-9, np.minimum(1.0, room / np.maximum(loud, 1e-9)), 1.0)
        need[start:end] = np.maximum(ratio, LIMIT_FLOOR)
    if need.min() >= 1.0:
        return stem, {'reduction_db': 0.0, 'share': 0.0}
    width = max(3, int(LIMIT_WINDOW * RATE)) | 1
    gain = uniform_filter1d(minimum_filter1d(need, width, mode='nearest'), width, mode='nearest').astype(np.float32)
    gain = np.minimum(gain, need)                       # (they already are: this only guards against rounding)
    return stem * gain[:, None], {'reduction_db': round(-db(float(gain.min())), 1), 'share': float((gain < .944).mean())}


def plan_level(root, manifest, role, placed, trim_db=0.0, own=None):
    """The level for the new stem, and what it does to the song. `placed` is the new stem at gain 1 (frames x 2). `own`: the song's own stem of
    that kind, to match the level to (default: the one in the song now).

    1. Level. It is matched to the loudness of the song's own stem. If there is none (a song that had no vocals), it is set to sit SIT_BELOW_MIX_DB
       below the loudness of the whole recording, the way a vocal sits in a mix: a starting point, nudged by `trim_db` (the Level slider).
    2. Peaks. Its loudest moments are eased down just enough that the song's overall level stays as it was; the whole song is turned down only if
       that is not enough. The returned 'stem' is exactly what will be saved, and what the preview plays."""
    assets = {a['role']: a for a in manifest['assets']}
    own = read_wav(Path(root) / assets[role]['relative_path'], assets[role]) if own is None else own
    own_loud, new_loud = loudness_db(own), loudness_db(placed)
    notes = []
    if own_loud < SILENT_DB:
        mix = read_wav(Path(root) / assets['original']['relative_path'], assets['original'])
        reference = loudness_db(mix) + SIT_BELOW_MIX_DB
        matched = reference - new_loud
        notes.append(f'The song has no {STEM_WORDS[role].lower()} of its own to match, so the new one was set to sit {abs(SIT_BELOW_MIX_DB):.0f} dB below the loudness of the whole recording, '
                     'as a vocal usually does. That is a starting point: use the Level slider to taste.')
        own_loud = reference
    else:
        matched = own_loud - new_loud
    trim = float(min(TRIM_RANGE_DB[1], max(TRIM_RANGE_DB[0], trim_db)))
    wanted = matched + trim
    if wanted > MAX_BOOST_DB:
        notes.append(f'The file is very quiet. It was turned up by {MAX_BOOST_DB:.0f} dB, the most allowed, and is still quieter than it should be.')
    gain_db = float(min(MAX_BOOST_DB, max(-MAX_CUT_DB, wanted)))
    lowered = 0.0
    # how loud the song was before: with its own stem (never an earlier try), which is what its level must not fall below
    for attempt in range(5):
        scaled = placed * np.float32(gain_of(gain_db))
        if attempt == 0:
            baseline, _ = _peaks(root, manifest, role, scaled, own)
            baseline_common = min(1.0, .95 / baseline) if baseline else 1.0
        stem, eased = ease_to_headroom(root, manifest, role, scaled, baseline)
        _, final_peak = _peaks(root, manifest, role, stem, own)
        common = min(1.0, .95 / final_peak) if final_peak else 1.0
        drop = db(baseline_common) - db(common)
        if drop <= MAX_SONG_DROP_DB + .05 or gain_db <= -MAX_CUT_DB:
            break
        step = drop - MAX_SONG_DROP_DB + .1                   # easing the peaks was not enough (a click far above everything): the stem itself comes down
        gain_db = max(-MAX_CUT_DB, gain_db - step)
        lowered += step
    if eased['reduction_db'] >= 1.0:
        notes.append(f'Its loudest moments were eased down by up to {eased["reduction_db"]:.0f} dB, so the rest of the song keeps its level. '
                     + ('That is a lot: if it sounds squashed, lower the Level slider.' if eased['reduction_db'] >= 5 or eased['share'] > .02 else 'That is gentle.'))
    if lowered >= .5:
        notes.append(f'It has a few very loud spikes, so it was lowered a further {lowered:.1f} dB to keep the rest of the song close to its level.')
    song_change = db(common) - db(baseline_common)
    if song_change < -.1:
        notes.append(f'Even so, the whole song will play {abs(song_change):.1f} dB quieter than before, to leave room for the new peaks. Nothing can clip.')
    return {'gain_db': round(gain_db, 2), 'matched_db': round(float(matched), 2), 'trim_db': round(trim, 2), 'old_loudness_db': round(own_loud, 1),
            'new_loudness_db': round(new_loud + gain_db, 1), 'song_change_db': round(float(song_change), 2), 'common_gain': common, 'notes': notes,
            'eased_db': eased['reduction_db'], 'eased_share': eased['share'], 'stem': stem}


# ---------------------------------------------------------------- the library
def app_running():
    """True when Chord Buddy itself is open. The tool and the app must never write to the library at the same time."""
    if os.name != 'nt':
        return False
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command',
                              "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\" | ForEach-Object { $_.CommandLine }"],
                             capture_output=True, text=True, timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(('portable_start.py' in line or 'chordbuddy.__main__' in line or '-m chordbuddy' in line) and 'stem_tool' not in line for line in out.splitlines())


class Workspace:
    """A library opened for stem replacement. Close it when done."""
    def __init__(self, library_root, project):
        self.project = Path(project).resolve()
        self.library = Library(library_root, project_dir=self.project)
        self.store = SeparationStore(self.library)
        self.analysis = AnalysisStore(self.library)

    def close(self):
        self.library.close()

    def songs(self):
        """Songs that have stems to replace: [{id, title, artist, replaced: the stems already replaced}]."""
        out = []
        for song in self.library.state()['songs']:
            try:
                root, manifest = self.active(song['id'])
            except (KeyError, ValueError, OSError):
                continue
            out.append({'id': song['id'], 'title': song['title'], 'artist': song.get('artist') or '', 'seconds': manifest['frames'] / RATE,
                        'replaced': sorted((manifest.get('replaced') or {}).keys())})
        return sorted(out, key=lambda s: s['title'].lower())

    def active(self, song_id):
        """The song's published stems: (folder, manifest). KeyError if it has none."""
        with self.library.lock:
            row = self.library.db.execute('SELECT active_id FROM song_separations WHERE song_id=?', (song_id,)).fetchone()
        if not row or not row['active_id']:
            raise KeyError('This song has no split stems. Split its stems in Chord Buddy first.')
        return self.store.get_published_run(row['active_id'])

    def stem(self, song_id, role):
        root, manifest = self.active(song_id)
        asset = next(a for a in manifest['assets'] if a['role'] == role)
        return read_wav(root / asset['relative_path'], asset)

    def own_stem(self, song_id, role):
        """The song's OWN `role` stem as a (frames, 2) array, for matching a level to: the one kept before any replacement if this stem has been
        replaced (so a second try is matched to the song, never to the first try), else the current one."""
        path = self.backup(song_id, role)
        if path is not None:
            return read_wav(path, stem_index(path))
        return self.stem(song_id, role)

    def backup(self, song_id, role):
        """The stem that was replaced, if this song's `role` stem is a replacement: its path, else None."""
        root, manifest = self.active(song_id)
        path = backup_file(root, role)
        return path if role in (manifest.get('replaced') or {}) else None

    # ------------------------------------------------------------ publishing
    def replace(self, song_id, role, stem, report=None, restoring=None):
        """Publish a new version of the song's stems with `stem` (frames x 2, the song's length) as its `role` stem. Returns {run_id, previous_run_id, common_gain}.
        restoring: the path of the song's own stem going back (`stem` holds its audio). That very file is used again, so it comes back
        exactly; it is no longer listed as replaced and no copy of the outgoing one is kept."""
        if role not in STEMS:
            raise StemError('Choose which stem to replace.')
        root, manifest = self.active(song_id)
        stem = np.asarray(stem, dtype=np.float32)
        if stem.shape != (manifest['frames'], 2) or not np.isfinite(stem).all():
            raise StemError('The new stem is not the same length as the song.')
        old_run = manifest['run_id']
        assets = {a['role']: a for a in manifest['assets']}
        new_run = self.store.create_run(song_id, manifest['recipe_sha256'])
        target = self.store.safe_path(new_run['folder'])
        published = False
        try:
            for r in TRACKS:
                if r != role:
                    _share(root / assets[r]['relative_path'], target / assets[r]['relative_path'])   # the same file, WAV or FLAC
            if restoring:
                _share(restoring, target / (role + Path(restoring).suffix))
            else:
                write_flac(target / (role + '.flac'), stem)
            # the stem being replaced travels with the new version, so it can always be put back
            if not restoring:
                earlier = backup_file(root, role) or root / assets[role]['relative_path']
                _share(earlier, target / (role + '.before-replacement' + earlier.suffix))
            # a copy kept for another stem replaced earlier stays with the song too
            for other in (manifest.get('replaced') or {}):
                kept = backup_file(root, other) if other != role else None
                if kept is not None:
                    _share(kept, target / kept.name)
            # the app's checker wants the guitar it once split into Lead and Rhythm; it is their sum, and is removed again afterwards as the app does
            # (read from the OLD folder, so nothing in the new one is held open if it has to be removed)
            lead, rhythm = (np.array(read_wav(root / assets[r]['relative_path'], assets[r])) if r != role else stem for r in ('lead', 'rhythm'))
            write_wav(target / 'guitar.wav', lead + rhythm)
            del lead, rhythm
            self.store.update_progress(new_run['id'], 'validating')
            fresh = validate_mix(target)
            replaced = dict(manifest.get('replaced') or {})
            if restoring:
                replaced.pop(role, None)
            else:
                replaced[role] = dict(report or {}, previous_run=old_run)
            fresh.update(source_sha256=manifest['source_sha256'], recipe=manifest.get('recipe'), recipe_sha256=manifest['recipe_sha256'], replaced=replaced)
            self.store.activate_validated(new_run['id'], fresh)
            published = True
            (target / 'guitar.wav').unlink(missing_ok=True)
            self._repoint_analysis(song_id, old_run, new_run['id'])
        except BaseException as exc:
            if published:                                     # the stems are valid and published, but the analysis still names the old ones: go back to them
                with self.library.transaction() as tx:
                    tx.execute('INSERT OR REPLACE INTO song_separations VALUES(?,?)', (song_id, old_run))
            try:
                self.store.fail_run(new_run['id'], 'failed', f'Stem replacement did not finish: {exc}')
            except Exception:
                pass
            if not published:
                release(target)
                shutil.rmtree(target, ignore_errors=True)
            raise
        _, now = self.store.get_published_run(new_run['id'])
        return {'run_id': new_run['id'], 'previous_run_id': old_run, 'common_gain': now['common_gain']}

    def _repoint_analysis(self, song_id, old_run, new_run):
        """The song's analysis names its stems by run. Give it a matching record for the new run, and point its completed jobs at that."""
        root, manifest = self.store.get_published_run(new_run)
        asset = lambda path: {'path': str(self.library.contained(path).relative_to(self.library.root)), 'sha256': file_hash(path)}
        stage_manifest = {'run_id': new_run, 'assets': [asset(root / 'manifest.json')] + [asset(root / a['relative_path']) for a in manifest['assets']]}
        with self.library.transaction() as tx:
            rows = tx.execute("SELECT * FROM analysis_stages WHERE song_id=? AND kind='separation'", (song_id,)).fetchall()
            moved = {}
            for row in rows:
                if json.loads(row['manifest']).get('run_id') != old_run:
                    continue
                ident = self.analysis._new_id()
                while tx.execute('SELECT 1 FROM analysis_stages WHERE id=?', (ident,)).fetchone():
                    ident = self.analysis._new_id()
                ref = dict(json.loads(row['reference']), id=ident, manifest_sha256=digest(stage_manifest))
                tx.execute('INSERT INTO analysis_stages VALUES(?,?,?,?,?,?)', (ident, song_id, 'separation', row['dependencies'], json.dumps(stage_manifest, allow_nan=False), json.dumps(ref)))
                moved[row['id']] = ident
            if not moved:
                return
            for row in tx.execute('SELECT id,snapshot FROM analysis_jobs').fetchall():
                job = json.loads(row['snapshot'])
                stage = (job.get('stages') or {}).get('separation') if job.get('song_id') == song_id else None
                if isinstance(stage, dict) and stage.get('id') in moved:
                    stage['id'] = moved[stage['id']]
                    tx.execute('UPDATE analysis_jobs SET snapshot=? WHERE id=?', (json.dumps(job, allow_nan=False), row['id']))

    def restore(self, song_id, role):
        """Put back the stem that was replaced. Returns what replace() returns."""
        path = self.backup(song_id, role)
        if path is None:
            raise StemError('This song’s stem has not been replaced, so there is nothing to put back.')
        original = np.array(read_wav(path, stem_index(path)))
        return self.replace(song_id, role, original, restoring=path)


def _share(source, target):
    """One file under two names where the drive allows it (no extra space), a copy where it does not."""
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def preview(root, manifest, role, stem, start, seconds, common_gain=None):
    """What the song will sound like from `start` (frames) for `seconds`: every other stem plus `stem`, at the level the app would play it."""
    assets = {a['role']: a for a in manifest['assets']}
    end = min(manifest['frames'], start + int(seconds * RATE))
    start = max(0, min(start, end - 1))
    mix = np.zeros((end - start, 2), dtype=np.float32)
    for r in STEMS:
        mix += stem[start:end] if r == role else read_wav(Path(root) / assets[r]['relative_path'], assets[r])[start:end]
    return mix * np.float32(manifest['common_gain'] if common_gain is None else common_gain)


# ---------------------------------------------------------------- for the timeline
PEAKS_PER_SECOND = 100


def peaks(audio, per_second=PEAKS_PER_SECOND):
    """The outline of a sound for drawing: its loudest moment in each hundredth of a second, as numbers from 0 to 1."""
    hop = RATE // per_second
    count = len(audio) // hop
    if count <= 0:
        return []
    loud = np.abs(np.asarray(audio[:count * hop], dtype=np.float32)).reshape(count, hop, -1).max(axis=(1, 2))
    return [round(float(x), 3) for x in np.minimum(loud, 1.0)]


def quick_gain_db(old, new):
    """The level match alone (no peak check): quick enough to use while the audio is being slid about. plan_level has the last word."""
    old_loud, new_loud = loudness_db(old), loudness_db(new)
    if old_loud < -70 or new_loud < -110:
        return 0.0
    return float(min(MAX_BOOST_DB, max(-MAX_CUT_DB, old_loud - new_loud)))


def place_part(new, offset, start, count):
    """`count` frames of the new audio as it would sit in the song from frame `start`, without building the whole stem (for previews)."""
    out = np.zeros((count, 2), dtype=np.float32)
    src_from, dst_from = start - offset, 0
    if src_from < 0:
        dst_from, src_from = -src_from, 0
    n = min(len(new) - src_from, count - dst_from)
    if n > 0:
        out[dst_from:dst_from + n] = new[src_from:src_from + n]
    return out
