"""The Replace a Stem window: one page (page.html) in the same kind of window Chord Buddy uses, talking to controller.py.

The page borrows the app's own look and its chart code (so its bars, beats and section names are exactly the app's), read-only: a tiny web
server here hands out page.html and the files of chordbuddy/web, on this computer only, and nothing else. It serves no library data and takes
no commands: everything the page does goes through the few methods of Bridge below.
"""
from __future__ import annotations

import ctypes
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import engine
from .controller import Controller
from .engine import Workspace

TITLE = 'Replace Stem · Chord Buddy'
AUDIO_FILES = ('Audio files (*.wav;*.flac;*.mp3;*.m4a;*.aif;*.aiff;*.ogg)', 'All files (*.*)')
HERE = Path(__file__).resolve().parent
KINDS = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
         '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.wasm': 'application/wasm'}


class Bridge:
    """What the page may ask for. Every method answers with the controller's state (or the timeline's pictures), which the page draws."""
    def __init__(self, controller):
        self._controller = controller
        self._window = None

    def state(self):
        return self._controller.state()

    def timeline(self):
        return self._controller.timeline()

    def select(self, song_id, role=None):
        return self._controller.select(str(song_id), str(role) if role else None)

    def choose(self):
        import webview
        picked = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False, file_types=AUDIO_FILES) if self._window else None
        if not picked:
            return self._controller.state()
        return self._controller.load(picked[0] if isinstance(picked, (list, tuple)) else picked)

    def move(self, offset_seconds):
        return self._controller.move(offset_seconds)

    def level(self, trim_db=None):
        return self._controller.level(trim_db)

    def play(self, what, position=0, volume=25, loop_seconds=None):
        return self._controller.play(str(what), position, volume, loop_seconds)

    def stop(self):
        self._controller.stop()
        return None

    def key_clues(self):
        return self._controller.key_clues()

    def transpose_plan(self, semitones, melody=True, shown_key=None):
        return self._controller.transpose_plan(semitones, melody, shown_key)

    def transpose(self, semitones, melody=True, shown_key=None):
        return self._controller.transpose(semitones, melody, shown_key)

    def flag_sources(self):
        return self._controller.flag_sources()

    def chart_of(self, song_id):
        return self._controller.chart_of(song_id)

    def flag_alignment(self, source_song):
        return self._controller.flag_alignment(source_song)

    def count_bars_like(self, seconds, like=None):
        return self._controller.count_bars_like(seconds, like)

    def structure_plan(self, source_song, bars, timing=None, parts=None):
        return self._controller.structure_plan(source_song, bars, timing, parts)

    def copy_structure(self, source_song, bars, like=None, timing=None, parts=None):
        return self._controller.copy_structure(source_song, bars, like, timing, parts)

    def flags_plan(self, performance_id, bars, name=None, timing=None):
        return self._controller.flags_plan(performance_id, bars, name, timing)

    def copy_flags(self, performance_id, bars, grid=None, name=None, timing=None):
        return self._controller.copy_flags(performance_id, bars, grid, name, timing)

    def replace(self):
        return self._controller.replace()

    def restore(self):
        return self._controller.restore()


def static_server(web_root):
    """A read-only server for the page and the app's own look, on this computer only. Returns (server, address)."""
    web_root = Path(web_root).resolve()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
                return self._answer(403, b'')
            if path == '/':
                target, root = HERE / 'page.html', HERE
            elif path == '/tool/bar-match.js':                   # the one script of the tool's own that the page loads
                target, root = HERE / 'bar-match.js', HERE
            elif path.startswith(('/web/', '/fonts/')):
                # the app's font list names its fonts as /fonts/..., as the app itself serves them
                relative = path.removeprefix('/web/') if path.startswith('/web/') else path.removeprefix('/')
                # nothing that could be an absolute or climbing path ever reaches the disk
                if not relative or any(c in relative for c in '\\:\x00') or relative.startswith('/') or '..' in relative.split('/'):
                    return self._answer(404, b'')
                target, root = (web_root / relative).resolve(), web_root
            else:
                return self._answer(404, b'')
            if not target.is_relative_to(root) or not target.is_file():
                return self._answer(404, b'')
            # named here, not looked up: Windows can report .css or .js as plain text, and a browser then refuses to use them
            kind = KINDS.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
            self._answer(200, target.read_bytes(), kind)

        def _answer(self, status, body, kind='text/plain'):
            self.send_response(status)
            self.send_header('Content-Type', kind + ('; charset=utf-8' if kind.startswith('text/') else ''))
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.end_headers()
            try:
                self.wfile.write(body)
            except OSError:
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name='stem-tool-page', daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}/'


def tell(text, warning=True):
    """A plain message box (no window toolkit needed), for the two things that stop the tool from opening."""
    try:
        ctypes.windll.user32.MessageBoxW(None, text, 'Replace Stem', 0x30 if warning else 0x10)
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
    try:
        tidied = space.tidy_all()                    # older versions left by earlier replacements; each song checks itself, nothing is raised
    except Exception as exc:
        tidied = {'': str(exc)}
    import webview
    controller = Controller(space)
    for warning in tidied.values():
        controller.say(f'Older stems were kept for one song: {warning}')
    bridge = Bridge(controller)
    server, address = static_server(Path(project) / 'chordbuddy' / 'web')
    bridge._window = webview.create_window(TITLE, url=address, js_api=bridge, width=1180, height=820, min_size=(560, 520))
    try:
        webview.start()
    finally:
        controller.stop()
        server.shutdown()
        server.server_close()
        space.close()
    return 0
