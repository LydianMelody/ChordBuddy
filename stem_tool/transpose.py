"""Transpose a song's analysis: its chords, its key, its lead sheet and its MIDI parts, by a number of semitones, with no model involved.

For when the stems were replaced with ones in another key (a singer asks for the song lower): the audio moved, so what is shown must move too.

Nothing is overwritten. Every document Chord Buddy keeps (the chart, the lead sheet, each MIDI part, the model's own key) has an edit history,
and a transposition is saved through the app's own DocumentStore as ONE new step in each, so Undo in Chord Buddy (or History) takes it back, and
the app's own validation has the last word on what is stored. The pure functions below work on text and numbers only and are tested on their own.
"""
from __future__ import annotations

import re

NATURAL = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
LETTERS = 'CDEFGAB'
SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
# keys usually written with flats, as the app's own key names have it (chordbuddy/web/key-estimate.js); the rest use sharps
FLAT_MAJOR, FLAT_MINOR = {5, 10, 3, 8, 1}, {2, 7, 0, 5, 10}
PITCH = r'[A-G](?:#{1,2}|b{1,2})?'
LIMIT = 12                                   # an octave either way is as far as anyone moves a song


class Unsupported(ValueError):
    """This piece of the analysis is written in a way the transposer does not handle, so it is left exactly as it is (and said so)."""


def pitch_class(name):
    return (NATURAL[name[0]] + name.count('#') - name.count('b')) % 12


def key_name(tonic, mode):
    """A key's name exactly as the app writes it ('Eb major', 'F# minor'), so a saved key is still one the app's menu knows."""
    names = FLAT if tonic in (FLAT_MINOR if mode == 'minor' else FLAT_MAJOR) else SHARP
    return f'{names[tonic]} {mode}'


def transpose_key_name(name, semitones):
    """'G major' moved: 'Eb major'. None if it is not a key name."""
    match = re.fullmatch(rf'\s*({PITCH})\s+(major|minor)\s*', str(name or ''))
    return key_name((pitch_class(match.group(1)) + semitones) % 12, match.group(2)) if match else None


def key_uses_flats(name):
    match = re.fullmatch(rf'\s*({PITCH})\s+(major|minor)\s*', str(name or ''))
    if not match:
        return None
    if len(match.group(1)) > 1:
        return 'b' in match.group(1)
    return pitch_class(match.group(1)) in (FLAT_MINOR if match.group(2) == 'minor' else FLAT_MAJOR)


def transpose_chord(label, semitones, flats=False):
    """A chord's name moved: its root and the bass after a slash; what kind of chord it is stays word for word. 'N' (no chord) and anything
    that does not start with a note name comes back unchanged."""
    if not isinstance(label, str):
        return label
    match = re.fullmatch(rf'({PITCH})(:?[^/]*)(?:/(.+))?', label)
    if not match:
        return label
    names = FLAT if flats else SHARP
    root, quality, bass = match.groups()
    out = names[(pitch_class(root) + semitones) % 12] + quality
    if bass is not None:
        out += '/' + (names[(pitch_class(bass) + semitones) % 12] if re.fullmatch(PITCH, bass) else bass)     # a bass given as a scale degree (/5) is still that degree
    return out


def transpose_key_lab(text, semitones):
    """The model's own key file ("start<TAB>end<TAB>F:minor" per line), each key moved. Lines that are not keys are kept as they are."""
    def move(match):
        tonic, mode = match.group(1), match.group(2)
        names = FLAT if 'b' in tonic else SHARP
        return names[(pitch_class(tonic) + semitones) % 12] + ':' + mode
    return re.sub(rf'(?<![A-Za-z#])({PITCH}):(maj(?:or)?|min(?:or)?)\b', move, str(text))


def transpose_midi(content, semitones):
    """A MIDI part's notes moved. Drums are left alone (their "pitches" are which drum is hit). A note that would leave the keyboard is moved an
    octave back into it. Returns (content, {moved, drums, folded})."""
    drum_tracks = {i for i, t in enumerate(content.get('tracks') or []) if isinstance(t, dict) and t.get('is_drum')}
    notes, moved, drums, folded = [], 0, 0, 0
    for note in content['notes']:
        if note.get('channel') == 9 or note.get('track') in drum_tracks:
            notes.append(note)
            drums += 1
            continue
        pitch = note['pitch'] + semitones
        while pitch > 127:
            pitch -= 12
            folded += 1
        while pitch < 0:
            pitch += 12
            folded += 1
        notes.append(dict(note, pitch=pitch))
        moved += 1
    return dict(content, notes=notes), {'moved': moved, 'drums': drums, 'folded': folded}


