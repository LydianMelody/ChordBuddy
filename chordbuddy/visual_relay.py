from __future__ import annotations
import json
import queue
import re
import secrets
import threading

PING=15                       # seconds between keep-alive comments, so a quiet stream is not dropped
BACKLOG=512                   # messages a slow listener may fall behind by before it is dropped (it reconnects and starts fresh)
HELLO=json.dumps({'type':'hello'})
TO_VIEWERS={'scene','clock','setup'}


class VisualRelay:
    """Carries the visual bridge's messages (visual-bridge.js) between the player page and visualizers in another browser, such as an
    OBS Browser Source, which the page's BroadcastChannel cannot reach. Viewers only listen: they never change the player. When a viewer
    connects (or the player page connects while viewers wait), the player is sent a hello for it, so it answers with the scene, the setup
    and the clock, exactly as for a pop-out window."""
    def __init__(self):
        self.lock=threading.Lock()
        self.viewers=set()
        self.players=set()
        self.closed=False

    def _put(self,group,text):
        for listener in list(group):
            try:listener.put_nowait(text)
            except queue.Full:
                with self.lock:group.discard(listener)   # its stream ends; the browser reconnects and is sent everything again

    def send(self,messages):
        """From the player page: scene, clock and setup messages for the viewers. Returns how many viewers are listening."""
        if not isinstance(messages,list):raise ValueError('Expected a list of messages')
        for message in messages:
            if not isinstance(message,dict) or message.get('type') not in TO_VIEWERS:raise ValueError('Not a visualizer message')
        for message in messages:self._put(self.viewers,json.dumps(message,allow_nan=False,separators=(',',':')))
        with self.lock:return len(self.viewers)

    def stream(self,role,write,ping=PING):
        """Writes server-sent events to `write` until the listener goes away or the relay closes. role: 'viewer' or 'player'."""
        listener=queue.Queue(BACKLOG)
        group=self.viewers if role=='viewer' else self.players
        with self.lock:
            if self.closed:return
            group.add(listener)
            waiting=bool(self.viewers)
        if role=='viewer':self._put(self.players,HELLO)
        elif waiting:listener.put_nowait(HELLO)
        try:
            write(': connected\n\n')
            while True:
                try:text=listener.get(timeout=ping)
                except queue.Empty:
                    with self.lock:
                        if listener not in group:return
                    write(': ping\n\n');continue
                if text is None:return
                write('data: '+text+'\n\n')
        finally:
            with self.lock:group.discard(listener)

    def close(self):
        with self.lock:
            self.closed=True
            listeners=[*self.viewers,*self.players]
        for listener in listeners:
            try:listener.put_nowait(None)
            except queue.Full:pass


def stream_key(path,create=False):
    """The key in a visualizer's stream address. It stays the same between launches, so an OBS Browser Source keeps working; it is kept
    in the library, made the first time it is asked for. None when there is none yet."""
    try:
        key=path.read_text('utf-8').strip()
        if re.fullmatch(r'[A-Za-z0-9_-]{20,64}',key):return key
    except OSError:
        pass
    if not create:return None
    key=secrets.token_urlsafe(24)
    path.write_text(key,'utf-8')
    return key
