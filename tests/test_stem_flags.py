"""Copying an arrangement's action flags from one song to another (stem_tool/flags.py)."""
import copy
import json

import pytest

from chordbuddy.library import Library
from chordbuddy.performance_store import PerformanceStore
from stem_tool import flags

A, B = 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'
at = lambda measure, n=0, d=1: {'measure': measure, 'beat': {'n': n, 'd': d}}


def arrangement():
    """An arrangement of song A that uses everything an arrangement can hold."""
    return {'schema': 1, 'id': 'p1', 'songId': A, 'name': 'Live', 'grid': 'feedbeef', 'countBars': 2,
            'initial': [{'type': 'track.set', 'track': 'lead', 'mute': True}],
            'cues': [{'id': 'c1', 'at': at('m4'), 'action': {'type': 'visual.scene', 'scene': 'starlane'}},
                     {'id': 'c2', 'at': at('m6', 5, 2), 'action': {'type': 'midi', 'device': 'Helix', 'program': 3}, 'leadMs': 20, 'when': {'first': True}},
                     {'id': 'c3', 'at': at('m40'), 'action': {'type': 'command', 'command': 'stop'}},          # a bar the other song does not have
                     {'id': 'c4', 'at': at('m7', 3), 'action': {'type': 'marker.text', 'text': 'solo'}}],        # beat 4 of a bar that has only 3 beats over there
            'regions': [{'id': 'r1', 'start': at('m8'), 'end': at('m12'), 'plays': 2, 'family': 'bars',
                         'passes': [{'id': 'x1', 'entry': [], 'program': None},
                                    {'id': 'x2', 'entry': [], 'program': {'cues': [{'id': 'c5', 'at': at('m9'), 'action': {'type': 'track.set', 'track': 'vocals', 'mute': True}},
                                                                                   {'id': 'c6', 'at': at('m41'), 'action': {'type': 'command', 'command': 'stop'}}]}}],
                         'further': None, 'onExit': []},
                        {'id': 'r2', 'start': at('m38'), 'end': at('m42'), 'plays': 'live', 'family': 'section', 'passes': [], 'further': None, 'onExit': []}],
            'jumps': [{'id': 'j1', 'at': at('m14'), 'to': at('m4'), 'times': 1}, {'id': 'j2', 'at': at('m14'), 'to': at('m50'), 'times': 1}],
            'holds': [{'id': 'h1', 'at': at('m16'), 'seconds': 4, 'expected': 4}]}


def bars_for(offset=-2, last=30, short=('m7',)):
    """Song B is the same music with two fewer bars before it starts: A's m4 is B's m2, and so on. It ends sooner, and one bar is in 3."""
    return {f'm{i}': {'id': f'm{i + offset}', 'beats': 3 if f'm{i}' in short else 4} for i in range(-offset, last)}


def test_every_place_moves_to_the_same_bar_and_beat_of_the_other_song():
    source = arrangement()
    moved, left = flags.remap(source['cues'], bars_for())
    assert [(c['id'], c['at']) for c in moved] == [('c1', at('m2')), ('c2', at('m4', 5, 2))], 'bar and beat kept; the action untouched'
    assert moved[1]['action'] == source['cues'][1]['action'] and moved[1]['leadMs'] == 20 and moved[1]['when'] == {'first': True}
    assert left == 2, 'a flag past the other song’s last bar, and one on a beat its bar does not have, are left out and counted'
    assert source == arrangement(), 'the original is not changed by copying'


def test_a_loop_moves_whole_with_its_passes_or_not_at_all():
    regions, left = flags.remap(arrangement()['regions'], bars_for())
    assert [r['id'] for r in regions] == ['r1'] and regions[0]['start'] == at('m6') and regions[0]['end'] == at('m10') and regions[0]['plays'] == 2
    assert [c['id'] for c in regions[0]['passes'][1]['program']['cues']] == ['c5'] and regions[0]['passes'][1]['program']['cues'][0]['at'] == at('m7')
    assert regions[0]['passes'][0] == {'id': 'x1', 'entry': [], 'program': None}
    assert left == 2, 'the loop over bars that are not there, and one pass’s flag past the end'


def test_a_loop_may_end_on_its_last_bars_final_line():
    region = {'id': 'r', 'start': at('m5'), 'end': at('m6', 4), 'plays': 2, 'passes': []}
    moved, left = flags.remap([region], bars_for())
    assert left == 0 and moved[0]['end'] == at('m4', 4)
    moved, left = flags.remap([dict(region, end=at('m7', 4))], bars_for())
    assert moved == [] and left == 1, 'but not past the end of a shorter bar'


