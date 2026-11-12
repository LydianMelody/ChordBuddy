"""What the Replace a Stem window does, with no window in it: each button is one method, and state() is everything the window shows.

The page (page.html) calls these through the window's bridge, one at a time; each returns state() so the page simply draws what it gets.
Nothing is written to the library until replace() or restore().
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from . import engine
from .engine import RATE, STEM_WORDS, StemError

PREVIEW_SECONDS = 20
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
        self.offset = 0                           # frames
        self.trim = 0.0
        self.found = None
        self.placed = None                        # the file as a whole stem at gain 1, at the current start
        self.plan = None
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
        match = level = ''
        if f:
            ms = self.found['offset'] / RATE * 1000
            where = 'It starts where the song starts.' if abs(ms) < 3 else f'It belongs {abs(ms) / 1000:.3f} s {"later" if ms > 0 else "earlier"} than the file starts.'
            # the page shows how sure the match is as a badge, so the same words are not said twice
            match = f'{where} {f["words"].replace("A clear match.", "").strip()}'.strip()
        if p:
            level = f'{p["gain_db"]:+.1f} dB on the file ({p["matched_db"]:+.1f} to match the stem it replaces' + (f', {p["trim_db"]:+.1f} by hand)' if p['trim_db'] else ')')
            level += f'. The old stem sat at {p["old_loudness_db"]:.1f} dB; the new one will sit at {p["new_loudness_db"]:.1f} dB.'
        return {
            'songs': [{**s, 'length': clock(s['seconds']), 'replaced': [STEM_WORDS[r] for r in s['replaced']]} for s in songs],
            'stems': [{'id': r, 'name': STEM_WORDS[r]} for r in engine.STEMS],
            'song': song['id'] if song else None, 'title': song['title'] if song else '', 'seconds': song['seconds'] if song else 0,
            'role': self.role, 'role_name': STEM_WORDS[self.role],
            'file': self.file.name if self.file else None, 'file_length': clock(len(self.new) / RATE) if self.new is not None else None,
            'match': match, 'confidence': f['confidence'] if f else None, 'suggested_ms': round(f['offset'] / RATE * 1000) if f else None,
            'offset_ms': round(self.offset / RATE * 1000), 'trim_db': self.trim, 'trim_range': list(engine.TRIM_RANGE_DB),
            'level': level, 'notes': list(p['notes']) if p else [],
            'can_replace': bool(song and p), 'can_restore': backup, 'can_play': bool(song),
            'preview_seconds': PREVIEW_SECONDS, 'start_volume': START_VOLUME, 'messages': self.messages[-40:],
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

    # ------------------------------------------------------------ choosing
    def select(self, song_id, role=None):
        def work():
            self.stop()
            if role and role not in engine.STEMS:
                raise StemError('Choose which stem to replace.')
            self.space.active(song_id)                       # says so if the song has no stems
            self.song_id, self.role = song_id, role or self.role
            self.found = self.placed = self.plan = None
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
            self.new, self.file = engine.check_audio(audio), Path(name)
            self._line_up()
        return self._guard('Reading the file', work)

    def _line_up(self):
        found = engine.find_offset(self.new, self.space.stem(self.song_id, self.role))
        if found['confidence'] < .35:                        # nothing like the old stem (it may be silent): try against the whole recording
            again = engine.find_offset(self.new, self.space.stem(self.song_id, 'original'))
            if again['confidence'] > found['confidence']:
                found = again
        self.found, self.offset, self.trim = found, found['offset'], 0.0
        self._plan()

    def _plan(self):
        self.placed = self.plan = None
        root, manifest = self.space.active(self.song_id)
        self.placed = engine.place(self.new, manifest['frames'], self.offset)
        self.plan = engine.plan_level(root, manifest, self.role, self.placed, self.trim)
        self.trim = self.plan['trim_db']

    def adjust(self, offset_ms=None, trim_db=None):
        """The start (milliseconds; bigger is later in the song) or the level (dB from the matched level) was changed by hand."""
        def work():
            if self.new is None or not self.song_id:
                raise StemError('Choose a song and a file first.')
            self.stop()
            if offset_ms is not None:
                self.offset = int(round(float(offset_ms) / 1000 * RATE))
            if trim_db is not None:
                self.trim = float(trim_db)
            self._plan()
        return self._guard('Setting the start and level', work)

    def use_suggested(self):
        return self.adjust(offset_ms=self.found['offset'] / RATE * 1000) if self.found else self.state()

    # ------------------------------------------------------------ listening
    def _sound(self):
        if self.player is None:
            import sounddevice
            self.player = sounddevice
        return self.player

    def play(self, what, position=0.0, volume=START_VOLUME):
        """what: 'new' (the song with the new stem), 'now' (the song as it is), 'solo' (the new stem alone). PREVIEW_SECONDS from `position` seconds."""
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            if what != 'now' and self.plan is None:
                raise StemError('Choose a file first.')
            root, manifest = self.space.active(self.song_id)
            start = max(0, min(manifest['frames'] - RATE, int(float(position) * RATE)))
            if what == 'now':
                heard = engine.preview(root, manifest, self.role, self.space.stem(self.song_id, self.role), start, PREVIEW_SECONDS)
            else:
                stem = self.placed * np.float32(engine.gain_of(self.plan['gain_db']))
                if what == 'solo':
                    heard = stem[start:start + PREVIEW_SECONDS * RATE] * np.float32(self.plan['common_gain'])
                else:
                    heard = engine.preview(root, manifest, self.role, stem, start, PREVIEW_SECONDS, self.plan['common_gain'])
            level = max(0.0, min(1.0, float(volume) / 100))
            out = np.clip(heard * np.float32(level), -1, 1)        # belt and braces: nothing over full scale ever reaches the speakers
            self._sound().stop()
            self._sound().play(out, RATE)
        return self._guard('The preview', work)

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
            if not self.song_id or self.plan is None:
                raise StemError('Choose a song and a file first.')
            self.stop()
            plan = self.plan
            stem = self.placed * np.float32(engine.gain_of(plan['gain_db']))
            report = {'file': self.file.name, 'offset_frames': self.offset, 'gain_db': plan['gain_db'], 'matched_db': plan['matched_db'], 'trim_db': plan['trim_db'],
                      'confidence': self.found['confidence'], 'drift_ms': self.found['drift_ms']}
            title = self.space.library.song(self.song_id)['title']
            self.space.replace(self.song_id, self.role, stem, report)
            self.say(f'Done. “{title}” now plays with the new {STEM_WORDS[self.role].lower()}. Open Chord Buddy to hear it in the mixer. '
                     'To undo, come back here and press “Put the original back”.')
        return self._guard('Replacing the stem', work)

    def restore(self):
        def work():
            if not self.song_id:
                raise StemError('Choose a song first.')
            self.stop()
            title = self.space.library.song(self.song_id)['title']
            self.space.restore(self.song_id, self.role)
            self.say(f'Done. “{title}” has its own {STEM_WORDS[self.role].lower()} again.')
            if self.new is not None:
                self._plan()
        return self._guard('Putting the original back', work)