# ---------------------------------------------------------------- the lead sheet (ABC notation)
def _fifths(tonic, minor):
    """How many sharps (positive) or flats (negative) a key has."""
    base = {'F': -1, 'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5}[tonic[0]]
    return base + 7 * (tonic.count('#') - tonic.count('b')) - (3 if minor else 0)


def _signature(count):
    """The accidental each letter carries in a key with this many sharps or flats: {'F': 1, ...}."""
    sig = dict.fromkeys(LETTERS, 0)
    for letter in 'FCGDAEB'[:max(0, count)]:
        sig[letter] = 1
    for letter in 'BEADGCF'[:max(0, -count)]:
        sig[letter] = -1
    return sig


def _parse_key(field):
    """'D', 'Bm', 'F#min', 'Eb maj' -> (tonic, minor, the mode as it was written). Anything fancier is not handled."""
    match = re.fullmatch(r'\s*([A-G][#b]?)\s*(m|min|minor|maj|major)?\s*(%.*)?', field)
    if not match:
        raise Unsupported(f'the lead sheet’s key is written in a way that can’t be moved safely (K:{field.strip()})')
    tonic, mode = match.group(1), match.group(2) or ''
    return tonic, mode in ('m', 'min', 'minor'), mode


def _new_tonic(tonic, minor, semitones):
    """The moved key's name, spelled the way that key is normally written (never more than six sharps or flats)."""
    target = (pitch_class(tonic) + semitones) % 12
    choices = []
    for letter in LETTERS:
        for mark, shift in (('', 0), ('#', 1), ('b', -1)):
            if (NATURAL[letter] + shift) % 12 == target:
                count = _fifths(letter + mark, minor)
                if abs(count) <= 6:
                    choices.append((abs(count), 0 if (count < 0) == ('b' in tonic or _fifths(tonic, minor) < 0) else 1, letter + mark))
    return min(choices)[2]


def _steps(old_tonic, new_tonic, semitones):
    """How many letter names every note moves (D to Bb, four semitones down, is two letters down)."""
    octaves = int(semitones / 12)
    rest = semitones - 12 * octaves
    up = (LETTERS.index(new_tonic[0]) - LETTERS.index(old_tonic[0])) % 7
    return min((up - 7, up, up + 7), key=lambda s: abs(s - rest * 7 / 12)) + 7 * octaves      # the nearest in letters to that many semitones


_NOTE = re.compile(r"(\^{1,2}|_{1,2}|=)?([A-Ga-g])([,']*)")
_HEADER = re.compile(r'^\s*([A-Za-z]):')


def transpose_abc(abc, semitones, chords_only=False):
    """A lead sheet moved: its key signature, every note (keeping accidentals right bar by bar), and every chord symbol.

    chords_only: only the chord symbols move; the key and the melody stay (for a lead sheet whose hand-placed syllables must not be reset).
    Raises Unsupported, changing nothing, for notation it does not handle (a key change in the middle of a line, an unusual mode)."""
    lines = abc.splitlines(keepends=True)
    key = None
    for line in lines:
        head = _HEADER.match(line)
        if head and head.group(1) == 'K':
            key = _parse_key(line.split(':', 1)[1].rstrip('\r\n'))
            break
    if key is None:
        raise Unsupported('the lead sheet has no key line')
    tonic, minor, mode = key
    flats_before = _fifths(tonic, minor) < 0
    new_tonic = _new_tonic(tonic, minor, semitones)
    steps = _steps(tonic, new_tonic, semitones)
    old_sig, new_sig = _signature(_fifths(tonic, minor)), _signature(_fifths(new_tonic, minor))
    chord_flats = (_fifths(new_tonic, minor) < 0) if not chords_only else flats_before
    old_bar, new_bar = {}, {}                        # accidentals in force in this bar: {(letter, octave): accidental}
    out = []

    def move_note(match):
        mark, letter, octave_marks = match.groups()
        octave = (5 if letter.islower() else 4) + octave_marks.count("'") - octave_marks.count(',')
        name = letter.upper()
        if mark:
            accidental = 0 if mark == '=' else (len(mark) if mark[0] == '^' else -len(mark))
            old_bar[(name, octave)] = accidental
        else:
            accidental = old_bar.get((name, octave), old_sig[name])
        midi = 12 * (octave + 1) + NATURAL[name] + accidental + semitones
        for shift in (0, 1, -1):                     # the letter the key gives it; a neighbor only if that would need a triple sharp or flat
            degree = octave * 7 + LETTERS.index(name) + steps + shift
            new_octave, new_name = divmod(degree, 7)
            new_name = LETTERS[new_name]
            new_accidental = midi - (12 * (new_octave + 1) + NATURAL[new_name])
            if abs(new_accidental) <= 2:
                break
        else:
            raise Unsupported('a note in the lead sheet could not be respelled')
        in_force = new_bar.get((new_name, new_octave), new_sig[new_name])
        written = ''
        if new_accidental != in_force:
            written = '=' if new_accidental == 0 else ('^' * new_accidental if new_accidental > 0 else '_' * -new_accidental)
            new_bar[(new_name, new_octave)] = new_accidental
        if new_octave >= 5:
            return written + new_name.lower() + "'" * (new_octave - 5)
        return written + new_name + ',' * (4 - new_octave)

    seen_key = False
    for line in lines:
        head = _HEADER.match(line)
        if head or line.lstrip().startswith('%'):
            field = head.group(1) if head else ''
            if field == 'K':
                if seen_key:
                    raise Unsupported('the lead sheet changes key part-way through')
                seen_key = True
                if not chords_only:
                    ending = line[len(line.rstrip('\r\n')):]
                    line = f'{line[:line.index(":") + 1]}{new_tonic}{mode}{ending}'
            if field in ('V', 'K', 'M'):
                old_bar.clear()
                new_bar.clear()
            out.append(line)
            continue
        if not seen_key:                             # anything before the key line is heading, not music
            out.append(line)
            continue
        i, built = 0, []
        while i < len(line):
            c = line[i]
            if c == '"':                             # a chord symbol, or words written over the staff
                end = line.find('"', i + 1)
                if end < 0:
                    built.append(line[i:])
                    break
                text = line[i + 1:end]
                if text and not text.startswith(('^', '_', '<', '>', '@')):
                    text = transpose_chord(text, semitones, chord_flats)
                built.append('"' + text + '"')
                i = end + 1
            elif c == '%':                           # a comment runs to the end of the line
                built.append(line[i:])
                break
            elif c == '!':                           # a decoration (!fermata!): its letters are not notes
                end = line.find('!', i + 1)
                end = len(line) - 1 if end < 0 else end
                built.append(line[i:end + 1])
                i = end + 1
            elif c == '[' and re.match(r'\[[A-Za-z]:', line[i:]):
                if line[i + 1] == 'K':
                    raise Unsupported('the lead sheet changes key part-way through')
                end = line.find(']', i)
                end = len(line) - 1 if end < 0 else end
                built.append(line[i:end + 1])
                i = end + 1
            elif c == '|':
                old_bar.clear()
                new_bar.clear()
                built.append(c)
                i += 1
            else:
                match = _NOTE.match(line, i) if not chords_only else None
                if match:
                    built.append(move_note(match))
                    i = match.end()
                else:
                    built.append(c)
                    i += 1
        out.append(''.join(built))
    return ''.join(out)


# ---------------------------------------------------------------- a whole song
def words(semitones):
    count = abs(semitones)
    return f'{count} semitone{"" if count == 1 else "s"} {"down" if semitones < 0 else "up"}'


def _chord_names(chords, limit=8):
    seen = []
    for chord in chords:
        label = chord.get('label')
        if isinstance(label, str) and re.match(PITCH, label) and label not in seen:
            seen.append(label)
    return seen[:limit]


def _saved_key(library, song_id):
    return (library.read_prefs() or {}).get('cb-key:' + song_id) or ''


def plan(documents, library, song_id, semitones, melody=True, shown_key=None):
    """What transposing this song would do, without doing it: {semitones, words, chords: [[before, after]...], key: [before, after] or None,
    parts: what each document would get, warnings}. melody: move the lead sheet's notes and key too (False: only its chord symbols).

    shown_key: the key Chord Buddy itself shows for the song ('C# minor'), worked out in the window by the app's own key code. The app does not
    simply believe the analysis model's key file: it checks the chords against it and overrules it when they plainly disagree (a song in C# minor
    that sits on B a lot is called "B major" by the model), and a key chosen by hand beats both. So the key named here, and the way the moved
    chords are spelled, go by that. Without it (the app's code could not be loaded) the saved choice, then the model's file, are used."""
    if type(semitones) is not int or not -LIMIT <= semitones <= LIMIT or semitones == 0:
        raise ValueError('Choose how far to move it: from 12 semitones down to 12 up.')
    listed = documents.for_song(song_id)
    result = {'semitones': semitones, 'words': words(semitones), 'chords': [], 'key': None, 'parts': [], 'warnings': [], 'changes': []}
    saved = _saved_key(library, song_id)
    model_key = None
    for item in listed:
        full = documents.get(item['id'])
        content, kind, name = full['content'], full['kind'], full['name']
        if kind == 'text' and re.search(r'(^|/)key\.lab$', name):
            new_text = transpose_key_lab(content['text'], semitones)
            match = re.search(rf'({PITCH}):(maj|min)', content['text'])
            if match:
                mode = 'major' if match.group(2) == 'maj' else 'minor'
                model_key = (key_name(pitch_class(match.group(1)), mode), key_name((pitch_class(match.group(1)) + semitones) % 12, mode))
            if new_text != content['text']:
                result['changes'].append((full, {'text': new_text}))
                result['parts'].append('The key the analysis found')
    shown = shown_key if transpose_key_name(shown_key, 0) else None
    flats = key_uses_flats(transpose_key_name(shown or saved, semitones) or (model_key[1] if model_key else None))
    for item in listed:
        full = documents.get(item['id'])
        content, kind = full['content'], full['kind']
        if kind == 'chart':
            chords = [dict(c, label=transpose_chord(c.get('label'), semitones, bool(flats))) for c in content.get('chords', [])]
            before, after = _chord_names(content.get('chords', [])), _chord_names(chords)
            result['chords'] = [list(pair) for pair in zip(before, after)]
            if chords != content.get('chords', []):
                result['changes'].append((full, dict(content, chords=chords)))
                result['parts'].append(f'The chord chart ({sum(1 for a, b in zip(content["chords"], chords) if a != b)} chords)')
        elif kind == 'abc':
            anchors = bool((content.get('engraving') or {}).get('anchors'))
            try:
                moved = transpose_abc(content['abc'], semitones, chords_only=not melody)
            except Unsupported as exc:
                result['warnings'].append(f'The lead sheet is left as it is: {exc}.')
                continue
            if moved != content['abc']:
                result['changes'].append((full, dict(content, abc=moved)))
                result['parts'].append('The lead sheet (its key, melody and chord symbols)' if melody else 'The lead sheet’s chord symbols (its melody and key stay)')
                if melody and anchors:
                    result['warnings'].append('The lead sheet has syllables you placed by hand under its notes. Moving the melody resets them (Undo in Chord Buddy brings them back). Untick “Move the lead sheet’s melody too” to keep them.')
            result['has_anchors'] = result.get('has_anchors', False) or anchors
        elif kind == 'midi':
            moved, counts = transpose_midi(content, semitones)
            if counts['moved']:
                result['changes'].append((full, moved))
                result['parts'].append(f'{full["name"]} ({counts["moved"]} notes' + (f', {counts["drums"]} drum hits left alone' if counts['drums'] else '') + ')')
            if counts['folded']:
                result['warnings'].append(f'{counts["folded"]} notes in {full["name"]} would have left the keyboard and were moved an octave.')
    if saved:
        moved_key = transpose_key_name(saved, semitones)
        if moved_key:
            result['key'] = [saved, moved_key]
            result['saved_key'] = moved_key
    elif model_key:
        result['key'] = list(model_key)
    if shown:                                                # what the app shows is what is named, whatever it came from
        result['key'] = [transpose_key_name(shown, 0), transpose_key_name(shown, semitones)]
    if not result['changes']:
        result['warnings'].append('This song has no chords or notes to move. Analyze it in Chord Buddy first.')
    return result


def apply(documents, library, song_id, semitones, melody=True, shown_key=None):
    """Do it: one new step in each document's history, through the app's own store. Returns the plan, with 'done': the names of what was saved."""
    planned = plan(documents, library, song_id, semitones, melody, shown_key)
    label = f'Transpose {planned["words"]}'
    done = []
    for full, content in planned['changes']:
        documents.save(full['id'], content, label, full['revision'])
        done.append(full['name'])
    if planned.get('saved_key'):
        library.write_prefs({'cb-key:' + song_id: planned['saved_key']})
    planned['done'] = done
    return planned


def public(planned):
    """A plan as the window is sent it (no document contents)."""
    return {k: v for k, v in planned.items() if k != 'changes'}