def test_jumps_and_holds_move_too():
    jumps, left = flags.remap(arrangement()['jumps'], bars_for())
    assert [(j['id'], j['at'], j['to']) for j in jumps] == [('j1', at('m12'), at('m2'))] and left == 1
    holds, left = flags.remap(arrangement()['holds'], bars_for())
    assert holds == [{'id': 'h1', 'at': at('m14'), 'seconds': 4, 'expected': 4}] and left == 0


def test_counting_what_there_is():
    assert flags.count(arrangement()) == {'flags': 6, 'loops': 2, 'jumps': 2, 'holds': 1}


@pytest.fixture
def two_songs(tmp_path):
    lib = Library(tmp_path)
    with lib.transaction() as tx:
        for ident, title in ((A, 'Real Thing'), (B, 'Real Thing (lower)')):
            tx.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (ident, title, '', 'source.mp3', 100, ident, 'imported', None, None, 'then'))
    store = PerformanceStore(lib)
    saved = store.save_performance(arrangement(), 0)
    yield lib, store, saved
    lib.close()


def test_the_plan_says_what_would_be_copied_and_saves_nothing(two_songs):
    lib, store, saved = two_songs
    planned = flags.public(flags.plan(store, 'p1', B, bars_for()))
    assert planned['from'] == 'Live' and planned['name'] == 'Live'
    assert planned['have'] == {'flags': 6, 'loops': 2, 'jumps': 2, 'holds': 1} and planned['copied'] == {'flags': 3, 'loops': 1, 'jumps': 1, 'holds': 1}
    assert planned['left_out'] == 5 and 'body' not in planned
    json.dumps(planned)
    assert store.performances_for_song(B) == [] and store.performance('p1')['body'] == arrangement()


def test_copying_makes_a_new_arrangement_on_the_other_song_and_touches_nothing_else(two_songs):
    lib, store, saved = two_songs
    done = flags.apply(store, 'p1', B, bars_for(), grid='0badf00d')
    listed = store.performances_for_song(B)
    assert [p['name'] for p in listed] == ['Live'] and listed[0]['id'] == done['id'] != 'p1'
    body = store.performance(done['id'])['body']
    assert body['songId'] == B and body['schema'] == 1 and body['grid'] == '0badf00d' and body['countBars'] == 2
    assert body['initial'] == arrangement()['initial'], 'what is in force when the song starts comes too'
    assert [c['at']['measure'] for c in body['cues']] == ['m2', 'm4'] and [r['id'] for r in body['regions']] == ['r1']
    assert store.performance('p1')['body'] == arrangement() and store.performance('p1')['head'] == saved['head'], 'the original is exactly as it was'
    again = flags.apply(store, 'p1', B, bars_for())
    assert again['name'] == 'Live (2)' and [p['name'] for p in store.performances_for_song(B)] == ['Live', 'Live (2)'], 'a second copy never takes the first one’s name'
    named = flags.apply(store, 'p1', B, bars_for(), name='Saturday')
    assert named['name'] == 'Saturday' and len(store.performances_for_song(B)) == 3


def test_unsaved_work_on_the_arrangement_is_what_gets_copied(two_songs):
    lib, store, saved = two_songs
    draft = arrangement()
    draft['cues'].append({'id': 'c9', 'at': at('m5'), 'action': {'type': 'command', 'command': 'stop'}})
    store.save_performance_draft(draft, saved['head'])
    done = flags.apply(store, 'p1', B, bars_for())
    assert 'c9' in [c['id'] for c in store.performance(done['id'])['body']['cues']], 'as a show would play it now'


def test_what_cannot_work_is_refused_in_plain_words(two_songs):
    lib, store, saved = two_songs
    with pytest.raises(ValueError, match='already belongs to this song'):
        flags.plan(store, 'p1', A, bars_for())
    with pytest.raises(ValueError, match='could not be matched'):
        flags.plan(store, 'p1', B, {})
    with pytest.raises(KeyError):
        flags.plan(store, 'nosuch', B, bars_for())
    with pytest.raises(KeyError):
        flags.apply(store, 'p1', 'cccccccccccc', bars_for())
    assert store.performances_for_song(B) == []


