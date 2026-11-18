import os
from pathlib import Path

import pytest

from chordbuddy.library import Library
from chordbuddy.library_tidy import tidy_library
from chordbuddy.path_policy import drop_job_cache, job_environment
from chordbuddy.separation_contract import file_hash, snapshot_source


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / 'Data')
    yield lib
    lib.close()


def job(song, kind, name):
    path = song / kind / name
    path.mkdir(parents=True)
    return path


def old_cache(work):
    """A c folder as jobs left it before they cleaned up: the empty cache folders, and a GPU cache with files in it."""
    for letter in 'hitmnrx':
        (work / 'c' / letter).mkdir(parents=True)
    (work / 'c' / 'n' / 'librosa_0123').mkdir()
    (work / 'c' / 'd' / '0' / '5').mkdir(parents=True)
    (work / 'c' / 'd' / '0' / '5' / 'kernel').write_bytes(b'k' * 1000)


def test_a_job_has_its_caches_while_it_runs_and_none_afterwards(tmp_path):
    work = tmp_path / 'work'
    work.mkdir()
    with job_environment(tmp_path, work) as env:
        assert Path(env['TEMP']) == work / 'c'
        assert Path(env['NUMBA_CACHE_DIR']).is_dir()
        assert not (work / 'c' / 'd').exists()      # the GPU cache is the shared one in .models, so no folder of its own
        (work / 'c' / 'tmp123').mkdir()
        (work / 'c' / 'tmp123' / 'scratch.wav').write_bytes(b'x')
    assert not (work / 'c').exists()
    assert work.is_dir()                              # only the cache goes; the job's results stay


def test_the_cache_goes_even_when_the_job_fails(tmp_path):
    work = tmp_path / 'work'
    work.mkdir()
    with pytest.raises(RuntimeError):
        with job_environment(tmp_path, work):
            raise RuntimeError('worker failed')
    assert not (work / 'c').exists()


def test_a_cache_with_a_file_still_open_is_left_alone(tmp_path):
    work = tmp_path / 'work'
    (work / 'c').mkdir(parents=True)
    with open(work / 'c' / 'busy.tmp', 'wb'):
        assert drop_job_cache(tmp_path, work) is False


def test_a_cache_outside_the_install_folder_is_never_removed(tmp_path):
    work = tmp_path / 'elsewhere'
    (work / 'c').mkdir(parents=True)
    assert drop_job_cache(tmp_path / 'install', work) is False
    assert (work / 'c').is_dir()


def test_a_job_gets_the_recording_as_a_link_not_a_copy(tmp_path):
    source = tmp_path / 'source.mp3'
    source.write_bytes(b'mp3 bytes')
    snapshot = tmp_path / 'job' / 'source.mp3'
    snapshot.parent.mkdir()
    assert snapshot_source(source, snapshot) == file_hash(source)
    assert os.path.samefile(source, snapshot)
    # Importing a new recording puts a new file under the song's name; the job keeps the one it worked from.
    replacement = tmp_path / 'new.mp3'
    replacement.write_bytes(b'new recording')
    os.replace(replacement, source)
    assert snapshot.read_bytes() == b'mp3 bytes'


def test_startup_tidies_songs_made_before_jobs_cleaned_up(tmp_path, library, mp3_bytes):
    song = library.folder(library.import_audio('song.mp3', mp3_bytes)['id'])
    source = song / 'source.mp3'
    stage = job(song, 'analysis', 'a' * 32)
    split = job(song, 'separation', 'b' * 32)
    older = job(song, 'separation', 'c' * 32)
    for work in (stage, split):
        (work / 'source.mp3').write_bytes(source.read_bytes())   # separate copies of the same recording
        old_cache(work)
    (older / 'source.mp3').write_bytes(b'the recording this song had before it was replaced')
    (stage / 'original.wav').write_bytes(b'wav')

    report = tidy_library(tmp_path, library)

    assert report['caches'] == 2 and report['linked'] == 2
    assert report['freed'] == 2 * 1000 + 2 * source.stat().st_size
    for work in (stage, split):
        assert not (work / 'c').exists()
        assert os.path.samefile(work / 'source.mp3', source)
    assert (older / 'source.mp3').read_bytes() == b'the recording this song had before it was replaced'
    assert (stage / 'original.wav').read_bytes() == b'wav'
    assert not list(song.rglob('*.link'))
    assert tidy_library(tmp_path, library) == {'caches': 0, 'cache_bytes': 0, 'linked': 0, 'freed': 0}


def test_copies_already_linked_to_each_other_count_as_freed_only_once_all_are_linked(tmp_path, library, mp3_bytes):
    song = library.folder(library.import_audio('song.mp3', mp3_bytes)['id'])
    first, second = job(song, 'separation', 'a' * 32), job(song, 'separation', 'b' * 32)
    (first / 'source.mp3').write_bytes((song / 'source.mp3').read_bytes())
    os.link(first / 'source.mp3', second / 'source.mp3')    # as importing a song file shares identical files
    report = tidy_library(tmp_path, library)
    assert report['linked'] == 2
    assert report['freed'] == (song / 'source.mp3').stat().st_size
    assert (song / 'source.mp3').stat().st_nlink == 3


def test_trashed_songs_are_tidied_too(tmp_path, library, mp3_bytes):
    ident = library.import_audio('song.mp3', mp3_bytes)['id']
    song = library.folder(ident)
    work = job(song, 'analysis', 'a' * 32)
    old_cache(work)
    library.trash_song(ident)
    assert tidy_library(tmp_path, library)['caches'] == 1
    assert not (work / 'c').exists()
