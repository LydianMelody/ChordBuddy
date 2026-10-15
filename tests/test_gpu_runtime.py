import os
from chordbuddy.library import Library
from chordbuddy.engine import local_environment

def test_explicit_gpu_preference_round_trips(tmp_path):
    library=Library(tmp_path)
    assert library.settings({'device':'cuda'})['device']=='cuda'
    assert library.read_settings()['device']=='cuda'

def test_bundled_ffmpeg_is_on_worker_path(tmp_path):
    tools=tmp_path/'tools';tools.mkdir();(tools/'ffmpeg.exe').write_bytes(b'fixture')
    assert local_environment(tmp_path)['PATH'].split(os.pathsep)[0]==str(tools)
