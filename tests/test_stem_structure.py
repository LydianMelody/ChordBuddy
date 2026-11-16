"""Copying a song's sections and lyrics onto another version of it (stem_tool/structure.py). Every result is checked by the app's own chart rules."""
import copy
import json

import pytest

from chordbuddy.chart import validate_chart
from chordbuddy.documents import DocumentStore
from chordbuddy.library import Library
from stem_tool import structure

BAR = 2.0


def measures(count=24, first=0.0):
    return [{'id': f'm{i}', 'number': i + 1, 'start': first + i * BAR, 'end': first + (i + 1) * BAR,
             'beats': [first + i * BAR + k * BAR / 4 for k in range(4)]} for i in range(count)]


def original(count=24):
    """The song set up by hand: three named sections, lyrics in two of them placed word by word on the bars, and one repeat shown expanded."""
    duration = count * BAR
    chords = [{'id': f'c{i}', 'label': ['B', 'C#m7', 'A', 'B'][i % 4], 'start': i * BAR, 'end': (i + 1) * BAR, 'section_id': 's0' if i < 8 else 's1' if i < 16 else 's2', 'line': None, 'offset': None}
              for i in range(count)]
    return {'version': 1, 'duration': duration,
            'sections': [{'id': 's0', 'name': 'Intro', 'start': 0, 'end': 16, 'lyrics': ''},
                         {'id': 's1', 'name': 'Verse', 'start': 16, 'end': 32, 'lyrics': 'Out on the highway\nRunning the night'},
                         {'id': 's2', 'name': 'Chorus', 'start': 32, 'end': duration, 'lyrics': 'Is it the real thing'}],
            'chords': chords,
            'layout': {'bars_per_line': 4, 'breaks': ['m12'], 'bar_overrides': [],
                       'lines': [{'section_id': 's1', 'line': 0, 'start_measure': 'm8', 'end_measure': 'm9',
                                  'words': [{'offset': 0, 'measure_id': 'm8', 'beat': 0}, {'offset': 4, 'measure_id': 'm8', 'beat': 2}, {'offset': 11, 'measure_id': 'm9', 'beat': 1}]},
                                 {'section_id': 's1', 'line': 1, 'start_measure': 'm10', 'end_measure': 'm11', 'words': [{'offset': 0, 'measure_id': 'm10', 'beat': 0}]},
                                 {'section_id': 's2', 'line': 0, 'start_measure': 'm16', 'end_measure': 'm17', 'words': [{'offset': 0, 'measure_id': 'm16', 'beat': 0}]}],
                       'compact': {'version': 1, 'groups': [{'id': 's2@32', 'section_id': 's2', 'mode': 'expanded',
                                                             'passes': [{'start': 32, 'end': 40, 'measure_ids': ['m16', 'm17', 'm18', 'm19'], 'chord_ids': ['c16', 'c17', 'c18', 'c19']}]}]}}}


def other(count=24, first=.15, duration=None):
    """The other version as its own analysis left it: its own chords (other names, other ids), one long section, no lyrics, a grid 0.15 s later."""
    duration = duration or count * BAR + first
    chords = [{'id': f'x{i}', 'label': ['G', 'Am7', 'F', 'G'][i % 4], 'start': first + i * BAR, 'end': min(duration, first + (i + 1) * BAR), 'section_id': 'a', 'line': None, 'offset': None}
              for i in range(count)]
    return {'version': 1, 'duration': duration, 'sections': [{'id': 'a', 'name': 'Interlude', 'start': 0, 'end': duration, 'lyrics': ''}], 'chords': chords,
            'cues': [{'id': 'q1', 'text': 'pick scratch', 'start': 3.0}]}


def paired(theirs, mine, shift=0):
    """The bars as bar-match.js pairs them: bar i of the first song with bar i+shift of the other."""
    by = {m['id']: m for m in mine}
    out = {}
    for i, m in enumerate(theirs):
        partner = by.get(f'm{i + shift}')
        if partner:
            out[m['id']] = {'id': partner['id'], 'beats': len(partner['beats']), 'from': [m['start'], m['end']], 'to': [partner['start'], partner['end']]}
    return out


