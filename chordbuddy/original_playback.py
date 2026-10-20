"""Playing a song whose stems have not been split: the original recording, in the same wire format as the stems.

The player streams eight tracks per frame (the recording and seven stems). With no stems, the recording is track 0 and the other seven
are silent, and the player is told to play only the recording. The recording is the analysis' own prepared copy (44.1 kHz stereo
float WAV), so nothing is decoded or copied again. The run id is `orig-<song id>`; it never exists in the separation store.
"""
import sys
from pathlib import Path

from .separation_audio import index_wav, read_frames
from .separation_contract import TRACKS, SAMPLE_RATE

PREFIX = 'orig-'
# Headroom: a float WAV made from an MP3 can slightly exceed full scale.
GAIN = 0.9


def run_id(song_id):
    return PREFIX + song_id


def song_of(run):
    return run[len(PREFIX):] if isinstance(run, str) and run.startswith(PREFIX) and len(run) > len(PREFIX) else None


def describe(song_id, path):
    """(public manifest, full description) of the prepared recording at `path`."""
    path = Path(path)
    info = index_wav(path)
    stat = path.stat()
    public = {'schema_version': 1, 'run_id': run_id(song_id), 'song_id': song_id, 'sample_rate': SAMPLE_RATE, 'channels': 2,
              'frames': info['frames'], 'common_gain': GAIN, 'recipe_sha256': None, 'stems': False}
    asset = dict(info, role='original', file_sha256=f'{stat.st_size}-{stat.st_mtime_ns}', relative_path=path.name)
    return public, {'root': path.parent, 'manifest': dict(public, assets=[asset]), 'asset': asset}


def wire_chunk(description, start, count):
    """The same bytes the stems stream: tracks in TRACKS order, the recording first, silence for every stem."""
    manifest = description['manifest']
    if type(count) is not int or not 1 <= count <= SAMPLE_RATE or type(start) is not int or not 0 <= start < manifest['frames']:
        raise ValueError('Invalid PCM frame bounds')
    actual = min(count, manifest['frames'] - start)
    asset = description['asset']
    values = read_frames(description['root'] / asset['relative_path'], asset, start, actual)
    if sys.byteorder != 'little':
        values.byteswap()
    silence = bytes(actual * 8)
    return values.tobytes() + silence * (len(TRACKS) - 1), actual
