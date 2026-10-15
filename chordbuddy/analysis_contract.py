"""Source-bound analysis identities; no presentation preferences in inference keys."""
import hashlib
import json
from typing import TypedDict

class StageRef(TypedDict):
    id: str
    kind: str
    song_id: str
    source_sha256: str
    recipe_sha256: str
    manifest_sha256: str

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def transcription_dependencies(source_sha256,recipe,settings):
    return {'source_sha256':source_sha256,'recipe':recipe,'device':settings.get('device','auto'),'schema_version':1}