def test_sections_and_lyrics_land_on_the_same_bars_and_pass_the_apps_rules():
    theirs, mine, grid = original(), other(), measures(first=.15)
    content, notes = structure.build(theirs, mine, paired(measures(), grid), {'measures': grid})
    checked = validate_chart(content, mine['duration'], {'measures': grid})                  # the app's own verdict
    assert notes == []
    assert [(s['name'], s['start'], s['end']) for s in checked['sections']] == [('Intro', 0.0, 16.15), ('Verse', 16.15, 32.15), ('Chorus', 32.15, mine['duration'])]
    assert [s['lyrics'] for s in checked['sections']] == [s['lyrics'] for s in theirs['sections']]
    assert [c['label'] for c in checked['chords']] == [c['label'] for c in mine['chords']], 'this song keeps its own chords'
    assert [c['section_id'] for c in checked['chords']] == ['s0'] * 8 + ['s1'] * 8 + ['s2'] * 8, 'each filed under the section it now starts in'
    assert checked['layout']['lines'] == theirs['layout']['lines'], 'every word on the same bar and beat (the bars have the same names here)'
    assert checked['layout']['breaks'] == ['m12'] and checked['cues'] == mine['cues'], 'and its own cues stay'
    group = checked['layout']['compact']['groups'][0]
    assert group['id'] == 's2@32.15' and group['passes'][0]['start'] == 32.15 and group['passes'][0]['end'] == 40.15
    assert group['passes'][0]['chord_ids'] == ['x16', 'x17', 'x18', 'x19'], 'the fold names THIS song’s chords'
    assert theirs == original() and mine == other(), 'neither chart is changed by building'


def test_bars_that_are_named_differently_are_followed():
    theirs, grid = original(), measures(26, first=.15)                          # the other analysis has two more bars in front
    mine = other(26)
    for chord in mine['chords']:
        chord['start'] += 0
    bars = paired(measures(), grid, shift=2)
    content, _ = structure.build(theirs, mine, bars, {'measures': grid})
    checked = validate_chart(content, mine['duration'], {'measures': grid})
    assert [round(s['start'], 2) for s in checked['sections']] == [0.0, 20.15, 36.15], 'the Verse begins on the partner of bar 9, two bars later here'
    assert checked['layout']['lines'][0]['start_measure'] == 'm10' and [w['measure_id'] for w in checked['layout']['lines'][0]['words']] == ['m10', 'm10', 'm11']
    assert checked['layout']['compact']['groups'][0]['passes'][0]['measure_ids'] == ['m18', 'm19', 'm20', 'm21']


def test_what_does_not_fit_is_left_and_said():
    theirs, grid = original(), measures(first=.15)
    for m in grid[8:10]:
        m['beats'] = m['beats'][:3]                                           # two of this song's bars are in 3: a word on beat 4... there is none here, on beat 3
    theirs['layout']['lines'][0]['words'][1]['beat'] = 3
    bars = paired(measures(), grid)
    content, notes = structure.build(theirs, other(), bars, {'measures': grid})
    assert len(content['layout']['lines']) == 2 and 'The lyric line “Out on the highway” could not be placed' in notes[0] and 'place it on the Chart tab' in notes[0]
    assert content['sections'][1]['lyrics'] == 'Out on the highway\nRunning the night', 'the words themselves always come'
    text, notes = structure.build(theirs, other(), bars, {'measures': grid}, level='text')
    assert text['layout']['lines'] == [] and 'compact' not in text['layout'] and any('words only' in n for n in notes)