def test_the_windows_buttons_list_preview_and_copy(two_songs):
    from stem_tool.controller import Controller
    from stem_tool.engine import Workspace
    lib, store, saved = two_songs
    space = Workspace(lib.root, lib.root)
    try:
        c = Controller(space)
        assert c.flags_plan('p1', bars_for()) == {'error': 'Choose the song to copy onto first.'}
        c.song_id = B                                             # the lowered version is the song chosen in the window
        assert c.flag_sources() == [{'id': A, 'title': 'Real Thing', 'artist': '', 'has_chart': False, 'arrangements': [{'id': 'p1', 'name': 'Live'}]}], 'only other songs that have something to copy'
        assert c.chart_of(A) is None, 'these made-up songs have no chart'
        planned = c.flags_plan('p1', bars_for())['plan']
        assert planned['copied'] == {'flags': 3, 'loops': 1, 'jumps': 1, 'holds': 1} and planned['left_out'] == 5
        assert 'could not be matched' in c.flags_plan('p1', {})['error'] and 'not found' in c.flags_plan('nosuch', bars_for())['error']
        c.messages.clear()
        state = c.copy_flags('p1', bars_for(), '0badf00d')
        assert 'has a new arrangement, “Live”, with 3 action flags, 1 loop, 1 jump, 1 hold at the same moments of the music' in state['messages'][-1]
        assert '5 could not be copied' in state['messages'][-1]
        fresh = PerformanceStore(Library(lib.root))               # as Chord Buddy would read it on its next start
        listed = fresh.performances_for_song(B)
        assert [p['name'] for p in listed] == ['Live'] and fresh.performance(listed[0]['id'])['body']['grid'] == '0badf00d'
        c.song_id = A
        assert c.flag_sources() == [{'id': B, 'title': 'Real Thing (lower)', 'artist': '', 'has_chart': False, 'arrangements': [{'id': listed[0]['id'], 'name': 'Live'}]}]
    finally:
        space.close()


# ---------------------------------------------------------------- lining two recordings up by ear
def _mix(seed, hz, lead=0.0, seconds=40):
    """A made-up recording: phrases of sound with rests (its loudness over time is what is compared), `lead` seconds of extra silence in front."""
    import numpy as np
    from stem_tool.engine import RATE
    rng = np.random.default_rng(seed)
    env = np.zeros(seconds * RATE, dtype=np.float32)
    t = int(.6 * RATE)
    while t < len(env) - RATE:
        length = int(rng.uniform(.3, 1.2) * RATE)
        env[t:t + length] = rng.uniform(.4, 1.0) * np.hanning(length)
        t += length + int(rng.uniform(.1, .8) * RATE)
    mono = (env * np.sin(2 * np.pi * hz * np.arange(len(env)) / RATE) * .3).astype(np.float32)
    mono = np.concatenate([np.zeros(int(lead * RATE), dtype=np.float32), mono])
    return np.stack([mono, mono], axis=1)


def test_two_versions_of_one_recording_are_found_to_start_together():
    found = flags.recordings_offset(_mix(3, 220), _mix(3, 175))          # the lowered version: another pitch, the same shape
    assert found == {'offset': 0.0, 'confidence': found['confidence'], 'used': True, 'words': ''} and found['confidence'] > .6


@pytest.mark.parametrize('lead', [1.25, 3.2])
def test_extra_silence_in_front_of_one_is_measured_and_said(lead):
    later = flags.recordings_offset(_mix(3, 220), _mix(3, 175, lead=lead))    # the song being copied onto starts later
    assert abs(later['offset'] - lead) < .005 and later['used'] and f'starts {lead:.2f} s later' in later['words']
    sooner = flags.recordings_offset(_mix(3, 220, lead=lead), _mix(3, 175))
    assert abs(sooner['offset'] + lead) < .005 and 'sooner' in sooner['words']


def test_recordings_that_do_not_match_are_not_guessed_at():
    found = flags.recordings_offset(_mix(3, 220), _mix(99, 175))
    assert found['offset'] == 0.0 and not found['used'] and 'taken to start at the same moment' in found['words']


def test_the_window_lines_the_two_songs_up_once_and_copes_when_it_cannot(two_songs):
    from stem_tool.controller import Controller
    from stem_tool.engine import Workspace
    lib, store, saved = two_songs
    space = Workspace(lib.root, lib.root)
    try:
        c = Controller(space)
        assert c.flag_alignment(A) == {'offset': 0.0, 'confidence': 0, 'used': False, 'words': ''}, 'no song chosen yet'
        c.song_id = B
        found = c.flag_alignment(A)                               # these made-up songs have no recording on disk
        assert found['offset'] == 0.0 and not found['used'] and 'could not be compared' in found['words']
        assert c.flag_alignment(A) is found, 'worked out once per pair of songs'
        json.dumps(found)
    finally:
        space.close()


