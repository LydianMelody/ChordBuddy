"""Versioned local separation contract; safe to import without model dependencies."""
import hashlib
import json
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