def test_songs_that_are_not_alike_enough_are_refused_with_the_place_named():
    theirs = original()
    short = measures(12, first=.15)                                           # this version stops half way: the Chorus has no bars at all
    with pytest.raises(structure.NotClose, match='“Verse”.*bar this song does not have'):          # the first section that runs past its last bar is named
        structure.build(theirs, other(12), paired(measures(), short), {'measures': short})
    with pytest.raises(structure.NotClose, match='could not be matched'):
        structure.build(theirs, other(), {}, {'measures': measures()})
    gap = paired(measures(), measures(first=.15))
    for bar in ('m7', 'm8'):
        del gap[bar]                                                          # the bars around the Verse's first barline have no partner
    with pytest.raises(structure.NotClose, match='“Intro”|“Verse”'):
        structure.build(theirs, other(), gap, {'measures': measures(first=.15)})


def test_a_moment_keeps_its_place():
    pairs = structure._pairs(paired(measures(), measures(first=.15)))
    at = lambda t: structure.map_time(pairs, t, 48, 48.15)
    assert at(0) == 0.0 and at(48) == 48.15 and at(16) == 16.15 and at(16.03) == 16.15, 'the ends stay the ends, and a barline goes to a barline'
    assert abs(at(17) - 17.15) < 1e-9, 'inside a bar: the same way through it'
    assert structure.map_time(pairs[:4], 30, 48, 48.15) is None, 'a moment in a bar with no partner has no place'


# ---------------------------------------------------------------- through the app's own store
@pytest.fixture
def pair(tmp_path, mp3_bytes):
    """Two analyzed songs with real charts in a library: A set up by hand (sections, lyrics placed on bars), B as its analysis left it."""
    lib = Library(tmp_path)
    docs = DocumentStore(lib)
    ids = []
    for title, first in (('Real Thing', 0.0), ('Real Thing (lower)', .05)):
        song = lib.import_audio(title + '.mp3', mp3_bytes + (b'\x00' if first else b''))
        run = lib.create_run(song['id'])
        beats = [f'{first + b * .05 + k * .0125:.4f} {k + 1} 4 4' for b in range(8) for k in range(4)]            # 8 short bars inside the half-second test recording
        (run / 'beat.lab').write_text('\n'.join(beats) + '\n')
        (run / 'downbeat.lab').write_text('\n'.join(f'{first + b * .05:.4f}' for b in range(8)) + '\n')
        (run / 'events.json').write_text(json.dumps({'events': [{'time': first + i * .05, 'values': {'chord': c}} for i, c in enumerate(['G:maj', 'C:maj', 'D:maj', 'E:min', 'G:maj', 'C:maj', 'D:maj', 'G:maj'])]}))
        (run / 'score.abc').write_text('X:1\nT:x\nM:4/4\nL:1/4\nK:G\n"G"G4|\n')
        docs.ingest(song['id'], run, 'completed', None)
        ids.append(song['id'])
    a, b = ids
    chart = docs.get(next(d for d in docs.for_song(a) if d['kind'] == 'chart')['id'])
    content, bars = copy.deepcopy(chart['content']), chart['music']['measures']
    cut, end = bars[4]['start'], content['duration']
    content['sections'] = [{'id': 'v', 'name': 'Verse', 'start': 0, 'end': cut, 'lyrics': 'First line here'}, {'id': 'c', 'name': 'Chorus', 'start': cut, 'end': end, 'lyrics': 'Sing it'}]
    for chord in content['chords']:
        chord['section_id'] = 'v' if chord['start'] < cut else 'c'
    content['layout'] = {'bars_per_line': 4, 'breaks': [], 'bar_overrides': [],
                         'lines': [{'section_id': 'v', 'line': 0, 'start_measure': bars[1]['id'], 'end_measure': bars[2]['id'],
                                    'words': [{'offset': 0, 'measure_id': bars[1]['id'], 'beat': 0}, {'offset': 6, 'measure_id': bars[2]['id'], 'beat': 2}]}]}
    docs.save(chart['id'], content, 'Set up by hand', chart['revision'])
    yield lib, docs, a, b
    lib.close()


