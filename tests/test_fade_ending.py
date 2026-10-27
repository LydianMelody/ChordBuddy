"""A song that fades out: the chord cut off by the end of the file carries on at the same tempo on the lead sheet."""
from types import SimpleNamespace
import pytest
from chordbuddy.fade_ending import carry_through_fade, install_fade_ending

# the end of "Real Thing": the steady grid the model continues past the audio, and a C#m that starts 10 ms before the file ends
BEATS = [[304.49, 3, 4, 4], [304.99, 4, 4, 4], [305.49, 1, 4, 4], [305.99, 2, 4, 4]]


def test_the_chord_cut_off_by_a_fade_lasts_until_the_next_beat():
    chords = [[303.49, 305.49, 'B:maj'], [305.49, 305.5, 'C#:min']]
    assert carry_through_fade(BEATS, chords) == [[303.49, 305.49, 'B:maj'], [305.49, 305.99, 'C#:min']]
    assert chords[-1] == [305.49, 305.5, 'C#:min'], 'the model\'s own rows are not changed'


def test_anything_that_already_reaches_a_beat_or_has_none_after_it_is_left_alone():
    whole = [[300.0, 305.5, 'C#:min']]                        # started well before the last beat: already long enough
    assert carry_through_fade(BEATS, whole) == whole
    assert carry_through_fade(BEATS, [[305.995, 305.999, 'E']]) == [[305.995, 305.999, 'E']]   # nothing later to reach
    assert carry_through_fade(BEATS, []) == []


def test_only_the_lead_sheet_call_is_wrapped_and_it_is_always_put_back():
    seen = []
    exports = SimpleNamespace(generate_abc_from_data=lambda midi, beats, chords, keys, structures: seen.append((chords, keys, structures)))
    original = exports.generate_abc_from_data
    short = [[305.49, 305.5, 'x']]
    with install_fade_ending(None, exports=exports):
        exports.generate_abc_from_data(b'', BEATS, short, short, short)
    assert seen == [([[305.49, 305.99, 'x']],) * 3] and exports.generate_abc_from_data is original
    with pytest.raises(RuntimeError), install_fade_ending(None, exports=exports):
        raise RuntimeError('notation failed')
    assert exports.generate_abc_from_data is original
