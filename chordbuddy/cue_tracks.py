from __future__ import annotations
import json
import os
import re
import secrets
import threading
from datetime import datetime, timezone

MAX_CUE=250*1024*1024
AUDIO=('.wav','.mp3','.flac','.ogg','.oga','.opus','.m4a','.aac','.aif','.aiff')
INDEX='index.json'


class CueTracks:
    """A song's cue track: one audio file you supply, lined up with the recording from its first sample, that only you hear (monitor_audio.py).
    Kept in the song's own my-cues folder. A file you supplied is never hard-deleted: a replaced or removed one moves to my-cues/removed."""
    def __init__(self,library):
        self.library=library
        self.lock=threading.Lock()

    def _dir(self,song_id,create=False):
        self.library.validate_song_paths(song_id)
        folder=self.library.contained(self.library.folder(song_id)/'my-cues')
        if create:folder.mkdir(exist_ok=True)
        return folder

    def _read_index(self,folder):
        try:item=json.loads((folder/INDEX).read_text('utf-8'))
        except (OSError,ValueError):return None
        if not isinstance(item,dict) or not re.fullmatch(r'cue-[0-9a-f]{12}\.[a-z0-9]{2,5}',str(item.get('file',''))):return None
        return item if (folder/item['file']).is_file() else None

    def _write(self,path,data):
        temp=path.with_name(path.name+'.'+secrets.token_hex(3)+'.tmp')   # a crash never leaves half a file under the real name
        try:
            temp.write_bytes(data);os.replace(temp,path)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def _seconds(path):
        """How long a file is, or None if it isn't audio that can be read."""
        try:
            import mutagen
            found=mutagen.File(str(path))
            return round(float(found.info.length),3) if found is not None and found.info.length>0 else None
        except Exception:
            return None

    @staticmethod
    def _entry(item):
        return {'name':item.get('name',''),'added':item.get('added',''),'seconds':item.get('seconds'),'version':item['file']}

    def get(self,song_id):
        """The song's cue track, or None."""
        with self.lock:
            folder=self._dir(song_id)
            item=self._read_index(folder) if folder.is_dir() else None
            return self._entry(item) if item else None

    def path(self,song_id):
        with self.lock:
            folder=self._dir(song_id);item=self._read_index(folder) if folder.is_dir() else None
            if not item:raise KeyError('This song has no cue track')
            return self.library.contained(folder/item['file'])

    def _store(self,folder,name,data,added=None,move_old=True):
        suffix=os.path.splitext(name)[1].lower()
        target=folder/f'cue-{secrets.token_hex(6)}{suffix}'
        self._write(target,data)
        seconds=self._seconds(target)
        if seconds is None:
            target.unlink(missing_ok=True)
            raise ValueError('Chord Buddy couldn’t read that as audio. Try a WAV, MP3 or FLAC file.')
        old=self._read_index(folder)
        item={'file':target.name,'name':name,'added':added or datetime.now(timezone.utc).isoformat(timespec='seconds'),'seconds':seconds}
        self._write(folder/INDEX,json.dumps(item,indent=1).encode('utf-8'))
        if old and move_old:self._retire(folder,old)
        return item

    def _retire(self,folder,item):
        gone=folder/'removed';gone.mkdir(exist_ok=True)
        stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        os.replace(folder/item['file'],gone/f"{stamp}-{item['file']}")
        (gone/f'{stamp}.json').write_text(json.dumps(item,indent=1),'utf-8')   # so it can be restored by hand

    def add(self,song_id,filename,data):
        """Sets the song's cue track. One it already had moves to my-cues/removed."""
        name=re.sub(r'[\x00-\x1f]+','',str(filename or '').replace('\\','/').split('/')[-1]).strip()[:200]
        if not name.lower().endswith(AUDIO):raise ValueError('Choose an audio file: WAV, MP3, FLAC, OGG or M4A.')
        if not data or len(data)>MAX_CUE:raise ValueError('That audio file is empty or larger than 250 MB.')
        with self.lock:
            return self._entry(self._store(self._dir(song_id,True),name,data))

    def merge(self,song_id,item,data):
        """A cue track from a song zip. One already here stays as it is. Returns (added, left out)."""
        if not isinstance(item,dict) or not isinstance(data,bytes) or not data or len(data)>MAX_CUE:return 0,1
        name=re.sub(r'[\x00-\x1f]+','',str(item.get('name') or '').replace('\\','/').split('/')[-1]).strip()[:200]
        if not name.lower().endswith(AUDIO):return 0,1
        with self.lock:
            folder=self._dir(song_id,True)
            if self._read_index(folder):return 0,0
            try:self._store(folder,name,data,str(item.get('added') or '')[:40] or None)
            except ValueError:return 0,1
        return 1,0

    def remove(self,song_id):
        with self.lock:
            folder=self._dir(song_id);item=self._read_index(folder) if folder.is_dir() else None
            if not item:raise KeyError('This song has no cue track')
            self._retire(folder,item)
            (folder/INDEX).unlink(missing_ok=True)