def chart_of(docs, song):
    return docs.get(next(d for d in docs.for_song(song) if d['kind'] == 'chart')['id'])


def real_bars(docs, a, b):
    theirs, mine = chart_of(docs, a)['music']['measures'], {m['id']: m for m in chart_of(docs, b)['music']['measures']}
    return {m['id']: {'id': m['id'], 'beats': len(mine[m['id']]['beats']), 'from': [m['start'], m['end']], 'to': [mine[m['id']]['start'], mine[m['id']]['end']]} for m in theirs if m['id'] in mine}


def test_the_plan_says_what_would_come_and_saves_nothing(pair):
    lib, docs, a, b = pair
    before = chart_of(docs, b)
    planned = structure.plan(docs, a, b, real_bars(docs, a, b))
    assert planned['ok'] and planned['level'] == 'full' and planned['sections'] == ['Verse', 'Chorus']
    assert planned['lyric_lines'] == 2 and planned['placed_lines'] == 1 and planned['words'] == 2 and planned['replaces'] == 0
    assert structure.words(planned) == '2 sections (Verse, Chorus) and 2 lyric lines (1 placed on the beats)'
    json.dumps(structure.public(planned))
    assert 'content' not in structure.public(planned)
    after = chart_of(docs, b)
    assert after['content'] == before['content'] and after['revision'] == before['revision']


def test_copying_is_one_undoable_step_in_the_other_songs_chart(pair):
    lib, docs, a, b = pair
    before, source = chart_of(docs, b), chart_of(docs, a)
    done = structure.apply(docs, a, b, real_bars(docs, a, b), like='Real Thing')
    after = chart_of(docs, b)
    assert done['saved'] and after['revision'] == before['revision'] + 1 and after['undo_label'] == 'Copy song structure and lyrics from “Real Thing”'
    assert [(s['name'], s['lyrics']) for s in after['content']['sections']] == [('Verse', 'First line here'), ('Chorus', 'Sing it')]
    cut = chart_of(docs, b)['music']['measures'][4]['start']
    assert after['content']['sections'][0]['end'] == cut == after['content']['sections'][1]['start'], 'the Chorus begins on THIS song’s bar 5'
    assert [c['label'] for c in after['content']['chords']] == [c['label'] for c in before['content']['chords']]
    assert len(after['content']['layout']['lines']) == 1 and len(after['content']['layout']['lines'][0]['words']) == 2
    assert chart_of(docs, a)['content'] == source['content'], 'the song copied from is untouched'
    undone = docs.history(after['id'], 'undo', after['revision'])
    assert undone['content'] == before['content'], 'Undo in the app puts this song’s own sections back'
    again = structure.plan(docs, a, b, real_bars(docs, a, b))
    assert again['ok']
    structure.apply(docs, a, b, real_bars(docs, a, b))
    assert 'already has the same song structure and lyrics' in structure.plan(docs, a, b, real_bars(docs, a, b))['reason']


def test_it_is_not_offered_when_it_does_not_fit(pair):
    lib, docs, a, b = pair
    bars = real_bars(docs, a, b)
    few = {k: v for k, v in list(bars.items())[:3]}                          # only the first three bars have partners
    planned = structure.plan(docs, a, b, few)
    assert not planned['ok'] and 'Not close enough' in planned['reason'] and '“' in planned['reason']
    with pytest.raises(structure.NotClose):
        structure.apply(docs, a, b, few)
    assert not structure.plan(docs, a, b, {})['ok']


def test_this_songs_own_lyrics_are_counted_as_what_would_be_replaced(pair):
    lib, docs, a, b = pair
    chart = chart_of(docs, b)
    content = copy.deepcopy(chart['content'])
    content['sections'][0]['lyrics'] = 'my own words\nand more'
    docs.save(chart['id'], content, 'Typed lyrics', chart['revision'])
    assert structure.plan(docs, a, b, real_bars(docs, a, b))['replaces'] == 2


