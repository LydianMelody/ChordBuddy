"""Where a recording first makes a sound: the chart hides a bar the model gave a chord over the silence before it."""
import array
import math
import struct

from chordbuddy.sound_start import sound_start, song_sound_start

RATE = 44100


def write_wav(path, seconds_silent, seconds_sound, level=0.1):
    frames = array.array('f')
    for i in range(int(seconds_silent * RATE)):
        frames.extend((0.0, 0.0))
    for i in range(int(seconds_sound * RATE)):
        value = level * math.sin(2 * math.pi * 440 * i / RATE)
        frames.extend((value, value))
    data = frames.tobytes()
    header = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE'
    header += b'fmt ' + struct.pack('<IHHIIHH', 16, 3, 2, RATE, RATE * 8, 8, 32)
    path.write_bytes(header + b'data' + struct.pack('<I', len(data)) + data)
    return path


def test_the_first_moment_of_sound_is_found(tmp_path):
    assert sound_start(write_wav(tmp_path / 'a.wav', 0.33, 1.0)) == 0.33          # Wonderland's opening silence
    assert sound_start(write_wav(tmp_path / 'b.wav', 0.0, 1.0)) == 0.0
    assert sound_start(write_wav(tmp_path / 'c.wav', 2.5, 0.5)) == 2.5           # past the first second read


def test_noise_far_below_hearing_is_still_silence(tmp_path):
    assert sound_start(write_wav(tmp_path / 'hiss.wav', 0.0, 1.0, level=1e-5)) is None   # about -100 dB: nothing to hear


def test_unreadable_or_silent_recordings_tell_nothing(tmp_path):
    assert sound_start(tmp_path / 'missing.wav') is None
    (tmp_path / 'junk.wav').write_bytes(b'not a wav')
    assert sound_start(tmp_path / 'junk.wav') is None
    assert sound_start(write_wav(tmp_path / 'quiet.wav', 1.0, 0.0)) is None


def test_a_song_uses_its_prepared_recording(tmp_path):
    stage = tmp_path / 'analysis' / 'abc'
    stage.mkdir(parents=True)
    write_wav(stage / 'original.wav', 0.5, 0.5)
    assert song_sound_start(tmp_path) == 0.5
    assert song_sound_start(tmp_path / 'no-such-song') is None


def test_the_chart_document_says_where_the_sound_starts(tmp_path, mp3_bytes):
    from test_chart import prepare_chart, chart_document
    library, store, song, run = prepare_chart(tmp_path, mp3_bytes)
    assert chart_document(store, song['id'])['music']['sound_start'] is None      # no prepared recording yet: nothing is hidden
    stage = library.folder(song['id']) / 'analysis' / 'stage'
    stage.mkdir(parents=True, exist_ok=True)
    write_wav(stage / 'original.wav', 0.33, 0.5)
    assert chart_document(store, song['id'])['music']['sound_start'] == 0.33


def write_tail_wav(path, seconds_sound, seconds_silent, level=0.1):
    frames = array.array('f')
    for i in range(int(seconds_sound * RATE)):
        value = level * math.sin(2 * math.pi * 440 * i / RATE)
        frames.extend((value, value))
    for i in range(int(seconds_silent * RATE)):
        frames.extend((0.0, 0.0))
    data = frames.tobytes()
    header = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE'
    header += b'fmt ' + struct.pack('<IHHIIHH', 16, 3, 2, RATE, RATE * 8, 8, 32)
    path.write_bytes(header + b'data' + struct.pack('<I', len(data)) + data)
    return path


def test_the_last_moment_of_sound_is_found(tmp_path):
    from chordbuddy.sound_start import sound_end, song_sound_end
    assert abs(sound_end(write_tail_wav(tmp_path / 'a.wav', 1.5, 2.5)) - 1.5) < 0.02     # silence after the music, past the last second read
    assert abs(sound_end(write_tail_wav(tmp_path / 'b.wav', 1.0, 0.0)) - 1.0) < 0.02     # sound to the very end of the file
    assert sound_end(write_tail_wav(tmp_path / 'c.wav', 0.0, 1.0)) is None
    assert sound_end(tmp_path / 'missing.wav') is None
    stage = tmp_path / 'analysis' / 'abc'
    stage.mkdir(parents=True)
    write_tail_wav(stage / 'original.wav', 0.5, 0.5)
    assert abs(song_sound_end(tmp_path) - 0.5) < 0.02
