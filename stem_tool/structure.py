"""Copy a song's structure and lyrics onto another version of it: its sections (names and where they begin and end), the words of every
section, where each word sits on the bars, and which repeats are shown folded.

For two songs that are the same music (a lowered or instrumental version): the second need not have its sections renamed and its lyrics
typed and placed all over again. Everything goes to the same bars, by the same pairing of bars the action flags use (bar-match.js, handed in
as `bars`: {the first song's measure id: {'id': the other song's measure id, 'beats': how many it has, 'from': [start, end] of the first
song's bar, 'to': [start, end] of its partner}}).

It is only offered when it fits. The app's own rules for a chart (chordbuddy/chart.py validate_chart) are run on the result before anything
is offered, and they decide: every chord must fall in a section, every placed word inside its own section's bars, in order. If the whole
thing does not pass, less is tried (without the folded repeats; then the words without their places on the bars), and what could not be
brought is said. Saving is ONE new step in the other song's chart history, through the app's DocumentStore, so Undo there takes it back. The
other song keeps its own chords, bars and cues.
"""
from __future__ import annotations

import copy

from chordbuddy.chart import validate_chart

from . import flags

SNAP = .06              # seconds: a section edge this close to a barline is on that barline
LEVELS = ('full', 'lines', 'text')
PARTS = ('structure', 'lyrics')     # what can be copied, each on its own: the sections (with the folded repeats and line breaks), the lyrics
PART_WORDS = {('structure',): 'song structure', ('lyrics',): 'lyrics', PARTS: 'song structure and lyrics'}


class NotClose(ValueError):
    """The two songs are not alike enough here for this to be copied; the message says where."""


def _clock(seconds):
    return f'{int(seconds // 60)}:{int(seconds % 60):02d}'


def _pairs(bars):
    """The paired bars in order: [(first song's start, end, partner's start, end, first id, partner id, partner's beats, first's bar number)]."""
    out = []
    for source_id, partner in (bars or {}).items():
        try:
            (a, b), (c, d) = partner['from'], partner['to']
            if b > a and d > c:
                out.append((float(a), float(b), float(c), float(d), source_id, partner['id'], partner.get('beats'), partner.get('number')))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(out)


def map_time(pairs, seconds, source_duration, target_duration):
    """A moment of the first song as the same moment of the other, or None if its bar has no partner there. The very start and the very end
    stay the very start and end; a moment on a barline goes exactly onto the partner's barline; a moment inside a bar keeps its place in it."""
    if seconds <= 1e-6:
        return 0.0
    if seconds >= source_duration - 1e-3:
        return float(target_duration)
    for a, b, c, d, *_ in pairs:
        if abs(seconds - a) <= min(SNAP, (b - a) / 4):       # (never further than a quarter of the bar, however short the bar)
            return c
    for a, b, c, d, *_ in pairs:
        if a <= seconds < b:
            return c + (seconds - a) * (d - c) / (b - a)
    for a, b, c, d, *_ in pairs:                       # the end of the last paired bar before a bar that has no partner
        if abs(seconds - b) <= min(SNAP, (b - a) / 4):
            return d
    return None


def _theirs_at(timing, measure_id, beat):
    """When a beat of the first song's bar is, in seconds (timing as the window hands it: see flags.py), or None."""
    bar = (timing or {}).get('theirs', {}).get(measure_id)
    if not isinstance(bar, dict) or not bar.get('beats') or bar.get('end') is None:
        return None
    times = [float(t) for t in bar['beats']] + [float(bar['end'])]
    x = max(0.0, float(beat))
    i = min(int(x), len(times) - 2)
    return times[i] + (x - i) * (times[i + 1] - times[i])


def mover(pairs, timing, source_duration, target_duration):
    """map_time, except on a bar the two analyses cut differently (flags.reshaped): there a moment goes to the same moment of the other
    song's music (by how far apart the two recordings sit), landing on its barline when it is that close to one."""
    shift = float((timing or {}).get('shift') or 0.0)
    lines = [float(b['start']) for b in (timing or {}).get('mine') or []] + [float(b['end']) for b in ((timing or {}).get('mine') or [])[-1:]]

    def move(seconds):
        if timing and 1e-6 < seconds < source_duration - 1e-3:
            bar = next((p for p in pairs if abs(seconds - p[0]) <= min(SNAP, (p[1] - p[0]) / 4)), None) \
                or next((p for p in pairs if p[0] <= seconds < p[1]), None)
            if bar is not None and flags.reshaped(bar[4], bar[6], timing):
                there = seconds + shift
                near = min(lines, key=lambda t: abs(t - there), default=None)
                if near is not None and abs(near - there) <= SNAP:
                    there = near
                return min(max(there, 0.0), float(target_duration))
        return map_time(pairs, seconds, source_duration, target_duration)
    return move


