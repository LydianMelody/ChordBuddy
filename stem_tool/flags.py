"""Copy an arrangement (the action flags and loops set up on the Perform tab) from one song to another.

For two songs that are the same music (one is a transposed or re-recorded version of the other): everything set up for the first can be had on
the second, each flag on the same bar and beat. The copy is a NEW arrangement on the other song. The original, and anything the other song
already has, is left exactly as it is, and the app's own PerformanceStore does the saving, so its rules decide what is stored.

A flag's place is a bar (a measure's id) and a beat in it. The two songs' bars are matched in the window, by the bar numbers Chord Buddy shows
(its own chart code works those out), and handed to this module as `bars`: {the first song's measure id: {'id': the other song's measure id,
'beats': how many beats that bar has}}.

Two analyses can cut the same stretch of music into bars differently, most often a pickup: one hears a 5-beat bar 0 where the other hears a
1-beat bar and a 2-beat bar. A flag on beat 2 of the first has no beat 2 in its partner, yet its moment is in the song. So, given `timing` (the
beat times of both songs' bars, and how far apart the two recordings sit), a flag that does not fit its partner bar is placed by its MOMENT in
the music instead: the bar of this song that holds that moment, on the beat it falls on. A moment before this song's first bar goes on the
first bar's first beat. A moment after this song's last bar is no place for most flags, but a MIDI flag is kept, at the end of the last bar:
it may be setting up a pedal for the next song.
"""
from __future__ import annotations

import copy

PLACES = ('at', 'start', 'end', 'to', 'from')          # the fields that say where something is


def is_address(value):
    return isinstance(value, dict) and isinstance(value.get('measure'), str) and isinstance(value.get('beat'), dict)


def _beat(address):
    beat = address['beat']
    try:
        return beat['n'] / beat['d']
    except (KeyError, TypeError, ZeroDivisionError):
        return 0.0


LATE = '__after_the_song__'   # (a mark, inside remap only, on a MIDI flag that lands after the song, until its place in the last bar is settled)
SNAP = 64                     # a flag moved by its moment lands on the nearest 64th of a beat, as the Perform tab places them


def _fits(address, partner, closing=False):
    beats = partner.get('beats')
    return not (isinstance(beats, (int, float)) and (_beat(address) > beats if closing else _beat(address) >= beats) and _beat(address) > 0)


def _move(address, bars, closing=False):
    """An address on the other song's bar, or None if it has no place there. closing: a loop's end may sit on the bar's very last line."""
    partner = bars.get(address['measure'])
    if not isinstance(partner, dict) or not isinstance(partner.get('id'), str) or not _fits(address, partner, closing):
        return None
    return dict(copy.deepcopy(address), measure=partner['id'])


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def reshaped(measure, partner_beats, timing):
    """Whether the two analyses cut this bar differently: it and its partner have different numbers of beats (a 2-beat bar 58 and a 4-beat
    bar 59 in one song, a 4-beat bar 58 and a 2-beat bar 59 in the other). Its bar NUMBER then means another moment in each song, so anything
    on it goes by its moment in the music instead, even a beat its partner has."""
    bar = (timing or {}).get('theirs', {}).get(measure)
    return isinstance(bar, dict) and bool(bar.get('beats')) and _number(partner_beats) and len(bar['beats']) != partner_beats


def moment(address, timing):
    """When this address is in the music of the song it comes from (seconds), or None. timing['theirs'][measure] = {'beats': [beat times],
    'end': when the bar ends}: a beat past the last is counted on at the bar's last beat length."""
    bar = (timing or {}).get('theirs', {}).get(address['measure'])
    if not isinstance(bar, dict) or not bar.get('beats') or not _number(bar.get('end')):
        return None
    times = [float(t) for t in bar['beats']] + [float(bar['end'])]
    x = max(0.0, _beat(address))
    i = min(int(x), len(times) - 2)
    return times[i] + (x - i) * (times[i + 1] - times[i])


