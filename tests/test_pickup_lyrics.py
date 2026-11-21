"""A lyric anchor may sit in the bar just before its section (a pickup), and no earlier."""
import pytest
from chordbuddy.chart import validate_layout, pickup_start


def bars():
    return [{'id': 'm%d' % i, 'number': i + 1, 'start': float(i * 2), 'end': float(i * 2 + 2), 'beats': [i * 2.0, i * 2 + 1.0]} for i in range(6)]


SECTIONS = [{'id': 'v', 'start': 0.0, 'end': 8.0, 'lyrics': 'one two'}, {'id': 'c', 'start': 8.0, 'end': 12.0, 'lyrics': 'And so on'}]


def layout(measure, beat, first='m3'):
    return {'bars_per_line': 4, 'breaks': [], 'bar_overrides': [], 'lines': [
        {'section_id': 'c', 'line': 0, 'start_measure': first, 'end_measure': 'm5', 'words': [{'offset': 0, 'measure_id': measure, 'beat': beat}]}]}


def test_pickup_window_is_the_bar_before_the_section():
    assert pickup_start(bars(), SECTIONS[1]) == 6.0
    assert pickup_start(bars(), SECTIONS[0]) == 0.0           # the first section has no bar before it


def test_a_word_in_the_bar_before_the_section_is_accepted():
    music = {'measures': bars()}
    validate_layout(layout('m3', 1), SECTIONS, music)          # 7.0 s, inside bar 4, one bar before the Chorus


def test_a_word_two_bars_before_the_section_is_rejected():
    music = {'measures': bars()}
    with pytest.raises(ValueError):
        validate_layout(layout('m2', 1, first='m2'), SECTIONS, music)
    with pytest.raises(ValueError):
        validate_layout(layout('m2', 1), SECTIONS, music)