# ---------------------------------------------------------------- counting a song's bars like its other version
@pytest.fixture
def charted(tmp_path, mp3_bytes):
    """A song with a chart whose analysis heard two chords (A, A) before the music proper starts on B, as a fade-in can cause."""
    from chordbuddy.documents import DocumentStore
    lib = Library(tmp_path)
    song = lib.import_audio('Instr.mp3', mp3_bytes)
    run = lib.create_run(song['id'])
    (run / 'score.abc').write_text('X:1\nT:Test\nM:4/4\nL:1/4\nK:E\n"A"A4|"A"A4|"B"B4|"C#m7"c4|\n')
    (run / 'events.json').write_text(json.dumps({'events': [{'time': 0, 'values': {'chord': 'N'}}, {'time': .05, 'values': {'chord': 'A:maj'}}, {'time': .1, 'values': {'chord': 'A:maj'}},
                                                            {'time': .2, 'values': {'chord': 'B:maj'}}, {'time': .3, 'values': {'chord': 'C#:min7'}}]}))
    docs = DocumentStore(lib)
    docs.ingest(song['id'], run, 'completed', None)
    yield lib, docs, song['id']
    lib.close()


def chart_of(docs, song):
    return docs.get(next(d for d in docs.for_song(song) if d['kind'] == 'chart')['id'])


def test_chords_heard_before_the_music_become_rests_in_one_undoable_step(charted):
    lib, docs, song = charted
    before = chart_of(docs, song)
    names = [c['label'] for c in before['content']['chords']]
    assert names.count('A') >= 1 and 'B' in names
    b_start = next(c['start'] for c in before['content']['chords'] if c['label'] == 'B')
    done = flags.count_bars_from(docs, song, b_start - .01, 'Real Thing')
    after = chart_of(docs, song)
    labels = [c['label'] for c in after['content']['chords']]
    assert done == {'changed': names.count('A'), 'chords': ['A']}
    assert 'A' not in labels and labels[labels.index('B'):] == names[names.index('B'):], 'everything from the B chord on is as it was'
    assert [(c['id'], c['start'], c['end']) for c in after['content']['chords']] == [(c['id'], c['start'], c['end']) for c in before['content']['chords']], 'no chord is removed or moved, only renamed to a rest'
    assert after['undo_label'] == 'Count bars like “Real Thing”' and after['revision'] == before['revision'] + 1
    undone = docs.history(after['id'], 'undo', after['revision'])
    assert undone['content'] == before['content'], 'Undo in the app brings the chords back'


def test_nothing_early_means_nothing_changes(charted):
    lib, docs, song = charted
    before = chart_of(docs, song)
    assert flags.count_bars_from(docs, song, 0.0) == {'changed': 0, 'chords': []}
    assert chart_of(docs, song)['revision'] == before['revision']
    with pytest.raises(KeyError):
        flags.count_bars_from(docs, 'nosuchsong00', 1.0)


def test_the_window_counts_the_bars_and_says_how_to_take_it_back(charted):
    from stem_tool.controller import Controller
    from stem_tool.engine import Workspace
    lib, docs, song = charted
    space = Workspace(lib.root, lib.root)
    try:
        c = Controller(space)
        assert 'Choose a song first' in c.count_bars_like(1.0)['messages'][-1]
        c.song_id = song
        b_start = next(x['start'] for x in chart_of(docs, song)['content']['chords'] if x['label'] == 'B')
        state = c.count_bars_like(b_start - .01, 'Real Thing')
        assert 'now counts its bars like “Real Thing”' in state['messages'][-1] and '(A) became rests' in state['messages'][-1] and 'Undo on its Chart tab' in state['messages'][-1]
        from chordbuddy.documents import DocumentStore
        assert 'A' not in [x['label'] for x in chart_of(DocumentStore(Library(lib.root)), song)['content']['chords']]
    finally:
        space.close()