def _place(seconds, timing, closing=False):
    """The address in THIS song's bars of a moment of its music (seconds, in this song's time). ('late', None) after its last bar; else
    ('ok', address). Before its first bar: the first bar's first beat."""
    mine = (timing or {}).get('mine') or []
    if not mine:
        return 'late', None
    first, last = mine[0], mine[-1]
    if seconds < float(first['start']):
        return 'ok', {'measure': first['id'], 'beat': {'n': 0, 'd': SNAP}}
    if seconds >= float(last['end']) - 1e-3:
        if closing and seconds <= float(last['end']) + 1e-3:
            return 'ok', {'measure': last['id'], 'beat': {'n': len(last['beats']) * SNAP, 'd': SNAP}}
        return 'late', None
    bar = next(b for b in reversed(mine) if float(b['start']) <= seconds + 1e-9)
    times = [float(t) for t in bar['beats']] + [float(bar['end'])]
    j = max([k for k in range(len(times) - 1) if times[k] <= seconds + 1e-9], default=0)
    span = max(1e-6, times[j + 1] - times[j])
    n = round((j + min(1.0, max(0.0, (seconds - times[j]) / span))) * SNAP)
    n = min(n, len(bar['beats']) * SNAP - (0 if closing else 1))      # never past the bar's last line
    return 'ok', {'measure': bar['id'], 'beat': {'n': int(n), 'd': SNAP}}


LANES = (('track.', 'Mixer'), ('master.', 'Mixer'), ('mix.', 'Mixer'), ('command', 'Playback'), ('monitor.', 'Playback'), ('rate.', 'Playback'),
         ('visual.', 'Visuals'), ('midi.', 'MIDI'))


def lane(action):
    """The kind of flag, by the names on the Perform tab's flag key: Mixer, Playback, Visuals, MIDI or Notes."""
    kind = str((action or {}).get('type') or '')
    return next((name for prefix, name in LANES if kind.startswith(prefix)), 'Notes')


def is_midi(item):
    return isinstance(item, dict) and isinstance(item.get('action'), dict) and str(item['action'].get('type') or '').startswith('midi.')


def describe(item, timing=None):
    """A dropped thing, for saying which it was: {'what': 'the MIDI flag (Helix preset 63)', 'bar', 'beat', 'seconds'} (any may be None)."""
    if not isinstance(item, dict):
        return {'what': 'something', 'bar': None, 'beat': None, 'seconds': None}
    if 'action' in item and is_address(item.get('at')):
        action = item['action'] or {}
        extra = ''
        if action.get('type') == 'midi.helix' and action.get('preset') is not None:
            extra = f' (Helix preset {action["preset"]})'
        what, where = f'the {lane(action)} flag{extra}', item['at']
    elif is_address(item.get('start')):
        what, where = 'the loop', item['start']
    elif is_address(item.get('from')):
        what, where = 'the jump', item['from']
    else:
        where = next((item[k] for k in PLACES if is_address(item.get(k))), None)
        what = 'the hold' if where is not None else 'something'
    bar = beat = seconds = None
    if where is not None:
        info = (timing or {}).get('theirs', {}).get(where['measure']) or {}
        bar = info.get('number')
        beat = int(_beat(where)) + 1
        seconds = moment(where, timing)
    return {'what': what, 'bar': bar, 'beat': beat, 'seconds': seconds}


def remap(value, bars, timing=None, report=None):
    """A copy of this part of an arrangement with every place moved to the other song's bars. Returns (copy, how many things were left out).
    Something whose own place has no partner is dropped whole (a flag, a loop with its passes, a jump); what it holds goes with it.
    timing (see the module's notes): places that do not fit their partner bar are found by their moment in the music instead. report: a dict
    that gets 'dropped' (describe() of each thing left out) and 'to_last' (MIDI flags put at the end of the last bar)."""
    left_out = 0
    report = report if report is not None else {}
    report.setdefault('dropped', [])
    report.setdefault('to_last', [])
    shift = float((timing or {}).get('shift') or 0.0)

    def place(address, closing, holder):
        moved = _move(address, bars, closing)
        if not timing:
            return moved
        if moved is not None and not reshaped(address['measure'], (bars.get(address['measure']) or {}).get('beats'), timing):
            return moved
        seconds = moment(address, timing)
        if seconds is None:
            return None
        found, where = _place(seconds + shift, timing, closing)
        if found == 'ok':
            return dict(copy.deepcopy(address), **where)
        if is_midi(holder) and not closing:               # after the song: a MIDI flag still goes, at the end of the last bar
            report['to_last'].append(seconds)
            return {LATE: seconds}
        return None

    def walk(item):
        nonlocal left_out
        if isinstance(item, list):
            out = []
            for child in item:
                moved = walk(child)
                if moved is _GONE:
                    left_out += 1
                    report['dropped'].append(describe(child, timing))
                else:
                    out.append(moved)
            return out
        if isinstance(item, dict):
            out = {}
            for key, child in item.items():
                if key in PLACES and is_address(child):
                    moved = place(child, key == 'end', item)
                    if moved is None:
                        return _GONE
                    out[key] = moved
                else:
                    moved = walk(child)
                    if moved is _GONE:                   # a single thing inside (not one of a list) that cannot move takes its holder with it
                        return _GONE
                    out[key] = moved
            return out
        return copy.deepcopy(item)

    result = walk(value)
    _settle_late(result, report, timing)
    return (None if result is _GONE else result), left_out