def test_the_windows_buttons_offer_then_copy_and_say_how_to_take_it_back(pair):
    from stem_tool.controller import Controller
    from stem_tool.engine import Workspace
    lib, docs, a, b = pair
    space = Workspace(lib.root, lib.root)
    try:
        c = Controller(space)
        assert c.structure_plan(a, {}) == {'error': 'Choose the song to copy onto first.'}
        c.song_id = b
        bars = real_bars(docs, a, b)
        offer = c.structure_plan(a, bars)['plan']
        assert offer['ok'] and offer['summary'] == '2 sections (Verse, Chorus) and 2 lyric lines (1 placed on the beats)' and offer['words'] == 2 and 'content' not in offer
        json.dumps(offer)
        refused = c.structure_plan(a, {})['plan']
        assert not refused['ok'] and 'Not close enough' in refused['reason'] and 'summary' not in refused
        state = c.copy_structure(a, bars, 'Real Thing')
        assert 'now has 2 sections (Verse, Chorus) and 2 lyric lines' in state['messages'][-1] and 'Undo on its Chart tab' in state['messages'][-1]
        fresh = DocumentStore(Library(lib.root))                  # as Chord Buddy would read it on its next start
        assert [s['name'] for s in chart_of(fresh, b)['content']['sections']] == ['Verse', 'Chorus']
        assert 'Not close enough' in c.copy_structure(a, {}, 'Real Thing')['messages'][-1], 'a copy that does not fit is refused, in words'
    finally:
        space.close()


# ---------------------------------------------------------------- slivers: sections shorter than a beat, which the chart does not draw
def with_numbers(bars, theirs):
    for i, m in enumerate(theirs):
        if m['id'] in bars:
            bars[m['id']]['number'] = i + 1
    return bars


def test_a_sliver_before_the_intro_is_folded_in_and_the_copy_goes_ahead():
    theirs = original()
    theirs['sections'][0] = dict(theirs['sections'][0], start=.01)                     # an analysis left 0.01 s named "Instrumental" before the Intro
    theirs['sections'].insert(0, {'id': 'gap', 'name': 'Instrumental', 'start': 0, 'end': .01, 'lyrics': ''})
    grid = measures(first=-.1)[0:]
    grid[0] = dict(grid[0], start=0.0)                                                # this recording starts sooner: its first bar is short
    bars = with_numbers(paired(measures(), grid), measures())
    mine = other(first=0.0)
    content, notes = structure.build(theirs, mine, bars, {'measures': grid})
    assert [s['name'] for s in content['sections']] == ['Intro', 'Verse', 'Chorus'] and content['sections'][0]['start'] == 0.0
    assert notes == [], 'nothing to say: it held no words'
    validate_chart(content, mine['duration'], {'measures': grid})


def test_a_sliver_in_the_middle_joins_the_section_before_it_with_its_words():
    theirs = original()
    theirs['sections'][1] = dict(theirs['sections'][1], start=16.2)                    # 0.2 s of "Break" (less than a beat) between Intro and Verse
    theirs['sections'].insert(1, {'id': 'brk', 'name': 'Break', 'start': 16, 'end': 16.2, 'lyrics': 'hey'})
    content, notes = structure.build(theirs, other(), paired(measures(), measures(first=.15)), {'measures': measures(first=.15)})
    assert [s['name'] for s in content['sections']] == ['Intro', 'Verse', 'Chorus']
    assert content['sections'][0]['lyrics'] == 'hey' and 'joined' in notes[0]


def test_a_section_left_with_no_bars_joins_its_neighbour_instead_of_stopping_the_copy():
    theirs = original()
    theirs['sections'][1] = dict(theirs['sections'][1], start=17.0)                    # a 1 s "Fill" (two beats): longer than a beat, but inside one bar
    theirs['sections'].insert(1, {'id': 'fill', 'name': 'Fill', 'start': 16, 'end': 17.0, 'lyrics': ''})
    theirs['sections'][0]['end'] = 16
    content, _ = structure.build(theirs, other(), paired(measures(), measures(first=.15)), {'measures': measures(first=.15)})
    assert [s['name'] for s in content['sections']] == ['Intro', 'Fill', 'Verse', 'Chorus'], 'it has a part of a bar: it is kept'


