"""Transposing a song's analysis (stem_tool/transpose.py): chords, key, lead sheet and MIDI, each as one undoable step in the app's own history."""
import json
import re
from pathlib import Path

import mido
import pytest

from chordbuddy.documents import DocumentStore
from chordbuddy.library import Library
from stem_tool import transpose as tr

FIXTURE = json.loads((Path(__file__).parent / 'fixtures' / 'lead-sheet-song.json').read_text(encoding='utf-8'))


# ---------------------------------------------------------------- chords and keys
@pytest.mark.parametrize('label,n,flats,expect', [
    ('G', -4, True, 'Eb'), ('G', -4, False, 'D#'), ('Em', -4, True, 'Cm'), ('F#7', -4, False, 'D7'), ('Bm', 2, False, 'C#m'),
    ('C/E', -4, True, 'Ab/C'), ('Am7/G', 3, False, 'Cm7/A#'), ('D/F#', -2, False, 'C/E'), ('Bbmaj7', 2, False, 'Cmaj7'),
    ('C#m7b5', -1, False, 'Cm7b5'), ('Gsus4', 5, False, 'Csus4'), ('G:maj', -4, True, 'Eb:maj'), ('C/5', 2, False, 'D/5'),
    ('N', -4, True, 'N'), ('', -4, True, ''), ('%', 3, False, '%'), ('Ebb', 2, True, 'E'), ('A', 12, False, 'A'), ('A', -12, False, 'A'),
])
def test_a_chord_moves_by_its_root_and_bass_and_keeps_its_kind(label, n, flats, expect):
    assert tr.transpose_chord(label, n, flats) == expect


def test_a_chord_that_is_not_text_is_left_alone():
    assert tr.transpose_chord(None, 3) is None


@pytest.mark.parametrize('name,n,expect', [('G major', -4, 'Eb major'), ('E minor', -4, 'C minor'), ('C major', 1, 'Db major'), ('A minor', 1, 'Bb minor'),
                                           ('F# minor', -2, 'E minor'), ('Bb major', 2, 'C major'), ('D major', 12, 'D major')])
def test_a_key_moves_and_is_named_the_way_the_app_names_keys(name, n, expect):
    assert tr.transpose_key_name(name, n) == expect


def test_every_moved_key_is_one_the_apps_menu_knows():
    # the 24 names of chordbuddy/web/key-estimate.js (KEY_CHOICES), worked out the same way
    known = {tr.key_name(t, m) for t in range(12) for m in ('major', 'minor')}
    assert len(known) == 24 and {'Eb major', 'F# minor', 'Bb minor', 'Db major', 'C# minor'} <= known
    for name in known:
        for n in range(-12, 13):
            assert tr.transpose_key_name(name, n) in known
    assert tr.transpose_key_name('not a key', 3) is None and tr.transpose_key_name('', 3) is None


def test_the_models_key_file_moves_and_keeps_its_times():
    text = '0.0\t61.2\tG:major\n61.2\t200.0\tE:minor\n'
    assert tr.transpose_key_lab(text, -4) == '0.0\t61.2\tD#:major\n61.2\t200.0\tC:minor\n'
    assert tr.transpose_key_lab('0\t10\tBb:maj', 2) == '0\t10\tC:maj'
    assert tr.transpose_key_lab('nothing here', 5) == 'nothing here'


# ---------------------------------------------------------------- MIDI
def test_midi_notes_move_and_drums_stay():
    content = {'tracks': [{'name': 'Melody', 'is_drum': False}, {'name': 'Kit', 'is_drum': True}], 'duration': 4,
               'notes': [{'id': 'a', 'pitch': 67, 'track': 0, 'channel': 0, 'start': 0, 'end': 1, 'velocity': 90},
                         {'id': 'b', 'pitch': 36, 'track': 1, 'channel': 9, 'start': 0, 'end': 1, 'velocity': 90},
                         {'id': 'c', 'pitch': 38, 'track': 1, 'channel': 0, 'start': 1, 'end': 2, 'velocity': 90},
                         {'id': 'd', 'pitch': 2, 'track': 0, 'channel': 0, 'start': 2, 'end': 3, 'velocity': 90},
                         {'id': 'e', 'pitch': 126, 'track': 0, 'channel': 0, 'start': 3, 'end': 4, 'velocity': 90}]}
    moved, counts = tr.transpose_midi(content, -4)
    assert [n['pitch'] for n in moved['notes']] == [63, 36, 38, 10, 122] and counts == {'moved': 3, 'drums': 2, 'folded': 1}
    assert content['notes'][0]['pitch'] == 67, 'the original is not touched'
    up, counts = tr.transpose_midi(content, 4)
    assert up['notes'][4]['pitch'] == 118 and counts['folded'] == 1
    assert moved['tracks'] == content['tracks'] and [n['id'] for n in moved['notes']] == list('abcde')


