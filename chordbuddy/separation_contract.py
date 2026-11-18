"""Versioned local separation contract; safe to import without model dependencies."""
import hashlib
import json
import os
import shutil
SCHEMA_VERSION=1
SAMPLE_RATE=44100
CHANNELS=2
STEMS=('bass','drums','other','vocals','piano','lead','rhythm')
TRACKS=('original',)+STEMS
ACTIVE=frozenset(('preparing','separating','refining','validating','cancelling'))
def recipe_digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def file_hash(path):
    digest=hashlib.sha256()
    with open(path,'rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()
def snapshot_source(source,snapshot):
    """Give a job its own name for the song's recording and return the recording's hash. A hard link, so one copy on disk: the
    app never writes a recording again (importing a new one puts a new file under the song's name), so the job's name keeps the
    recording it worked from. A copy where a link is not possible."""
    source_hash=file_hash(source)
    try:os.link(source,snapshot)
    except OSError:shutil.copyfile(source,snapshot)
    if file_hash(snapshot)!=source_hash:raise ValueError('Source changed while copying')
    return source_hash