# ---------------------------------------------------------------- two analyses that cut the same music into bars differently
def pickup_songs():
    """The same music, analysed twice. The first hears a 5-beat bar 0 (0.0-2.5 s) then bar 1; the second (0.1 s sooner in its recording) hears
    a 1-beat bar and a 2-beat bar before the same bar 1, and its last bar ends a bar sooner. Beats are half a second."""
    beats = lambda start, n: [start + k * .5 for k in range(n)]
    theirs = {'p0': {'number': 0, 'beats': beats(0.0, 5), 'end': 2.5}}
    for i in range(1, 9):
        theirs[f'p{i}'] = {'number': i, 'beats': beats(2.5 + (i - 1) * 2, 4), 'end': 2.5 + i * 2}
    mine = [{'id': 'q0', 'number': -1, 'start': 0.0, 'end': .4, 'beats': [0.0]},                # (this recording starts .1 s sooner)
            {'id': 'q1', 'number': 0, 'start': .4, 'end': 2.4, 'beats': [.4, 1.4]}]
    mine += [{'id': f'q{i + 1}', 'number': i, 'start': 2.4 + (i - 1) * 2, 'end': 2.4 + i * 2, 'beats': beats(2.4 + (i - 1) * 2, 4)} for i in range(1, 8)]
    bars = {'p0': {'id': 'q0', 'beats': 1}}                                     # paired by the nearest bar start, as bar-match.js does
    bars.update({f'p{i}': {'id': f'q{i + 1}', 'beats': 4} for i in range(1, 8)})
    return bars, {'theirs': theirs, 'mine': mine, 'shift': -.1}


def test_a_flag_on_a_beat_its_partner_bar_lacks_goes_to_the_same_moment_of_the_music():
    bars, timing = pickup_songs()
    helix = {'id': 'h', 'at': at('p0', 64, 64), 'action': {'type': 'midi.helix', 'preset': 63, 'snapshot': 1}}        # beat 2 of the 5-beat bar 0: 0.5 s
    mixer = {'id': 'x', 'at': at('p0', 0, 64), 'action': {'type': 'mix.set'}}
    late_in_pickup = {'id': 'v', 'at': at('p0', 4 * 64 + 32, 64), 'action': {'type': 'visual.scene'}}                 # 2.25 s: in the 2-beat bar
    moved, left = flags.remap([helix, mixer, late_in_pickup], bars)
    assert left == 2, 'by bar and beat alone, the two flags on beats the 1-beat bar lacks are lost (as before)'
    report = {}
    moved, left = flags.remap([helix, mixer, late_in_pickup], bars, timing, report)
    assert left == 0 and report['dropped'] == []
    assert moved[0]['at'] == {'measure': 'q1', 'beat': {'n': 0, 'd': 64}}, '0.5 s there is 0.4 s here: the first beat of the 2-beat bar'
    assert moved[1]['at'] == at('q0', 0, 64), 'what fits its partner bar keeps its bar and beat'
    assert moved[2]['at'] == {'measure': 'q1', 'beat': {'n': 64 + 48, 'd': 64}}, '2.25 s there is 2.15 s here: three quarters through its beat 2'


def test_a_moment_before_this_songs_first_bar_goes_on_its_first_beat():
    bars, timing = pickup_songs()
    timing['shift'] = -.5                                                       # the first moments of the other song are before this one starts
    report = {}
    moved, left = flags.remap([{'id': 'a', 'at': at('p0', 32, 64), 'action': {'type': 'midi.pc'}}], {}, timing, report)
    assert left == 0 and moved[0]['at'] == {'measure': 'q0', 'beat': {'n': 0, 'd': 64}}


def test_after_the_end_midi_flags_go_in_the_last_bar_and_the_rest_are_named_and_left_out():
    bars, timing = pickup_songs()
    cues = [{'id': 'm2', 'at': at('p8', 2), 'action': {'type': 'midi.cc', 'cc': 64}},
            {'id': 'm1', 'at': at('p8', 0), 'action': {'type': 'midi.helix', 'preset': 12}},
            {'id': 'stop', 'at': at('p8', 1), 'action': {'type': 'command', 'command': 'stop'}},
            {'id': 'ok', 'at': at('p3', 1), 'action': {'type': 'visual.scene'}}]
    report = {}
    moved, left = flags.remap(cues, bars, timing, report)
    assert [c['id'] for c in moved] == ['m2', 'm1', 'ok'] and left == 1
    assert moved[1]['at'] == {'measure': 'q8', 'beat': {'n': 3 * 64, 'd': 64}} and moved[0]['at'] == {'measure': 'q8', 'beat': {'n': 3 * 64 + 1, 'd': 64}}, \
        'on the last bar’s last beat, still in the order they had in the music'
    assert len(report['to_last']) == 2
    assert report['dropped'] == [{'what': 'the Playback flag', 'bar': 8, 'beat': 2, 'seconds': 17.0}]
    words = flags.left_out_words({'dropped': report['dropped'], 'to_last': 2})
    assert words.startswith('1 could not be copied, because its place in the music is not in this song: the Playback flag at bar 8, beat 2 (0:17).')
    assert '2 MIDI flags were after the end' in words