# ---------------------------------------------------------------- the lead sheet
def pitches(abc):
    """An independent reading of an ABC tune's notes as MIDI numbers per voice, in order: the yardstick the transposer is checked against.
    Written the long way round on purpose (it shares no code with transpose.py)."""
    sharps_order, flats_order = 'FCGDAEB', 'BEADGCF'
    majors = {'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'C#': 7, 'F': -1, 'Bb': -2, 'Eb': -3, 'Ab': -4, 'Db': -5, 'Gb': -6, 'Cb': -7}
    minors = {'A': 0, 'E': 1, 'B': 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, 'D': -1, 'G': -2, 'C': -3, 'F': -4, 'Bb': -5, 'Eb': -6, 'Ab': -7}
    base = {'C': 60, 'D': 62, 'E': 64, 'F': 65, 'G': 67, 'A': 69, 'B': 71}
    signature, voices, voice, bar = {}, {}, 'only', {}
    in_body = False
    for line in abc.splitlines():
        head = re.match(r'^\s*([A-Za-z]):(.*)$', line)
        if head:
            if head.group(1) == 'K':
                name = head.group(2).split('%')[0].strip()
                minor = bool(re.search(r'(m|min|minor)$', name)) and not name.endswith('maj')
                tonic = re.match(r'[A-G][#b]?', name).group(0)
                count = (minors if minor else majors)[tonic]
                signature = {letter: 1 for letter in sharps_order[:max(0, count)]}
                signature.update({letter: -1 for letter in flats_order[:max(0, -count)]})
                in_body = True
            if head.group(1) == 'V':
                voice = head.group(2).split()[0]
            bar = {}
            continue
        if not in_body or line.lstrip().startswith('%'):
            continue
        line = re.sub(r'"[^"]*"', '', line)
        line = re.sub(r'![^!]*!', '', line).split('%')[0]
        for token in re.finditer(r"(\|)|([\^_=]*)([A-Ga-g])([,']*)", line):
            if token.group(1):
                bar = {}
                continue
            marks, letter, octave = token.group(2), token.group(3), token.group(4)
            where = (letter.upper(), letter.islower(), octave)
            if marks:
                bar[where] = marks.count('^') - marks.count('_')
            accidental = bar.get(where, signature.get(letter.upper(), 0))
            midi = base[letter.upper()] + (12 if letter.islower() else 0) + 12 * octave.count("'") - 12 * octave.count(',') + accidental
            voices.setdefault(voice, []).append(midi)
    return voices


ACCIDENTALS = 'X:1\nT:Test\nM:4/4\nL:1/8\nK:D\n"D"D2 ^G2 G2 =G2|"A"A,2 _B2 B2 c\'2|"Bm"^^f2 f2 __e2 e2|"G"[GBd]4 {^c}d4|\n'


@pytest.mark.parametrize('n', list(range(-12, 13)))
def test_every_note_of_a_tune_with_accidentals_moves_by_exactly_that_much(n):
    if n == 0:
        return
    moved = tr.transpose_abc(ACCIDENTALS, n)
    before, after = pitches(ACCIDENTALS)['only'], pitches(moved)['only']
    assert after == [p + n for p in before], moved
    assert len(re.findall(r'"[^"]*"', moved)) == 4 and moved.count('|') == ACCIDENTALS.count('|')


@pytest.mark.parametrize('n', [-4, -2, -1, 1, 3, 5, 7])
def test_a_real_analyzed_lead_sheet_moves_note_for_note_in_both_voices(n):
    abc = FIXTURE['abc']
    moved = tr.transpose_abc(abc, n)
    before, after = pitches(abc), pitches(moved)
    assert set(after) == set(before) == {'Vocal', 'Ins'}
    for voice in before:
        assert after[voice] == [p + n for p in before[voice]]
    # everything that is not a note or a chord symbol is exactly where it was: same lines, same bars, same rests and lengths
    strip = lambda text: re.sub(r"[\^_=]*[A-Ga-g][,']*", 'n', re.sub(r'"[^"]*"', '"c"', re.sub(r'^K:.*$', 'K:', text, flags=re.M)))
    assert strip(moved) == strip(abc)


def test_the_key_line_and_chord_symbols_follow():
    moved = tr.transpose_abc(FIXTURE['abc'], -4)                        # D major, four semitones down: B flat major
    assert 'K:Bb\n' in moved and 'K:D' not in moved
    assert '"Bb"' in moved and '"F"' in moved and '"Gm"' in moved and '"D7"' in moved
    assert 'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"' in moved, 'a voice’s name is not a chord'
    assert tr.transpose_abc('X:1\nK:Bm\nB2|', 1).splitlines()[1] == 'K:Cm'
    assert tr.transpose_abc('X:1\nK:F#min\nF2|', -2).splitlines()[1] == 'K:Emin'


def test_few_accidentals_are_written_because_the_new_key_carries_them():
    moved = tr.transpose_abc('X:1\nL:1/4\nK:C\nC D E F|G A B c|\n', -4)       # A flat major: every flat is in the key signature
    assert moved.splitlines()[3] == 'A, B, C D|E F G A|'
    sharp = tr.transpose_abc('X:1\nL:1/4\nK:C\nC ^C C =C|\n', 2)             # an accidental lasts the bar, and is cancelled when the tune cancels it
    assert sharp.splitlines()[3] == 'D ^D D =D|'


def test_there_and_back_gives_the_same_notes():
    abc = FIXTURE['abc']
    back = tr.transpose_abc(tr.transpose_abc(abc, -4), 4)
    assert pitches(back) == pitches(abc) and re.search(r'^K:D$', back, re.M)


def test_only_the_chord_symbols_can_move():
    moved = tr.transpose_abc(FIXTURE['abc'], -4, chords_only=True)
    assert 'K:D\n' in moved and pitches(moved) == pitches(FIXTURE['abc'])
    assert '"A#"' in moved and '"Gm"' in moved and '"Bm"' not in moved and '"Bb"' not in moved, 'D major stays the key, so its chords are named with sharps as before'


@pytest.mark.parametrize('abc', ['X:1\nK:D dor\nD2|', 'X:1\nK:C\nC2|[K:G]G2|', 'X:1\nK:C\nC2|\nK:G\nG2|', 'X:1\nT:no key\nC2|', 'X:1\nK:HP\nA2|'])
def test_notation_it_does_not_handle_is_refused_whole(abc):
    with pytest.raises(tr.Unsupported):
        tr.transpose_abc(abc, 2)


# ---------------------------------------------------------------- a whole song, through the app's own store
@pytest.fixture
def analyzed(tmp_path, mp3_bytes):
    """A song as an analysis leaves it: a lead sheet, a chart made from its chords, a MIDI part and the model's key (as tests/test_documents.py makes one)."""
    lib = Library(tmp_path)
    song = lib.import_audio('Test.mp3', mp3_bytes)
    run = lib.create_run(song['id'])
    (run / 'score.abc').write_text('X:1\nT:Test\nM:4/4\nL:1/4\nK:G\n"G"G2 B2|"C"c2 e2|"D"d2 ^f2|"Em"e4|\n')
    (run / 'key.lab').write_text('0.0\t1.0\tG:major\n')
    (run / 'events.json').write_text(json.dumps({'events': [{'time': 0, 'values': {'chord': 'G:maj'}}, {'time': .1, 'values': {'chord': 'C:maj'}},
                                                            {'time': .2, 'values': {'chord': 'D:maj'}}, {'time': .3, 'values': {'chord': 'E:min'}}]}))
    mid, track = mido.MidiFile(), mido.MidiTrack()
    mid.tracks.append(track)
    track.extend([mido.MetaMessage('set_tempo', tempo=600000), mido.Message('note_on', note=67, velocity=90, time=0), mido.Message('note_off', note=67, time=960)])
    mid.save(run / 'transcription.mid')
    docs = DocumentStore(lib)
    docs.ingest(song['id'], run, 'completed', None)
    yield lib, docs, song['id']
    lib.close()


def by_kind(docs, song_id):
    out = {}
    for item in docs.for_song(song_id):
        out.setdefault('key' if item['name'].endswith('key.lab') else item['kind'], docs.get(item['id']))
    return out


def test_the_plan_says_what_would_change_and_changes_nothing(analyzed):
    lib, docs, song = analyzed
    before = by_kind(docs, song)
    planned = tr.public(tr.plan(docs, lib, song, -4))
    assert planned['words'] == '4 semitones down' and planned['key'] == ['G major', 'Eb major']
    assert planned['chords'][:4] == [['G', 'Eb'], ['C', 'Ab'], ['D', 'Bb'], ['Em', 'Cm']]
    assert len(planned['parts']) >= 3 and 'changes' not in planned and not planned['warnings']
    json.dumps(planned)
    assert {k: (v['content'], v['revision']) for k, v in by_kind(docs, song).items()} == {k: (v['content'], v['revision']) for k, v in before.items()}
    for bad in (0, 13, -13, 1.5, None, '4'):
        with pytest.raises(ValueError):
            tr.plan(docs, lib, song, bad)


def test_applying_moves_everything_one_undoable_step_each(analyzed):
    lib, docs, song = analyzed
    before = by_kind(docs, song)
    done = tr.apply(docs, lib, song, -4)
    after = by_kind(docs, song)
    assert [c['label'] for c in after['chart']['content']['chords'] if c['label'] != 'N'] == ['Eb', 'Ab', 'Bb', 'Cm']
    assert '\nK:Eb\n' in after['abc']['content']['abc'] and '"Eb"' in after['abc']['content']['abc'] and '"Cm"' in after['abc']['content']['abc']
    assert pitches(after['abc']['content']['abc']) == {'only': [p - 4 for p in pitches(before['abc']['content']['abc'])['only']]}
    assert [c['label'] for c in after['abc']['content']['chords']] == ['Eb', 'Ab', 'Bb', 'Cm'], 'the lead sheet’s chord links follow'
    assert [n['pitch'] for n in after['midi']['content']['notes']] == [63]
    assert after['key']['content']['text'] == '0.0\t1.0\tD#:major\n'
    assert len(done['done']) == 4
    for kind in ('chart', 'abc', 'midi', 'key'):
        assert after[kind]['revision'] == before[kind]['revision'] + 1 and after[kind]['can_undo']
        assert after[kind]['undo_label'] == 'Transpose 4 semitones down'
    # Undo in the app is this call: each document goes back to exactly what it was
    for kind in ('chart', 'abc', 'midi', 'key'):
        undone = docs.history(after[kind]['id'], 'undo', after[kind]['revision'])
        assert undone['content'] == before[kind]['content']
    # and the files the analysis wrote are never touched
    run_folder = lib.root / song / 'runs'
    assert '"G"' in next(run_folder.rglob('score.abc')).read_text()


def test_a_key_chosen_by_hand_moves_with_the_song(analyzed):
    lib, docs, song = analyzed
    lib.write_prefs({'cb-key:' + song: 'E minor'})
    planned = tr.apply(docs, lib, song, -4)
    assert planned['key'] == ['E minor', 'C minor'] and lib.read_prefs()['cb-key:' + song] == 'C minor'
    assert [c['label'] for c in by_kind(docs, song)['chart']['content']['chords'] if c['label'] != 'N'] == ['Eb', 'Ab', 'Bb', 'Cm'], 'C minor is a flat key'


def test_up_then_down_lands_where_it_started(analyzed):
    lib, docs, song = analyzed
    before = by_kind(docs, song)
    tr.apply(docs, lib, song, 5)
    tr.apply(docs, lib, song, -5)
    after = by_kind(docs, song)
    assert [c['label'] for c in after['chart']['content']['chords']] == [c['label'] for c in before['chart']['content']['chords']]
    assert pitches(after['abc']['content']['abc']) == pitches(before['abc']['content']['abc'])
    assert after['midi']['content']['notes'] == before['midi']['content']['notes']


def test_the_melody_can_be_left_so_hand_placed_syllables_survive(analyzed):
    lib, docs, song = analyzed
    before = by_kind(docs, song)['abc']
    planned = tr.apply(docs, lib, song, -4, melody=False)
    after = by_kind(docs, song)['abc']['content']['abc']
    assert '\nK:G\n' in after and pitches(after) == pitches(before['content']['abc']) and '"D#"' in after
    assert any('chord symbols' in part for part in planned['parts'])


# ---------------------------------------------------------------- the window's buttons
def test_the_window_previews_then_transposes_and_says_how_to_take_it_back(analyzed):
    from stem_tool.controller import Controller
    from stem_tool.engine import Workspace
    lib, docs, song = analyzed
    space = Workspace(lib.root, lib.root)
    try:
        c = Controller(space)
        assert c.transpose_plan(-4) == {'error': 'Choose a song first.'}
        c.song_id = song                                          # (the song is chosen; this made-up one has no stems, which transposing does not need)
        assert 'Choose how far' in c.transpose_plan(0)['error'] and 'Choose how far' in c.transpose_plan(40)['error']
        planned = c.transpose_plan(-4)['plan']
        assert planned['key'] == ['G major', 'Eb major'] and planned['chords'][0] == ['G', 'Eb'] and 'changes' not in planned
        json.dumps(planned)
        assert [x['label'] for x in by_kind(docs, song)['chart']['content']['chords'] if x['label'] != 'N'] == ['G', 'C', 'D', 'Em'], 'a preview changes nothing'
        c.messages.clear()
        c.transpose(-4)
        assert 'are now 4 semitones down. It is now in Eb major.' in c.messages[0] and 'move it 4 semitones up here' in c.messages[0]
        fresh = DocumentStore(Library(lib.root))                  # as Chord Buddy would read it on its next start
        assert [x['label'] for x in by_kind(fresh, song)['chart']['content']['chords'] if x['label'] != 'N'] == ['Eb', 'Ab', 'Bb', 'Cm']
        c.transpose(4)
        assert [x['label'] for x in by_kind(DocumentStore(Library(lib.root)), song)['chart']['content']['chords'] if x['label'] != 'N'] == ['G', 'C', 'D', 'Em']
    finally:
        space.close()


# ---------------------------------------------------------------- which key the song is said to be in
def test_the_key_named_is_the_one_chord_buddy_shows_not_the_models_file(analyzed):
    lib, docs, song = analyzed                                    # the model's file says G major
    assert tr.plan(docs, lib, song, -4)['key'] == ['G major', 'Eb major'], 'with nothing else to go by, the model’s file'
    shown = tr.plan(docs, lib, song, -4, shown_key='E minor')       # the app overruled the model from the chords, and shows E minor
    assert shown['key'] == ['E minor', 'C minor']
    assert [c[1] for c in shown['chords'][:4]] == ['Eb', 'Ab', 'Bb', 'Cm'], 'C minor is a flat key, so the moved chords are spelled with flats'
    sharp = tr.plan(docs, lib, song, 2, shown_key='E minor')        # F# minor: sharps
    assert sharp['key'] == ['E minor', 'F# minor'] and [c[1] for c in sharp['chords'][:4]] == ['A', 'D', 'E', 'F#m']
    for nonsense in ('', None, 'H major', 'loud', 5):
        assert tr.plan(docs, lib, song, -4, shown_key=nonsense)['key'] == ['G major', 'Eb major'], 'a key that is not a key is not believed'


def test_a_key_chosen_by_hand_is_still_moved_with_the_song_whatever_is_shown(analyzed):
    lib, docs, song = analyzed
    lib.write_prefs({'cb-key:' + song: 'E minor'})
    done = tr.apply(docs, lib, song, -4, shown_key='E minor')
    assert done['key'] == ['E minor', 'C minor'] and lib.read_prefs()['cb-key:' + song] == 'C minor'
    assert by_kind(docs, song)['key']['content']['text'] == '0.0\t1.0\tD#:major\n', 'the model’s own file moves too, so the app’s check of it still works'


def test_the_window_hands_the_page_what_the_app_goes_by(analyzed):
    from stem_tool.controller import Controller
    from stem_tool.engine import Workspace
    lib, docs, song = analyzed
    space = Workspace(lib.root, lib.root)
    try:
        c = Controller(space)
        assert c.key_clues() == {'saved': '', 'key_lab': None}
        c.song_id = song
        assert c.key_clues() == {'saved': '', 'key_lab': '0.0\t1.0\tG:major\n'}
        lib.write_prefs({'cb-key:' + song: 'E minor'})
        assert c.key_clues()['saved'] == 'E minor'
        assert c.transpose_plan(-4, True, 'E minor')['plan']['key'] == ['E minor', 'C minor']
        c.messages.clear()
        c.transpose(-4, True, 'E minor')
        assert 'It is now in C minor.' in c.messages[0]
    finally:
        space.close()