def _line_text(source, line):
    section = next((s for s in source.get('sections', []) if s.get('id') == line.get('section_id')), None)
    text = (section.get('lyrics') or '').split('\n') if section else []
    n = line.get('line')
    return text[n].strip() if isinstance(n, int) and 0 <= n < len(text) else ''


def _js_number(value):
    """A number written as the app's own code writes one into a fold's name (115.49, 120)."""
    text = repr(round(float(value), 6))
    return text[:-2] if text.endswith('.0') else text


def _join(first, second):
    first, second = (first or '').strip('\n'), (second or '').strip('\n')
    return first + ('\n' if first and second else '') + second


def _beat_near(pairs, seconds):
    """How long a beat is around this moment of the first song (its paired bar's length over its partner's beats)."""
    if not pairs:
        return .5
    bar = next((p for p in pairs if p[0] <= seconds < p[1]), pairs[0] if seconds < pairs[0][0] else pairs[-1])
    beats = bar[6] if isinstance(bar[6], (int, float)) and bar[6] > 0 else 4
    return (bar[1] - bar[0]) / beats


def bar_number_at(pairs, seconds):
    """The bar number Chord Buddy shows for the first song's bar at this moment, or None (bars hand it in as 'number')."""
    bar = next((p for p in pairs if p[0] - 1e-3 <= seconds < p[1]), None)
    return bar[7] if bar is not None else None


def shown_name(section, pairs):
    """A section as the person sees it on the chart: its name and the bar it starts on, never a moment they cannot see."""
    named = f'the section “{section["name"]}”'
    number = bar_number_at(pairs, section['start'])
    if number is None and pairs and section['start'] < pairs[0][0]:
        return f'{named} (just before bar {pairs[0][7]})' if pairs[0][7] is not None else f'{named} (at the very start)'
    return f'{named} (at bar {number})' if number is not None else f'{named} (at {_clock(section["start"])})'


def fold_slivers(sections, pairs):
    """The first song's sections with every one shorter than a beat joined to its neighbour: the one after it if it is at the start, else the
    one before. An analysis can leave such a sliver (a few hundredths of a second named "Instrumental" before the Intro, say); the chart does
    not draw it, so it is never copied or named. Returns (sections, a note if any words had to be moved, else '')."""
    out, carry, moved = [], None, 0
    for section in sections:
        section = dict(section)
        short = section['end'] - section['start'] < _beat_near(pairs, section['start']) * .999
        if short and out:
            out[-1]['end'] = section['end']
            if (section.get('lyrics') or '').strip():
                out[-1]['lyrics'] = _join(out[-1].get('lyrics'), section['lyrics'])
                moved += 1
            continue
        if short and not out:                            # at the very start: the next section begins here instead
            carry = section if carry is None else dict(carry, end=section['end'], lyrics=_join(carry.get('lyrics'), section.get('lyrics')))
            continue
        if carry is not None:
            section['start'] = carry['start']
            if (carry.get('lyrics') or '').strip():
                section['lyrics'] = _join(carry['lyrics'], section.get('lyrics'))
                moved += 1
            carry = None
        out.append(section)
    if carry is not None and not out:
        out.append(carry)
    note = (f'The words of {moved} very short section{"" if moved == 1 else "s"} (shorter than a beat, which the chart does not show) were joined '
            'to the section next to it.') if moved else ''
    return out, note


def _measure_time(by_id, measure_id, beat):
    m = by_id.get(measure_id)
    if m is None:
        return None
    points = list(m.get('beats') or [m['start']]) + [m['end']]
    x = max(0.0, float(beat or 0))
    i = min(int(x), len(points) - 2)
    return float(points[i] + (x - i) * (points[i + 1] - points[i]))