def test_a_refusal_names_the_section_as_the_chart_shows_it():
    theirs = original()
    short = measures(12, first=.15)
    bars = with_numbers(paired(measures(), short), measures())
    with pytest.raises(structure.NotClose, match='the section “Verse” \\(at bar 9\\)'):
        structure.build(theirs, other(12), bars, {'measures': short})


# ---------------------------------------------------------------- a break the two analyses split the other way round
def test_a_lyric_line_on_bars_split_the_other_way_goes_by_its_moments_and_passes_the_apps_rules():
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location('_flags_tests', pathlib.Path(__file__).with_name('test_stem_flags.py'))
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    swapped_songs = helpers.swapped_songs
    bars, timing, theirs_grid, mine_grid = swapped_songs()
    duration = mine_grid[-1]['end']
    source_duration = theirs_grid[-1]['end']
    chords = lambda grid, prefix: [{'id': f'{prefix}{i}', 'label': 'B', 'start': b['start'], 'end': b['end'], 'section_id': 's', 'line': None, 'offset': None} for i, b in enumerate(grid)]
    theirs = {'version': 1, 'duration': source_duration,
              'sections': [{'id': 's0', 'name': 'Verse', 'start': 0, 'end': 16.0, 'lyrics': ''},
                           {'id': 's1', 'name': 'Bridge', 'start': 16.0, 'end': 19.0, 'lyrics': 'So if you need me won’t you'},
                           {'id': 's2', 'name': 'Chorus', 'start': 19.0, 'end': source_duration, 'lyrics': 'Call me'}],
              'chords': chords(theirs_grid, 'c'),
              'layout': {'bars_per_line': 4, 'breaks': [], 'bar_overrides': [],
                         'lines': [{'section_id': 's1', 'line': 0, 'start_measure': 'p8', 'end_measure': 'p9',
                                    'words': [{'offset': 0, 'measure_id': 'p8', 'beat': 0}, {'offset': 3, 'measure_id': 'p9', 'beat': 0},
                                              {'offset': 21, 'measure_id': 'p9', 'beat': 3}]},
                                   {'section_id': 's2', 'line': 0, 'start_measure': 'p10', 'end_measure': 'p10', 'words': [{'offset': 0, 'measure_id': 'p10', 'beat': 0}]}]}}
    for c in theirs['chords']:
        c['section_id'] = 's0' if c['start'] < 16 else 's1' if c['start'] < 19 else 's2'
    mine = {'version': 1, 'duration': duration, 'sections': [{'id': 'a', 'name': 'Song', 'start': 0, 'end': duration, 'lyrics': ''}],
            'chords': chords(mine_grid, 'x')}
    for c in mine['chords']:
        c['section_id'] = 'a'
    music = {'measures': mine_grid}

    content, notes = structure.build(theirs, mine, bars, music, 'full', timing)
    checked = validate_chart(content, duration, music)                                       # the app's own verdict
    assert notes == []
    assert [(s['name'], round(s['start'], 2)) for s in checked['sections']] == [('Verse', 0.0), ('Bridge', 16.15), ('Chorus', 19.15)], \
        'the Chorus starts at the end of the break in both: on bar 10 here too, not where bar 9 starts'
    line = checked['layout']['lines'][0]
    assert [(w['measure_id'], w['beat']) for w in line['words']] == [('q8', 0), ('q8', 2.0), ('q9', 1.0)], 'each word at the same moment of the music'
    assert (line['start_measure'], line['end_measure']) == ('q8', 'q9')
    assert checked['layout']['lines'][1]['words'] == [{'offset': 0, 'measure_id': 'q10', 'beat': 0}]

    # without the beat times (an older window), the line cannot be placed, and the note names it and says what that means
    content, notes = structure.build(theirs, mine, bars, music, 'full')
    assert len(content['layout']['lines']) == 1
    assert notes and '“So if you need me won’t you” (bar 8)' in notes[0] and 'Chart tab' in notes[0]