def _settle_late(result, report, timing):
    """The MIDI flags that would land after the song, at the end of its last bar: on its last beat, a 64th of a beat apart, in the order they
    had in the music, so they are still sent in that order."""
    late = [cue for cue in _cues(result) if isinstance(cue.get('at'), dict) and LATE in cue['at']]
    if not late:
        return
    last = ((timing or {}).get('mine') or [{}])[-1]
    beats = max(1, len(last.get('beats') or [0]))
    late.sort(key=lambda cue: cue['at'][LATE])
    for k, cue in enumerate(late):
        cue['at'] = {'measure': last.get('id'), 'beat': {'n': (beats - 1) * SNAP + min(k, SNAP - 1), 'd': SNAP}}


def _cues(value):
    if isinstance(value, list):
        for v in value:
            yield from _cues(v)
    elif isinstance(value, dict):
        if 'action' in value and 'at' in value:
            yield value
        for v in value.values():
            yield from _cues(v)


_GONE = object()


def count(body):
    """How much there is to copy: {'flags', 'loops', 'jumps', 'holds'} (flags include the ones set for single passes of a loop)."""
    def cues(value):
        if isinstance(value, list):
            return sum(cues(v) for v in value)
        if isinstance(value, dict):
            own = 1 if is_address(value.get('at')) and 'action' in value else 0
            return own + sum(cues(v) for v in value.values())
        return 0
    return {'flags': cues(body.get('cues')) + cues(body.get('regions')), 'loops': len(body.get('regions') or []),
            'jumps': len(body.get('jumps') or []), 'holds': len(body.get('holds') or [])}


def plan(store, performance_id, target_song, bars, name=None, timing=None):
    """What copying this arrangement to that song would make, without saving it: {name, from, have, copied, left_out, body, dropped, to_last}.
    dropped: what could not be copied (describe()); to_last: how many MIDI flags were put at the end of the last bar."""
    record = store.performance(performance_id)
    source = record['draft'] or record['body']               # as it is now, unsaved work included: what a show would play
    if source.get('songId') == target_song:
        raise ValueError('That arrangement already belongs to this song. Use Duplicate on the Perform tab instead.')
    if not isinstance(bars, dict) or not bars:
        raise ValueError('The two songs’ bars could not be matched. Both need a chart: analyze them in Chord Buddy first.')
    body = copy.deepcopy(source)
    left_out, report = 0, {'dropped': [], 'to_last': []}
    for key in ('cues', 'regions', 'jumps', 'holds'):
        body[key], dropped = remap(source.get(key) or [], bars, timing, report)
        left_out += dropped
    name = (name or '').strip() if isinstance(name, str) else ''
    body.update(id=store.new_id(), songId=target_song, name=name or record['name'], grid=None)
    return {'name': body['name'], 'from': record['name'], 'have': count(source), 'copied': count(body), 'left_out': left_out, 'body': body,
            'dropped': report['dropped'], 'to_last': len(report['to_last'])}


def clock(seconds):
    return f'{int(seconds // 60)}:{int(seconds % 60):02d}'