def _lines_of(content, measures):
    """Every lyric line of a chart (its words, and its place on the bars if it has one), in this song's time: [{text, line (the placement or
    None), time (its first word, or the line before it in its section), key (section id, line number), seq}]. Blank lines are left out."""
    by_id = {m['id']: m for m in measures}
    placed = {(p.get('section_id'), p.get('line')): p for p in (content.get('layout') or {}).get('lines', [])}
    items = []
    for section in content.get('sections', []):
        last = float(section['start'])
        for i, text in enumerate((section.get('lyrics') or '').split('\n')):
            if not text.strip():
                continue
            line, when = placed.get((section['id'], i)), None
            if line is not None:
                times = [_measure_time(by_id, w.get('measure_id'), w.get('beat')) for w in line.get('words', [])]
                times = [t for t in times if t is not None]
                when = min(times) if times else (by_id[line['start_measure']]['start'] if line.get('start_measure') in by_id else None)
            if when is None:
                line = None
            else:
                last = when
            items.append({'text': text, 'line': line, 'time': when if when is not None else last, 'key': (section['id'], i), 'seq': len(items)})
    return items


def _rehome(items, sections, layout, measures, keys):
    """Put lyric lines into the sections they land in (by when they are sung), each section's lines in the order they come. A placed line
    keeps its place only if all of it is inside its section; else it comes as words alone, and its words are returned (to be named).
    keys gets {(old section id, old line number): (new section id, new line number)}."""
    by_id, order = {m['id']: m for m in measures}, {m['id']: i for i, m in enumerate(measures)}
    homes, lost = {s['id']: [] for s in sections}, []
    for item in items:
        t = item['time']
        home = next((s for s in sections if s['start'] <= t < s['end']), sections[-1] if t >= sections[-1]['start'] else sections[0])
        line = item['line']
        if line is not None:
            inside = lambda mid: mid in by_id and by_id[mid]['end'] > home['start'] + 1e-6 and by_id[mid]['start'] < home['end'] - 1e-6
            words = line.get('words', [])
            times = [_measure_time(by_id, w.get('measure_id'), w.get('beat')) for w in words]
            fits = all(x is not None and home['start'] - 1e-7 <= x < home['end'] - 1e-7 for x in times)
            span = [line.get('start_measure'), line.get('end_measure')]
            if fits and not all(inside(m) for m in span) and words:
                mids = [w['measure_id'] for w in words]
                span = [min(mids, key=order.get), max(mids, key=order.get)]
            if fits and all(inside(m) for m in span):
                line = dict(copy.deepcopy(line), start_measure=span[0], end_measure=span[1])
            else:
                lost.append(item['text'].strip())
                line = None
        homes[home['id']].append((t, item['seq'], item['text'], line, item['key']))
    for section in sections:
        rows = sorted(homes[section['id']], key=lambda r: (r[0], r[1]))
        section['lyrics'] = '\n'.join(r[2] for r in rows)
        for i, row in enumerate(rows):
            keys[row[4]] = (section['id'], i)
            if row[3] is not None:
                layout['lines'].append(dict(row[3], section_id=section['id'], line=i))
    return lost


def _unplaced_note(named):
    one = len(named) == 1
    return (f'The lyric line{"" if one else "s"} {", ".join(named)} could not be placed on this song’s beats. '
            f'{"Its" if one else "Their"} words are copied into the section, but without timing, so {"it does" if one else "they do"} not show '
            f'over the bars or in the visuals until you place {"it" if one else "them"} on the Chart tab.')


