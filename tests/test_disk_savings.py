"""A split keeps one copy of the decoded recording on disk: a second identical file becomes a hard link to the first."""
import os
from chordbuddy.separation import link_identical


def test_an_identical_file_becomes_a_hard_link(tmp_path):
    first, second, other = tmp_path / 'a.wav', tmp_path / 'b.wav', tmp_path / 'c.wav'
    first.write_bytes(b'decoded recording')
    second.write_bytes(b'decoded recording')
    other.write_bytes(b'something else!!')
    assert link_identical(second, [other, first])
    assert os.path.samefile(first, second) and second.read_bytes() == b'decoded recording'
    assert not list(tmp_path.glob('*.link'))


def test_a_different_file_is_left_alone(tmp_path):
    first, second = tmp_path / 'a.wav', tmp_path / 'b.wav'
    first.write_bytes(b'decoded recording')
    second.write_bytes(b'decoded  version')
    assert not link_identical(second, [first, tmp_path / 'missing.wav'])
    assert not os.path.samefile(first, second) and second.read_bytes() == b'decoded  version'
