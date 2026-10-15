import pytest

from chordbuddy.chords import chord_label


@pytest.mark.parametrize('raw,expected', [
    ('G#:min7/b7','G#m7/F#'), ('G#min7/b7','G#m7/F#'),
    ('G#m7/b7','G#m7/F#'), ('C:maj/3','C/E'), ('Bb:7/3','Bb7/D'),
    ('Eb:min/b3','Ebm/Gb'), ('F#:maj7/7','F#maj7/E#'),
    ('C:hdim7/b5','Cm7b5/Gb'), ('C:sus4(b7)','C7sus4'),
    ('G#m7/F#','G#m7/F#'), ('N','N'), ('C:unrecognized','C:unrecognized'),
    ('C:maj/nonsense','C:maj/nonsense'), ('A:min','Am'),
])
def test_musician_facing_labels(raw,expected):
    assert chord_label(raw)==expected