def build(source, target, bars, target_music, level='full', timing=None, parts=PARTS):
    """The other song's chart with the first song's song structure, its lyrics, or both (parts). Returns (content, notes).

    Song structure alone: the first song's sections (and folded repeats and line breaks) with THIS song's own lyrics, each line moved into
    the section it is sung in. Lyrics alone: the first song's lyrics in this song's own sections, each line in the section it is sung in."""
    parts = tuple(p for p in PARTS if p in (parts or ()))
    if not parts:
        raise NotClose('nothing was chosen to copy')
    both, notes = _build_both(source, target, bars, target_music, level, timing)
    if parts == PARTS:
        return both, notes
    measures = (target_music or {}).get('measures', [])
    blank = {'bars_per_line': 4, 'breaks': [], 'bar_overrides': [], 'lines': []}
    keys = {}
    if parts == ('lyrics',):
        # this song's own sections, chords, folds and line breaks; the other song's lines, already moved onto this song's bars
        content = copy.deepcopy(target)
        for section in content['sections']:
            section['lyrics'] = ''
        layout = content['layout'] = dict(copy.deepcopy(target.get('layout') or blank), lines=[])
        for chord in content['chords']:
            chord.update(line=None, offset=None)               # (a chord typed in place in this song's own words: those words are replaced)
        lost = _rehome(_lines_of(both, measures), content['sections'], layout, measures, keys)
        notes = [n for n in notes if 'lyric' in n.lower()]
    else:
        # the other song's sections; this song's own lines moved into them, and its chords typed in place kept in their words
        content = copy.deepcopy(both)
        for section in content['sections']:
            section['lyrics'] = ''
        layout = content['layout'] = dict(copy.deepcopy(both.get('layout') or blank), lines=[])
        lost = _rehome(_lines_of(target, measures), content['sections'], layout, measures, keys)
        own = {c['id']: c for c in target['chords']}
        for chord in content['chords']:
            was = own.get(chord['id'])
            if was and was.get('line') is not None:
                new = keys.get((was.get('section_id'), was['line']))
                if new and new[0] == chord['section_id'] and layout and any(p['section_id'] == new[0] and p['line'] == new[1] for p in layout['lines']):
                    chord.update(line=new[1], offset=was.get('offset'))
        notes = [n for n in notes if 'lyric' not in n.lower() and not n.startswith('The words of')]
    if lost:
        notes.append(_unplaced_note([f'“{t}”' for t in lost]))
    return content, notes


