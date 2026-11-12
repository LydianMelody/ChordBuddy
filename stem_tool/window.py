"""The Replace a Stem window: one page (page.html) in the same kind of window Chord Buddy uses, talking to controller.py.

The page can only call the few methods of Bridge below: it has no web address, loads nothing from the network, and cannot reach the app.
"""
from __future__ import annotations

import ctypes
from pathlib import Path

from . import engine
from .controller import Controller
from .engine import Workspace

TITLE = 'Replace a Stem · Chord Buddy'
AUDIO_FILES = ('Audio files (*.wav;*.flac;*.mp3;*.m4a;*.aif;*.aiff;*.ogg)', 'All files (*.*)')


class Bridge:
    """What the page may ask for. Every method answers with the controller's state, which the page draws."""
    def __init__(self, controller):
        self._controller = controller
        self._window = None

    def state(self):
        return self._controller.state()

    def select(self, song_id, role=None):
        return self._controller.select(str(song_id), str(role) if role else None)

    def choose(self):
        import webview
        picked = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False, file_types=AUDIO_FILES) if self._window else None
        if not picked:
            return self._controller.state()
        return self._controller.load(picked[0] if isinstance(picked, (list, tuple)) else picked)

    def adjust(self, offset_ms=None, trim_db=None):
        return self._controller.adjust(offset_ms, trim_db)

    def use_suggested(self):
        return self._controller.use_suggested()

    def play(self, what, position=0, volume=25):
        return self._controller.play(str(what), position, volume)

    def stop(self):
        self._controller.stop()
        return None

    def replace(self):
        return self._controller.replace()

    def restore(self):
        return self._controller.restore()


def tell(text, warning=True):
    """A plain message box (no window toolkit needed), for the two things that stop the tool from opening."""
    try:
        ctypes.windll.user32.MessageBoxW(None, text, 'Replace a Stem', 0x30 if warning else 0x10)
    except Exception:
        print(text)


def run(library, project):
    """Open the window on this library. Returns when it is closed."""
    if engine.app_running():
        tell('Chord Buddy is open.\n\nClose Chord Buddy first, then start this again: the two must never change your library at the same time.')
        return 1
    try:
        space = Workspace(library, project)
    except Exception as exc:
        tell(f'Your Chord Buddy library could not be opened.\n\n{exc}', warning=False)
        return 1
    import webview
    controller = Controller(space)
    bridge = Bridge(controller)
    page = (Path(__file__).with_name('page.html')).read_text(encoding='utf-8')
    bridge._window = webview.create_window(TITLE, html=page, js_api=bridge, width=820, height=900, min_size=(640, 600))
    try:
        webview.start()
    finally:
        controller.stop()
        space.close()
    return 0
