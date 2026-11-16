"""What the Replace a Stem window does, with no window in it: each button is one method, and state() is everything the window shows.

The page (page.html) calls these through the window's bridge, one at a time; each returns state() so the page simply draws what it gets.
The page shows the new audio as a shape on the song's own bars and beats, and the person slides it about: move() is quick (it only notes the new
place), level() is the slow, careful check of the level, and nothing is written to the library until replace() or restore().
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from chordbuddy.documents import DocumentStore

from chordbuddy.performance_store import PerformanceStore

from . import engine, flags, structure, transpose
from .engine import RATE, STEM_WORDS, StemError

PLAY_SECONDS = 45            # a preview that isn't looping plays this long
START_VOLUME = 25            # percent: previews start quiet on purpose


def clock(seconds):
    return f'{int(seconds // 60)}:{int(seconds % 60):02d}'


class Controller:
    def __init__(self, workspace, player=None):
        self.space = workspace
        self.player = player                      # the sounddevice module (or a stand-in); found on first use
        self.lock = threading.RLock()             # the page asks one thing at a time, but a slow answer must not overlap the next
        self.song_id = None
        self.role = 'vocals'
        self.new = None                           # the chosen file, decoded
        self.file = None
        self.offset = 0                           # frames: where the file's first sample sits in the song
        self.trim = 0.0
        self.gain_db = 0.0                        # the level in use for previews: the quick match until level() has checked it
        self.found = None
        self.plan = None                          # engine.plan_level's answer for the current place and trim; None while it is out of date
        self.messages = []

    # ------------------------------------------------------------ what the window shows
    def say(self, text):
        self.messages.append(str(text).strip())

    def state(self):
        songs = self.space.songs()
        song = next((s for s in songs if s['id'] == self.song_id), None)
        backup = False
        if song:
            try:
                backup = self.space.backup(song['id'], self.role) is not None
            except (KeyError, ValueError, OSError):
                backup = False
        p, f = self.plan, self.found
        try:
            prefs = self.space.library.read_prefs()
        except Exception:
            prefs = {}
        return {
            'songs': [{**s, 'length': clock(s['seconds']), 'replaced': [STEM_WORDS[r] for r in s['replaced']]} for s in songs],
            'stems': [{'id': r, 'name': STEM_WORDS[r]} for r in engine.STEMS],
            'song': song['id'] if song else None, 'title': song['title'] if song else '', 'seconds': song['seconds'] if song else 0,
            'role': self.role, 'role_name': STEM_WORDS[self.role],
            'file': self.file.name if self.file else None, 'file_seconds': len(self.new) / RATE if self.new is not None else 0,
            'offset': self.offset / RATE, 'suggested': f['offset'] / RATE if f else None,
            'confidence': f['confidence'] if f else None, 'drift_ms': f['drift_ms'] if f else None,
            'drift_warning': bool(f and abs(f['drift_ms']) > engine.DRIFT_WARN_MS),
            'gain_db': round(self.gain_db, 1), 'trim_db': self.trim, 'trim_range': list(engine.TRIM_RANGE_DB),
            'matched_db': p['matched_db'] if p else None, 'level_checked': p is not None, 'notes': list(p['notes']) if p else [],
            'can_replace': bool(song and self.new is not None), 'can_restore': backup, 'can_play': bool(song),
            'start_volume': START_VOLUME, 'theme': prefs.get('cb-theme') or 'plum', 'scheme': prefs.get('cb-scheme') or 'light',
            'messages': self.messages[-40:],
        }

    def _guard(self, label, work):
        """Run one button's work. A problem a person can fix is said in its own words; anything else is shown, never swallowed."""
        with self.lock:
            try:
                work()
            except StemError as exc:
                self.say(str(exc))
            except KeyError as exc:
                self.say(str(exc).strip('"\''))
            except Exception as exc:
                self.say(f'{label} did not work. {type(exc).__name__}: {exc}')
            return self.state()

    # ------------------------------------------------------------ the timeline's pictures
    def timeline(self):
        """What the page draws: the song's chart (for its bars, beats and sections, read by the app's own chart code in the page) and the outlines
        of the stem being replaced, of the whole song, and of the new audio. Outlines are PEAKS_PER_SECOND numbers a second, from 0 to 1."""
        with self.lock:
            if not self.song_id:
                return {'chart': None, 'waves': {}, 'per_second': engine.PEAKS_PER_SECOND}
            waves = {'now': engine.peaks(self.space.stem(self.song_id, self.role)), 'song': engine.peaks(self.space.stem(self.song_id, 'original'))}
            if self.new is not None:
                waves['new'] = engine.peaks(self.new)
            return {'chart': self._chart(self.song_id), 'waves': waves, 'per_second': engine.PEAKS_PER_SECOND}

    def _documents(self):
        if getattr(self, 'documents', None) is None:
            self.documents = DocumentStore(self.space.library)
        return self.documents

    def _chart(self, song_id):
        """The song's chart as the app stores it ({content, music}), or None when it has none (then the page draws seconds instead of bars)."""
        try:
            documents = self._documents()
            chart = next((d for d in documents.for_song(song_id) if d['kind'] == 'chart'), None)
            if not chart:
                return None
            full = documents.get(chart['id'])
            return {'content': full['content'], 'music': full['music']}
        except Exception:
            return None

    # ------------------------------------------------------------ choosing
    def select(self, song_id, role=None):
        def work():
            self.stop()
            if role and role not in engine.STEMS:
                raise StemError('Choose which stem to replace.')
            self.space.active(song_id)                       # says so if the song has no stems
            self.song_id, self.role = song_id, role or self.role
            self.found = self.plan = None
            if self.new is not None:
                self._line_up()
        return self._guard('Choosing the song', work)

    def load(self, path):
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            self.stop()
            path_ = Path(path)
            self.new = engine.decode(self.space.project / 'tools' / 'ffmpeg.exe', path_)
            self.file = path_
            self.say(f'Read {path_.name}: {clock(len(self.new) / RATE)} of audio.')
            self._line_up()
        return self._guard('Reading the file', work)

    def use_audio(self, audio, name):
        """The same as load(), for audio already in memory (tests)."""
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            self.new, self.file = engine.check_audio(audio), Path(name)
            self._line_up()
        return self._guard('Reading the file', work)

    def _line_up(self):
        old = self.space.stem(self.song_id, self.role)
        found = engine.find_offset(self.new, old)
        if found['confidence'] < .35:                        # nothing like the old stem (it may be silent): try against the whole recording
            again = engine.find_offset(self.new, self.space.stem(self.song_id, 'original'))
            if again['confidence'] > found['confidence']:
                found = again
        self.found, self.offset, self.trim, self.plan = found, found['offset'], 0.0, None
        self.gain_db = engine.quick_gain_db(old, self.new)
        self.say(found['words'])

    def move(self, offset_seconds):
        """The new audio was slid to here (seconds into the song where the file's start sits). Quick: the level is checked later, by level()."""
        def work():
            if self.new is None or not self.song_id:
                raise StemError('Choose a song and a file first.')
            _, manifest = self.space.active(self.song_id)
            offset = int(round(float(offset_seconds) * RATE))
            if offset >= manifest['frames'] or offset + len(self.new) <= 0:
                raise StemError('That would put the new audio wholly outside the song.')
            self.offset, self.plan = offset, None
        return self._guard('Moving the audio', work)

    def level(self, trim_db=None):
        """Check the level where the audio sits now (slow: it measures the whole song). trim_db: louder or quieter than the matched level, by hand."""
        def work():
            if self.new is None or not self.song_id:
                raise StemError('Choose a song and a file first.')
            if trim_db is not None:
                self.trim = float(trim_db)
            self._plan()
        return self._guard('Checking the level', work)

    def _plan(self):
        root, manifest = self.space.active(self.song_id)
        placed = engine.place(self.new, manifest['frames'], self.offset)
        self.plan = engine.plan_level(root, manifest, self.role, placed, self.trim, self.space.own_stem(self.song_id, self.role))
        self.trim, self.gain_db = self.plan['trim_db'], self.plan['gain_db']
        for note in self.plan['notes']:
            self.say(note)
        return placed

    # ------------------------------------------------------------ listening
    def _sound(self):
        if self.player is None:
            import sounddevice
            self.player = sounddevice
        return self.player

    def play(self, what, position=0.0, volume=START_VOLUME, loop_seconds=None):
        """what: 'new' (the song with the new stem), 'now' (the song as it is), 'solo' (the new stem alone). From `position` seconds: once through
        PLAY_SECONDS, or round and round `loop_seconds` of it. The answer's 'played' says how much will play, for the page's playhead."""
        played = {}

        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            if what != 'now' and self.new is None:
                raise StemError('Choose a file first.')
            root, manifest = self.space.active(self.song_id)
            start = max(0, min(manifest['frames'] - RATE // 2, int(float(position) * RATE)))
            length = float(loop_seconds) if loop_seconds else PLAY_SECONDS
            count = max(RATE // 4, min(manifest['frames'] - start, int(length * RATE)))
            common = self.plan['common_gain'] if self.plan else manifest['common_gain']
            if what == 'now':
                heard = engine.preview(root, manifest, self.role, self.space.stem(self.song_id, self.role), start, count / RATE)
            else:
                if self.plan and self.plan.get('stem') is not None:          # the checked stem itself, peaks eased as they will be saved
                    part = np.zeros((count, 2), dtype=np.float32)
                    piece = self.plan['stem'][start:start + count]
                    part[:len(piece)] = piece
                else:
                    part = engine.place_part(self.new, self.offset, start, count) * np.float32(engine.gain_of(self.gain_db))
                if what == 'solo':
                    heard = part * np.float32(common)
                else:
                    # the same sum engine.preview makes, with only this stretch of the new stem built
                    assets = {a['role']: a for a in manifest['assets']}
                    heard = part.copy()
                    for r in engine.STEMS:
                        if r != self.role:
                            heard += engine.read_wav(Path(root) / assets[r]['relative_path'], assets[r])[start:start + count]
                    heard *= np.float32(common)
            level = max(0.0, min(1.0, float(volume) / 100))
            out = np.clip(heard * np.float32(level), -1, 1)        # belt and braces: nothing over full scale ever reaches the speakers
            if loop_seconds and len(out) > RATE // 50:               # a loop's join is faded a hair, so going round doesn't click
                fade = RATE // 200
                ramp = np.linspace(0, 1, fade, dtype=np.float32)[:, None]
                out[:fade] *= ramp
                out[-fade:] *= ramp[::-1]
            self._sound().stop()
            self._sound().play(out, RATE, loop=bool(loop_seconds))
            played.update(seconds=len(out) / RATE, loop=bool(loop_seconds), start=start / RATE)
        state = self._guard('The preview', work)
        return {**state, 'played': played or None}

    def stop(self):
        try:
            if self.player is not None:
                self.player.stop()
        except Exception:
            pass
        return None

    # ------------------------------------------------------------ publishing
    def replace(self):
        def work():
            if not self.song_id or self.new is None:
                raise StemError('Choose a song and a file first.')
            self.stop()
            self._plan()                                        # always checked afresh, at the place it sits now
            plan = self.plan
            stem = plan['stem']                                 # at its level, with its peaks eased: exactly what was checked
            report = {'file': self.file.name, 'offset_frames': self.offset, 'gain_db': plan['gain_db'], 'matched_db': plan['matched_db'], 'trim_db': plan['trim_db'],
                      'confidence': self.found['confidence'], 'drift_ms': self.found['drift_ms']}
            title = self.space.library.song(self.song_id)['title']
            self.space.replace(self.song_id, self.role, stem, report)
            self.say(f'Done. “{title}” now plays with the new {STEM_WORDS[self.role].lower()}. Open Chord Buddy to hear it in the mixer. '
                     'To undo, come back here and press Restore original.')
        return self._guard('Replacing the stem', work)

    def restore(self):
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            self.stop()
            title = self.space.library.song(self.song_id)['title']
            self.space.restore(self.song_id, self.role)
            self.plan = None
            self.say(f'Done. “{title}” has its own {STEM_WORDS[self.role].lower()} again.')
        return self._guard('Putting the original back', work)

    # ------------------------------------------------------------ transposing the analysis (transpose.py)
    def key_clues(self):
        """What Chord Buddy goes by to name the chosen song's key, for the page to work it out with the app's own key code: the key chosen by
        hand (if any) and the analysis model's own key file. (The chart's chords, the third clue, the page already has.)"""
        with self.lock:
            if not self.song_id:
                return {'saved': '', 'key_lab': None}
            text = None
            try:
                documents = self._documents()
                for item in documents.for_song(self.song_id):
                    if item['kind'] == 'text' and item['name'].replace('\\', '/').split('/')[-1] == 'key.lab':
                        text = documents.get(item['id'])['content'].get('text')
                        break
            except Exception:
                text = None
            try:
                saved = (self.space.library.read_prefs() or {}).get('cb-key:' + self.song_id) or ''
            except Exception:
                saved = ''
            return {'saved': saved, 'key_lab': text}

    def transpose_plan(self, semitones, melody=True, shown_key=None):
        """What moving this song's chords, key, lead sheet and MIDI by this many semitones would do, without doing it: {plan} or {error}."""
        with self.lock:
            if not self.song_id:
                return {'error': 'Choose a song first.'}
            try:
                return {'plan': transpose.public(transpose.plan(self._documents(), self.space.library, self.song_id, int(semitones), bool(melody), shown_key))}
            except (ValueError, TypeError) as exc:
                return {'error': str(exc)}
            except Exception as exc:
                return {'error': f'{type(exc).__name__}: {exc}'}

    def transpose(self, semitones, melody=True, shown_key=None):
        """Move them: one new step in each document's history in Chord Buddy, so its Undo takes it back."""
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            title = self.space.library.song(self.song_id)['title']
            done = transpose.apply(self._documents(), self.space.library, self.song_id, int(semitones), bool(melody), shown_key)
            if not done['done']:
                raise StemError(' '.join(done['warnings']) or 'There was nothing to move.')
            key = f' It is now in {done["key"][1]}.' if done.get('key') else ''
            self.say(f'Done. The chords and notes of “{title}” are now {done["words"]}.{key} To take it back, press Undo on each tab in Chord Buddy, '
                     f'or move it {transpose.words(-int(semitones))} here.')
            for warning in done['warnings']:
                self.say(warning)
        return self._guard('Transposing', work)

    # ------------------------------------------------------------ copying action flags from another song (flags.py)
    def _performances(self):
        if getattr(self, 'performances', None) is None:
            self.performances = PerformanceStore(self.space.library)
        return self.performances

    def flag_sources(self):
        """Every other song there is something to copy from: a chart (for its song structure and lyrics) or an arrangement (for its action
        flags): [{id, title, artist, has_chart, arrangements: [{id, name}]}]."""
        with self.lock:
            out = []
            for song in self.space.library.state()['songs']:
                if song['id'] == self.song_id:
                    continue
                try:
                    listed = self._performances().performances_for_song(song['id'])
                except Exception:
                    listed = []
                try:
                    charted = any(d['kind'] == 'chart' for d in self._documents().for_song(song['id']))
                except Exception:
                    charted = False
                if listed or charted:
                    out.append({'id': song['id'], 'title': song['title'], 'artist': song.get('artist') or '', 'has_chart': charted,
                                'arrangements': [{'id': p['id'], 'name': p['name']} for p in listed]})
            return sorted(out, key=lambda s: s['title'].lower())

    def chart_of(self, song_id):
        """A song's chart ({content, music}) for the page to work its bars out with the app's own chart code, or None."""
        with self.lock:
            return self._chart(str(song_id))

    def flags_plan(self, performance_id, bars, name=None, timing=None):
        """What copying that arrangement onto the chosen song would bring, without saving: {plan} or {error}. bars, timing: see flags.py.
        The plan's 'left_out_words' names each thing that cannot be copied, and where it was."""
        with self.lock:
            if not self.song_id:
                return {'error': 'Choose the song to copy onto first.'}
            try:
                planned = flags.public(flags.plan(self._performances(), str(performance_id), self.song_id, bars, name, timing))
                planned['left_out_words'] = flags.left_out_words(planned)
                return {'plan': planned}
            except KeyError as exc:
                return {'error': str(exc).strip(chr(34) + chr(39))}
            except (ValueError, TypeError) as exc:
                return {'error': str(exc)}
            except Exception as exc:
                return {'error': f'{type(exc).__name__}: {exc}'}

    def copy_flags(self, performance_id, bars, grid=None, name=None, timing=None):
        """Save that arrangement as a new one on the chosen song, every flag on the same bar and beat."""
        def work():
            if not self.song_id:
                raise StemError('Choose the song to copy onto first.')
            title = self.space.library.song(self.song_id)['title']
            done = flags.apply(self._performances(), str(performance_id), self.song_id, bars, name, grid, timing)
            c = done['copied']
            parts = [f'{c["flags"]} action flag{"" if c["flags"] == 1 else "s"}'] + [f'{c[k]} {word}{"" if c[k] == 1 else "s"}' for k, word in (('loops', 'loop'), ('jumps', 'jump'), ('holds', 'hold')) if c[k]]
            self.say(f'Done. “{title}” has a new arrangement, “{done["name"]}”, with {", ".join(parts)} at the same moments of the music. '
                     'Choose it on the Perform tab in Chord Buddy (and in your set list, if this song is in one).'
                     + (' ' + flags.left_out_words(done) if done.get('dropped') or done.get('to_last') else ''))
        return self._guard('Copying the action flags', work)

    def flag_alignment(self, source_song):
        """How the other song's recording lines up in time with the chosen song's (flags.recordings_offset), worked out once per pair of songs."""
        with self.lock:
            if not self.song_id:
                return {'offset': 0.0, 'confidence': 0, 'used': False, 'words': ''}
            key = (str(source_song), self.song_id)
            cache = self.__dict__.setdefault('alignments', {})
            if key not in cache:
                try:
                    ffmpeg = self.space.project / 'tools' / 'ffmpeg.exe'
                    theirs = engine.decode(ffmpeg, self.space.library.source_path(key[0]))
                    mine = engine.decode(ffmpeg, self.space.library.source_path(key[1]))
                    cache[key] = flags.recordings_offset(theirs, mine)
                except Exception as exc:
                    cache[key] = {'offset': 0.0, 'confidence': 0, 'used': False,
                                  'words': f'The two recordings could not be compared ({exc}), so they are taken to start at the same moment. Check a flag or two after copying.'}
            return cache[key]

    def count_bars_like(self, seconds, like=None):
        """Count the chosen song's bars from the same place as the other version: chords before `seconds` become rests (flags.count_bars_from)."""
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            title = self.space.library.song(self.song_id)['title']
            done = flags.count_bars_from(self._documents(), self.song_id, float(seconds), like)
            if done['changed']:
                names = ', '.join(done['chords'])
                self.say(f'“{title}” now counts its bars like {"“" + like + "”" if like else "the other version"}: {done["changed"]} chord{"" if done["changed"] == 1 else "s"} '
                         f'heard before the music proper ({names}) became rests. Undo on its Chart tab in Chord Buddy takes that back.')
        return self._guard('Counting the bars', work)

    # ------------------------------------------------------------ copying sections and lyrics from another song (structure.py)
    def structure_plan(self, source_song, bars, timing=None, parts=None):
        """Whether the other song's sections and lyrics can go onto the chosen song, and what would come: {plan} (with 'summary', a sentence) or {error}."""
        with self.lock:
            if not self.song_id:
                return {'error': 'Choose the song to copy onto first.'}
            try:
                planned = structure.plan(self._documents(), str(source_song), self.song_id, bars, timing, parts or structure.PARTS)
                shown = structure.public(planned)
                if planned['ok']:
                    shown['summary'] = structure.words(planned)
                return {'plan': shown}
            except Exception as exc:
                return {'error': f'{type(exc).__name__}: {exc}'}

    def copy_structure(self, source_song, bars, like=None, timing=None, parts=None):
        """Give the chosen song the other song's sections and lyrics: one new step in its chart's history."""
        def work():
            if not self.song_id:
                raise StemError('Choose the song to copy onto first.')
            title = self.space.library.song(self.song_id)['title']
            try:
                done = structure.apply(self._documents(), str(source_song), self.song_id, bars, like, timing, parts or structure.PARTS)
            except structure.NotClose as exc:
                raise StemError(str(exc))
            self.say(f'“{title}” now has {structure.words(done)}, on the same bars as {"“" + like + "”" if like else "the other version"}. '
                     'Undo on its Chart tab in Chord Buddy takes that back.' + (' ' + ' '.join(done['notes']) if done['notes'] else ''))
        return self._guard('Copying the sections and lyrics', work)