def _build_both(source, target, bars, target_music, level='full', timing=None):
    """The other song's chart with the first song's structure and lyrics. Returns (content, notes): notes say what was not brought.
    level: 'full' (everything), 'lines' (not the folded repeats), 'text' (the words, but not their places on the bars).
    timing (the beat times of both songs' bars, as for the flags): where the two analyses cut a stretch into bars differently, section edges,
    folds and words there go by their moment in the music instead of by bar number."""
    pairs = _pairs(bars)
    if not pairs:
        raise NotClose('the two songs’ bars could not be matched')
    partner = {p[4]: p for p in pairs}
    source_duration, duration = float(source['duration']), float(target['duration'])
    move = mover(pairs, timing, source_duration, duration)
    notes = []

    # ---- sections: the same names and words, beginning and ending on the same bars
    whole, joined = fold_slivers(source['sections'], pairs)
    if joined:
        notes.append(joined)
    sections, previous, carry = [], 0.0, None
    for section in whole:
        start, end = move(section['start']), move(section['end'])
        if start is None or end is None:
            raise NotClose(f'{shown_name(section, pairs)} begins or ends on a bar this song does not have')
        start, end = max(start, previous), min(end, duration)
        if not start < end:                             # nothing of it is left in this song: it joins its neighbour, as a sliver does
            if sections:
                sections[-1]['end'] = max(sections[-1]['end'], end)
                sections[-1]['lyrics'] = _join(sections[-1]['lyrics'], section.get('lyrics'))
            else:
                carry = _join(carry, section.get('lyrics'))
            continue
        lyrics = section.get('lyrics') or ''
        if not sections and carry is not None:          # the first one was left out: this one starts the song, with its words
            start, lyrics = 0.0, _join(carry, lyrics)
        sections.append({'id': section['id'], 'name': section['name'], 'start': start, 'end': end, 'lyrics': lyrics})
        previous = end
    if not sections:
        raise NotClose('none of the other song’s sections would have any bars in this song')

    # ---- this song's own chords, each filed under the section it now starts in
    chords = []
    for chord in target['chords']:
        home = next((s for s in sections if s['start'] <= chord['start'] < s['end']), None)
        if home is None:
            raise NotClose(f'a chord at {_clock(chord["start"])} would fall outside every section')
        moved = {k: v for k, v in chord.items() if k not in ('line', 'offset')}
        chords.append(dict(moved, section_id=home['id'], line=None, offset=None))

    content = {k: copy.deepcopy(v) for k, v in target.items() if k not in ('sections', 'chords', 'layout')}
    content.update(sections=sections, chords=chords)
    own = target.get('layout') if isinstance(target.get('layout'), dict) else None
    theirs = source.get('layout') if isinstance(source.get('layout'), dict) else None
    if theirs is None and own is None:
        return content, notes
    layout = {'bars_per_line': (theirs or own).get('bars_per_line', 4), 'breaks': [], 'bar_overrides': copy.deepcopy((own or {}).get('bar_overrides', [])), 'lines': []}
    if theirs and theirs.get('bar_overrides'):
        notes.append('Barlines moved by hand in the other song were not copied: this song keeps its own bars.')
    if theirs and level in ('full', 'lines'):
        layout['breaks'] = list(dict.fromkeys(partner[m][5] for m in theirs.get('breaks', []) if m in partner))
        order = {m['id']: i for i, m in enumerate((target_music or {}).get('measures', []))}
        lost = []
        for line in theirs.get('lines', []):
            first, last = partner.get(line.get('start_measure')), partner.get(line.get('end_measure'))
            words, fits = [], True
            for word in line.get('words', []):
                bar, beat = partner.get(word.get('measure_id')), word.get('beat', 0)
                if bar is not None and not (isinstance(bar[6], (int, float)) and beat >= bar[6]) and not flags.reshaped(bar[4], bar[6], timing):
                    words.append(dict(word, measure_id=bar[5]))
                    continue
                # its bar is cut differently here (or has no partner): the word goes to the same moment of the music, as a flag does
                seconds = _theirs_at(timing, word.get('measure_id'), beat)
                found, where = flags._place(seconds + float(timing.get('shift') or 0.0), timing) if seconds is not None else ('late', None)
                if found != 'ok' or where['measure'] not in order:
                    fits = False
                    break
                words.append(dict(word, measure_id=where['measure'], beat=where['beat']['n'] / where['beat']['d']))
            ends = [p[5] for p in (first, last) if p is not None] + [w['measure_id'] for w in words]
            ends = [m for m in ends if m in order] if order else ends
            if fits and ends and (order or (first is not None and last is not None)):
                start, end = (min(ends, key=order.get), max(ends, key=order.get)) if order else (first[5], last[5])
                layout['lines'].append(dict(copy.deepcopy(line), start_measure=start, end_measure=end, words=words))
            else:
                lost.append(line)
        if lost:
            named = []
            for line in lost:
                text, bar = _line_text(source, line), partner.get(line.get('start_measure'))
                where = f' (bar {bar[7]})' if bar is not None and bar[7] is not None else ''
                named.append(f'“{text}”{where}' if text else f'one line{where}')
            notes.append(_unplaced_note(named))
    elif theirs and theirs.get('lines'):
        notes.append('The lyrics came across as words only: their places on the bars did not fit this song, so they will need placing.')
    if theirs and level == 'full' and isinstance(theirs.get('compact'), dict):
        measures = (target_music or {}).get('measures', [])
        groups = []
        for group in theirs['compact'].get('groups', []):
            passes = []
            for one in group.get('passes', []):
                a, b = move(one['start']), move(one['end'])
                if a is None or b is None or not a < b:
                    passes = None
                    break
                passes.append(dict(copy.deepcopy(one), start=a, end=b, measure_ids=[m['id'] for m in measures if m['start'] < b and m['end'] > a],
                                   chord_ids=[c['id'] for c in chords if c['start'] < b and c['end'] > a]))
            if passes:
                groups.append(dict(copy.deepcopy(group), id=str(group['id']).split('@')[0] + '@' + _js_number(passes[0]['start']), passes=passes))
        layout['compact'] = dict({k: copy.deepcopy(v) for k, v in theirs['compact'].items() if k != 'groups'}, groups=groups)
    elif theirs and isinstance(theirs.get('compact'), dict) and theirs['compact'].get('groups'):
        notes.append('Which repeats are shown folded was not copied: it did not fit this song’s chords. Chord Buddy folds them its usual way.')
    content['layout'] = layout
    return content, notes


def _chart(documents, song_id):
    item = next((d for d in documents.for_song(song_id) if d['kind'] == 'chart'), None)
    if item is None:
        raise NotClose('one of the two songs has no chart. Analyze it in Chord Buddy first')
    return documents.get(item['id'])