def test_the_plan_names_each_thing_left_out_and_takes_a_new_name(two_songs):
    lib, store, saved = two_songs
    body = dict(arrangement(), id='p2', name='Outrun the Night', regions=[], jumps=[], holds=[],
                cues=[{'id': 'h', 'at': at('p0', 64, 64), 'action': {'type': 'midi.helix', 'preset': 63}},
                      {'id': 'z', 'at': at('p8', 1), 'action': {'type': 'visual.scene', 'scene': 'starlane'}}])
    store.save_performance(body, 0)
    bars, timing = pickup_songs()
    planned = flags.plan(store, 'p2', B, bars, None, timing)
    assert planned['copied']['flags'] == 1 and planned['left_out'] == 1 and planned['to_last'] == 0
    assert 'the Visuals flag at bar 8, beat 2' in flags.left_out_words(planned)
    done = flags.apply(store, 'p2', B, bars, '  Outrun (lower)  ', None, timing)
    assert done['name'] == 'Outrun (lower)', 'the name typed in the window, trimmed'
    assert flags.apply(store, 'p2', B, bars, '', None, timing)['name'] == 'Outrun the Night', 'an empty box keeps the original’s name'


# ---------------------------------------------------------------- a break the two analyses split the other way round
def swapped_songs():
    """Six beats of a break, heard as a 2-beat bar 8 and a 4-beat bar 9 by one analysis, and as a 4-beat bar 8 and a 2-beat bar 9 by the other.
    Every other bar is 4 beats, the grids are the same music, and the second recording is 0.15 s later. Beats are half a second."""
    lengths = [4] * 8 + [2, 4] + [4] * 6
    flipped = [4] * 8 + [4, 2] + [4] * 6

    def grid(beats_per_bar, first):
        out, t = [], first
        for i, n in enumerate(beats_per_bar):
            out.append({'number': i, 'start': t, 'end': t + n * .5, 'beats': [t + k * .5 for k in range(n)]})
            t += n * .5
        return out
    theirs, mine = grid(lengths, 0.0), grid(flipped, .15)
    for i, b in enumerate(theirs):
        b['id'] = f'p{i}'
    for i, b in enumerate(mine):
        b['id'] = f'q{i}'
    bars = {f'p{i}': {'id': f'q{i}', 'beats': len(mine[i]['beats']), 'number': i, 'from': [theirs[i]['start'], theirs[i]['end']],
                      'to': [mine[i]['start'], mine[i]['end']]} for i in range(len(theirs))}
    timing = {'shift': .15, 'theirs': {b['id']: {'number': b['number'], 'beats': b['beats'], 'end': b['end']} for b in theirs}, 'mine': mine}
    return bars, timing, theirs, mine


def test_a_bar_split_the_other_way_goes_by_its_moment_even_on_a_beat_its_partner_has():
    bars, timing, *_ = swapped_songs()
    first_of_9 = {'id': 'a', 'at': at('p9', 0, 64), 'action': {'type': 'midi.pc'}}       # 17.0 s there, 17.15 s here: beat 2 of the 4-beat bar 8
    on_8 = {'id': 'b', 'at': at('p8', 64, 64), 'action': {'type': 'mix.set'}}            # 16.5 s: beat 1 of bar 8 in both
    after = {'id': 'c', 'at': at('p10', 0, 64), 'action': {'type': 'visual.scene'}}      # the bars agree again from bar 10
    moved, left = flags.remap([first_of_9, on_8, after], bars)
    assert moved[0]['at'] == at('q9', 0, 64), 'by bar number alone it lands two beats late (the old behavior)'
    report = {}
    moved, left = flags.remap([first_of_9, on_8, after], bars, timing, report)
    assert left == 0 and report['dropped'] == []
    assert moved[0]['at'] == {'measure': 'q8', 'beat': {'n': 128, 'd': 64}}
    assert moved[1]['at'] == {'measure': 'q8', 'beat': {'n': 64, 'd': 64}}
    assert moved[2]['at'] == at('q10', 0, 64)
