from __future__ import annotations
import json
import os
import re
import secrets
import threading
from datetime import datetime, timezone
from .filenames import safe_stem

MAX_MIDI=16*1024*1024
MAX_SETTINGS=256*1024
MISSING='That MIDI file is not here'


class UserMidi:
    """The MIDI files a user drops onto a song (exported from their DAW), kept in the song's own my-midi folder.
    The frontend parses them; this only stores bytes plus a small settings JSON per file. User files are never hard-deleted."""
    def __init__(self,library):
        self.library=library
        self.lock=threading.Lock()

    def _dir(self,song_id,create=False):
        self.library.validate_song_paths(song_id)   # the song exists and sits inside the library
        folder=self.library.contained(self.library.folder(song_id)/'my-midi')
        if create:folder.mkdir(exist_ok=True)
        return folder

    def _index(self,folder):
        try:files=json.loads((folder/'index.json').read_text('utf-8')).get('files',[])
        except (OSError,ValueError,AttributeError):files=[]
        return [f for f in files if isinstance(f,dict) and re.fullmatch(r'[0-9a-f]{12}',str(f.get('id','')))]

    def _write(self,path,data):
        temp=path.with_name(path.name+'.'+secrets.token_hex(3)+'.tmp')   # a crash never leaves half a file under the real name
        try:
            temp.write_bytes(data);os.replace(temp,path)
        finally:
            temp.unlink(missing_ok=True)

    def _save_index(self,folder,files):
        self._write(folder/'index.json',json.dumps({'files':files},indent=1).encode('utf-8'))

    @staticmethod
    def _clean_name(name):
        name=str(name or '').replace('\\','/').split('/')[-1]
        name=re.sub(r'[\x00-\x1f]+','',name).strip()[:200]
        if not name:raise ValueError('The MIDI file needs a name')
        return name

    @staticmethod
    def _file(folder,item):
        # a readable name that still carries the id ("Real Thing custom (1a2b3c4d5e6f).mid"), so it is easy to pick when exporting back
        # over it from a DAW; files from before this have just the id
        name=str(item.get('file') or '')
        return folder/(name if re.fullmatch(r'[^\\/:]{1,200}\([0-9a-f]{12}\)\.mid',name) and name.endswith(f"({item['id']}).mid") else item['id']+'.mid')

    def _entry(self,folder,item):
        stat=self._file(folder,item).stat()
        return {'id':item['id'],'name':item.get('name',''),'added':item.get('added',''),'size':stat.st_size,'mtime':stat.st_mtime,'settings':item.get('settings') or {}}

    def _find(self,files,file_id):
        if not isinstance(file_id,str) or not re.fullmatch(r'[0-9a-f]{12}',file_id):raise KeyError(MISSING)
        item=next((f for f in files if f['id']==file_id),None)
        if item is None:raise KeyError(MISSING)
        return item

    def list(self,song_id):
        with self.lock:
            folder=self._dir(song_id)
            if not folder.is_dir():return []
            return [self._entry(folder,f) for f in self._index(folder) if self._file(folder,f).is_file()]

    def add(self,song_id,filename,data,replace=None):
        name=self._clean_name(filename)
        if not name.lower().endswith(('.mid','.midi')):raise ValueError('Choose a MIDI file (.mid or .midi)')
        if not data.startswith(b'MThd') or not 14<=len(data)<=MAX_MIDI:raise ValueError('That is not a valid MIDI file')
        with self.lock:
            folder=self._dir(song_id,True);files=self._index(folder)
            item=next((f for f in files if f['id']==replace),None) if isinstance(replace,str) else None
            if item:item['name']=name   # same id and settings: the DAW export replaces the music, not the work done around it
            else:
                item={'id':secrets.token_hex(6),'name':name,'added':datetime.now(timezone.utc).isoformat(timespec='seconds'),'settings':{}}
                stem=safe_stem(re.sub(r'(?i)\.midi?$','',name),'MIDI',80)
                item['file']=f"{stem} ({item['id']}).mid"
                files.append(item)
            self._write(self._file(folder,item),data)
            self._save_index(folder,files)
            return self._entry(folder,item)

    def merge(self,song_id,incoming):
        """MIDI files from a song zip: [(index item, bytes)]. One already here (by id) stays as it is, your settings with it. Returns (added, left out)."""
        added=skipped=0
        with self.lock:
            folder=self._dir(song_id,True);files=self._index(folder);have={f['id'] for f in files}
            for item,data in incoming:
                ident=str(item.get('id','')) if isinstance(item,dict) else ''
                if not re.fullmatch(r'[0-9a-f]{12}',ident):skipped+=1;continue
                if ident in have:continue
                if not isinstance(data,bytes) or not data.startswith(b'MThd') or not 14<=len(data)<=MAX_MIDI:skipped+=1;continue
                try:name=self._clean_name(item.get('name'))
                except ValueError:skipped+=1;continue
                settings=item.get('settings') if isinstance(item.get('settings'),dict) else {}
                if len(json.dumps(settings))>MAX_SETTINGS:settings={}
                clean={'id':ident,'name':name,'added':str(item.get('added') or '')[:40],'settings':settings}
                clean['file']=self._file(folder,dict(item,id=ident)).name
                self._write(self._file(folder,clean),data)
                files.append(clean);have.add(ident);added+=1
            if added:self._save_index(folder,files)
        return added,skipped

    def read(self,song_id,file_id):
        return self.path(song_id,file_id).read_bytes()

    def path(self,song_id,file_id):
        with self.lock:
            folder=self._dir(song_id);item=self._find(self._index(folder),file_id)
            path=self.library.contained(self._file(folder,item))
            if not path.is_file():raise KeyError(MISSING)
            return path

    def save_settings(self,song_id,file_id,settings):
        if not isinstance(settings,dict):raise ValueError('Expected settings')
        if len(json.dumps(settings,allow_nan=False).encode('utf-8'))>MAX_SETTINGS:raise ValueError('Those MIDI settings are too large')
        return self._change(song_id,file_id,lambda item:item.__setitem__('settings',settings))

    def rename(self,song_id,file_id,name):
        name=self._clean_name(name)
        return self._change(song_id,file_id,lambda item:item.__setitem__('name',name))

    def _change(self,song_id,file_id,apply):
        with self.lock:
            folder=self._dir(song_id);files=self._index(folder);item=self._find(files,file_id)
            if not self._file(folder,item).is_file():raise KeyError(MISSING)
            apply(item);self._save_index(folder,files)
            return self._entry(folder,item)

    def remove(self,song_id,file_id):
        with self.lock:
            folder=self._dir(song_id);files=self._index(folder);item=self._find(files,file_id)
            gone=folder/'removed';gone.mkdir(exist_ok=True)
            stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-'+file_id
            source=self._file(folder,item)
            if source.is_file():os.replace(source,gone/(stamp+'.mid'))
            (gone/(stamp+'.json')).write_text(json.dumps(item,indent=1),'utf-8')   # so it can be restored by hand
            self._save_index(folder,[f for f in files if f['id']!=file_id])

    def next_name(self,song_id,base):
        stem=re.sub(r'\.(mid|midi)$','',self._clean_name(base),flags=re.I)
        with self.lock:
            folder=self._dir(song_id);used={f.get('name','').lower() for f in self._index(folder)}
        n=1
        while True:
            name=stem+(' '+str(n) if n>1 else '')+'.mid'
            if name.lower() not in used:return name
            n+=1

    def folder_path(self,song_id):
        with self.lock:return self._dir(song_id,True)