def plan(documents, source_song, target_song, bars, timing=None, parts=PARTS):
    """Whether the first song's structure and lyrics can go onto the other, and what would come across, without saving:
    {ok, reason, sections: [names], lyric_lines, placed_lines, words, folds, replaces: this song's own lyric lines that would be replaced,
    notes, level}. The richest version that Chord Buddy's own chart rules accept is the one offered."""
    parts = tuple(p for p in PARTS if p in (parts or PARTS))
    result = {'ok': False, 'reason': '', 'sections': [], 'lyric_lines': 0, 'placed_lines': 0, 'words': 0, 'folds': 0, 'replaces': 0, 'notes': [], 'level': None,
              'parts': list(parts), 'own_lines': 0}
    try:
        source, target = _chart(documents, source_song), _chart(documents, target_song)
    except NotClose as exc:
        return dict(result, reason=str(exc).rstrip('.') + '.')
    theirs, mine = source['content'], target['content']
    count_lines = lambda content: sum(1 for s in content.get('sections', []) for line in (s.get('lyrics') or '').split('\n') if line.strip())
    result['own_lines'] = count_lines(mine)
    result['replaces'] = result['own_lines'] if 'lyrics' in parts else 0
    refused = ''
    for level in LEVELS:
        try:
            content, notes = build(theirs, mine, bars, target['music'], level, timing, parts)
            checked = validate_chart(content, mine['duration'], target['music'])
        except NotClose as exc:
            return dict(result, reason=f'Not close enough to copy the sections and lyrics: {exc}.')
        except (ValueError, KeyError, TypeError) as exc:
            refused = str(exc)
            continue
        layout = checked.get('layout') or {}
        result.update(ok=True, level=level, notes=notes, sections=[s['name'] for s in checked['sections']], lyric_lines=count_lines(checked),
                      placed_lines=len(layout.get('lines', [])), words=sum(len(line.get('words', [])) for line in layout.get('lines', [])),
                      folds=len((layout.get('compact') or {}).get('groups', [])), content=checked, chart=target, source_title=None)
        if checked['sections'] == mine.get('sections') and (checked.get('layout') or {}) == (mine.get('layout') or {}):
            return dict({k: v for k, v in result.items() if k not in ('content', 'chart')}, ok=False, reason=f'This song already has the same {PART_WORDS[parts]}.')
        return result
    return dict(result, reason=f'Not close enough to copy the sections and lyrics: Chord Buddy’s chart rules do not accept the result ({refused}).')


def apply(documents, source_song, target_song, bars, like=None, timing=None, parts=PARTS):
    """Save it: one new step in the other song's chart history. Returns the plan (without the chart itself), with 'saved': True."""
    planned = plan(documents, source_song, target_song, bars, timing, parts)
    if not planned['ok']:
        raise NotClose(planned['reason'])
    chart = planned['chart']
    what = PART_WORDS[tuple(planned['parts'])]
    documents.save(chart['id'], planned['content'], f'Copy {what} from ' + (f'“{like}”' if like else 'the other version'), chart['revision'])
    return dict(public(planned), saved=True)


def public(planned):
    return {k: v for k, v in planned.items() if k not in ('content', 'chart', 'source_title')}


def words(planned):
    """One sentence saying what would come across."""
    names, chosen = planned['sections'], planned.get('parts') or list(PARTS)
    parts = []
    if 'structure' in chosen:
        parts.append(f'{len(names)} section{"" if len(names) == 1 else "s"} ({", ".join(dict.fromkeys(names))})')
    if 'lyrics' in chosen and planned['lyric_lines']:
        placed, n = planned['placed_lines'], planned['lyric_lines']
        parts.append(f'{n} lyric line{"" if n == 1 else "s"}' + ('' if placed == n else f' ({placed} placed on the beats)' if placed else ' (not placed on the beats)'))
    elif 'lyrics' in chosen:
        parts.append('no lyrics (it has none)')
    if 'structure' in chosen and planned['folds']:
        parts.append('the folded repeats')
    if not parts:
        return 'nothing'
    return ', '.join(parts[:-1]) + ' and ' + parts[-1] if len(parts) > 1 else parts[0]