def left_out_words(planned):
    """What could not be copied, and the MIDI flags put at the end, in a sentence or two: names each thing and where it was."""
    words, things = [], []
    for item in planned.get('dropped') or []:
        where = []
        if item.get('bar') is not None:
            where.append(f'bar {item["bar"]}' + (f', beat {item["beat"]}' if item.get('beat') else ''))
        if item.get('seconds') is not None:
            where.append(f'({clock(item["seconds"])})' if where else clock(item['seconds']))
        things.append(item['what'] + (' at ' + ' '.join(where) if where else ''))
    if things:
        words.append(f'{len(things)} could not be copied, because {"its" if len(things) == 1 else "their"} place in the music is not in this song: '
                     + '; '.join(things) + '.')
    late = planned.get('to_last') or 0
    if late:
        words.append(f'{late} MIDI flag{" was" if late == 1 else "s were"} after the end of this song, so {"it goes" if late == 1 else "they go"} at the end of its last bar '
                     '(in case it sets something up for the next song).')
    return ' '.join(words)


def apply(store, performance_id, target_song, bars, name=None, grid=None, timing=None):
    """Save the copy as a new arrangement of the other song. grid: that song's bar fingerprint, as the Perform tab stamps arrangements."""
    planned = plan(store, performance_id, target_song, bars, name, timing)
    taken = {p['name'].casefold() for p in store.performances_for_song(target_song)}
    base, number = planned['name'], 2
    while planned['name'].casefold() in taken:               # never the same name twice on one song: the menu would show two alike
        planned['name'] = f'{base} ({number})'
        number += 1
    planned['body']['name'] = planned['name']
    if isinstance(grid, str) and grid:
        planned['body']['grid'] = grid
    saved = store.save_performance(planned['body'], 0)
    planned['id'] = saved['id']
    return planned


USE_OFFSET_FROM = .5          # how clearly the two recordings must match before their measured start difference is trusted
NO_OFFSET_UNDER = .03         # seconds: closer than this, they start together


def recordings_offset(source_audio, target_audio):
    """How much later the same moment is in the target recording than in the source, found by listening to both (their loudness over time,
    so a lowered or instrumental version still matches): {offset (seconds), confidence, used, words}. When they do not clearly match, the
    offset is 0 (they are taken to start together) and `words` says so."""
    from . import engine
    found = engine.find_offset(source_audio, target_audio)
    seconds = found['offset'] / engine.RATE
    if found['confidence'] < USE_OFFSET_FROM:
        return {'offset': 0.0, 'confidence': found['confidence'], 'used': False,
                'words': 'The two recordings could not be told apart clearly by ear, so they are taken to start at the same moment. Check a flag or two after copying.'}
    if abs(seconds) < NO_OFFSET_UNDER:
        return {'offset': 0.0, 'confidence': found['confidence'], 'used': True, 'words': ''}
    return {'offset': round(seconds, 4), 'confidence': found['confidence'], 'used': True,
            'words': f'This recording starts {abs(seconds):.2f} s {"later" if seconds > 0 else "sooner"} than the other, and that is allowed for.'}


def count_bars_from(documents, song_id, seconds, like=None):
    """Make a song's bar 1 the bar that holds `seconds` (song time), as another version of it has it.

    Chord Buddy counts bar 1 from the first chord in the chart. An analysis can hear a chord in a fade-in, before the music proper, and so start
    counting a bar or two sooner than another analysis of the same music. Every chord that starts before `seconds` becomes a rest ("N", the
    chart's own no-chord mark), which the chart hides and does not count from. It is ONE new step in the chart's history, so Undo in Chord
    Buddy takes it back; the chords themselves are still in that history. Returns {'changed': how many, 'chords': their names}."""
    chart = next((d for d in documents.for_song(song_id) if d['kind'] == 'chart'), None)
    if chart is None:
        raise ValueError('This song has no chart. Analyze it in Chord Buddy first.')
    full = documents.get(chart['id'])
    content = full['content']
    changed, chords = [], []
    for chord in content.get('chords', []):
        label = chord.get('label')
        early = isinstance(chord.get('start'), (int, float)) and chord['start'] < float(seconds)
        if early and isinstance(label, str) and label[:1] in 'ABCDEFG' and label[:1]:
            changed.append(label)
            chords.append(dict(chord, label='N'))
        else:
            chords.append(chord)
    if changed:
        documents.save(full['id'], dict(content, chords=chords), 'Count bars like ' + (f'“{like}”' if like else 'the other version'), full['revision'])
    return {'changed': len(changed), 'chords': sorted(set(changed))}


def public(planned):
    return {k: v for k, v in planned.items() if k != 'body'}
