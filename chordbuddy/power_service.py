from __future__ import annotations
import ctypes
import queue
import sys
import threading

ES_CONTINUOUS=0x80000000
ES_SYSTEM_REQUIRED=0x00000001
ES_DISPLAY_REQUIRED=0x00000002


def windows_call(flags):
    return ctypes.windll.kernel32.SetThreadExecutionState(flags)


class PowerService:
    """Keeps the computer and screen awake during a show. Windows ties the request to the thread that makes it, so one thread owns it and every
    window's request is counted here: one window letting go can't drop another's. Stops idle sleep and the screen going dark. It can't stop a
    deliberate sleep, a closed lid or a screen saver, and it changes no power settings. Ends by itself if the app exits."""
    def __init__(self,call=None):
        self.call=call or (windows_call if sys.platform=='win32' else None)
        self.lock=threading.Lock();self.holders=set();self.active=None;self.jobs=queue.Queue();self.thread=None

    def _worker(self):
        while True:
            flags,done=self.jobs.get()
            if flags is None:
                try:self.call(ES_CONTINUOUS)
                finally:done(True)
                return
            try:ok=self.call(flags)!=0
            except Exception:ok=False
            done(ok)

    def _ask(self,flags):
        if self.call is None:return False
        if self.thread is None:
            self.thread=threading.Thread(target=self._worker,name='keep-awake',daemon=True);self.thread.start()
        answer=queue.Queue(maxsize=1)
        self.jobs.put((flags,answer.put))
        try:return answer.get(timeout=5)
        except queue.Empty:return False

    def acquire(self,holder):
        """Returns whether the computer is being kept awake."""
        with self.lock:
            self.holders.add(str(holder))
            if self.active is not True:self.active=self._ask(ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED)
            return {'awake':bool(self.active),'holders':len(self.holders)}

    def release(self,holder):
        with self.lock:
            self.holders.discard(str(holder))
            if not self.holders and self.active:
                self._ask(ES_CONTINUOUS);self.active=None
            return {'awake':bool(self.active),'holders':len(self.holders)}

    def status(self):
        with self.lock:
            return {'awake':bool(self.active),'holders':len(self.holders),'supported':self.call is not None}

    def close(self):
        with self.lock:
            self.holders.clear()
            if self.thread is not None:
                answer=queue.Queue(maxsize=1)
                self.jobs.put((None,answer.put))
                try:answer.get(timeout=2)
                except queue.Empty:pass
                self.thread=None;self.active=None
