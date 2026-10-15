"""One inference owner across transcription and separation."""
import threading
import uuid
class InferenceGate:
    def __init__(self):self.lock=threading.Lock();self.owner=None
    def try_acquire(self,kind,song_id,job_id):
        with self.lock:
            if self.owner is not None:raise RuntimeError('Another song is already being processed')
            self.owner=uuid.uuid4().hex
            return self.owner
    def release(self,owner):
        with self.lock:
            if self.owner==owner:self.owner=None