# ---------------------------------------------------------------- song structure and lyrics, each on its own
def with_own_lyrics():
    """The other version with two lyric lines of its own, placed on bars 3 and 13 (in its one section)."""
    mine = other()
    mine['sections'][0]['lyrics'] = 'Mine one\nMine two'
    mine['chords'][2].update(line=0, offset=0)                                  # a chord typed in place on "Mine one"
    mine['layout'] = {'bars_per_line': 4, 'breaks': [], 'bar_overrides': [],
                      'lines': [{'section_id': 'a', 'line': 0, 'start_measure': 'm2', 'end_measure': 'm2', 'words': [{'offset': 0, 'measure_id': 'm2', 'beat': 0}]},
                                {'section_id': 'a', 'line': 1, 'start_measure': 'm12', 'end_measure': 'm12', 'words': [{'offset': 0, 'measure_id': 'm12', 'beat': 0}]}]}
    return mine


def test_song_structure_alone_keeps_this_songs_own_lyrics_in_the_sections_they_are_sung_in():
    theirs, grid, mine = original(), measures(first=.15), with_own_lyrics()
    content, notes = structure.build(theirs, mine, paired(measures(), grid), {'measures': grid}, parts=('structure',))
    checked = validate_chart(content, mine['duration'], {'measures': grid})
    assert [s['name'] for s in checked['sections']] == ['Intro', 'Verse', 'Chorus']
    assert [s['lyrics'] for s in checked['sections']] == ['Mine one', 'Mine two', ''], 'its own words stay, none of the other song’s'
    assert [(l['section_id'], l['line'], l['words'][0]['measure_id']) for l in checked['layout']['lines']] == [('s0', 0, 'm2'), ('s1', 0, 'm12')]
    assert (checked['chords'][2]['line'], checked['chords'][2]['offset']) == (0, 0), 'a chord typed in place stays in its words'
    assert checked['layout']['compact']['groups'], 'the folded repeats come with the structure'
    assert notes == []


def test_lyrics_alone_go_into_this_songs_own_sections():
    theirs, grid, mine = original(), measures(first=.15), with_own_lyrics()
    content, notes = structure.build(theirs, mine, paired(measures(), grid), {'measures': grid}, parts=('lyrics',))
    checked = validate_chart(content, mine['duration'], {'measures': grid})
    assert [(s['name'], s['start']) for s in checked['sections']] == [('Interlude', 0)], 'its own sections stay'
    assert checked['sections'][0]['lyrics'] == 'Out on the highway\nRunning the night\nIs it the real thing', 'the other song’s words, in the order they are sung'
    assert [(l['line'], l['start_measure'], [w['measure_id'] for w in l['words']]) for l in checked['layout']['lines']] == \
        [(0, 'm8', ['m8', 'm8', 'm9']), (1, 'm10', ['m10']), (2, 'm16', ['m16'])]
    assert all(c['line'] is None for c in checked['chords']), 'its own words are gone, so no chord is typed in them'
    assert 'compact' not in checked['layout'] or not checked['layout']['compact'].get('groups'), 'and its own folds, not the other song’s'
    assert notes == []


def test_nothing_ticked_copies_nothing_and_each_part_has_its_own_words():
    assert structure.PART_WORDS[('lyrics',)] == 'lyrics' and structure.PART_WORDS[structure.PARTS] == 'song structure and lyrics'
    with pytest.raises(structure.NotClose):
        structure.build(original(), other(), paired(measures(), measures(first=.15)), {'measures': measures(first=.15)}, parts=())
