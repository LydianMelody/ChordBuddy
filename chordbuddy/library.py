"""Transactional song library. All paths are derived from stored identifiers."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import io
import json
import shutil
from pathlib import Path, PureWindowsPath
import re
import sqlite3
import threading
import uuid

from mutagen.mp3 import MP3

from .confidence import (confidence_defaults, opacity_defaults,
                         validate_confidence_settings, validate_opacity_settings)
from .chords import chord_label
from .path_policy import validate_song, validate_project, reserve_directory
import math


def now():
    return datetime.now(timezone.utc).isoformat()


def safe_title(title):
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip(' .')[:80]
    if not title or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', title):
        title = 'Untitled'
    return title


def metadata_defaults():
    return {'timing': {'constant_tempo': False, 'bpm': None}, 'chord_overrides': []}


def clean_bar_edits(value):
    """Barlines the user added or removed, as times in seconds: {'add': [...], 'remove': [...]}. Empty when there are none."""
    if value in (None,{},[]):return {}
    if not isinstance(value,dict) or set(value)-{'add','remove'}:raise ValueError('Invalid barline edits')
    result={}
    for key in ('add','remove'):
        times=value.get(key,[])
        if not isinstance(times,list) or len(times)>400 or any(type(t) not in (int,float) or not math.isfinite(t) or not 0<=t<=100000 for t in times):
            raise ValueError('Invalid barline edits')
        times=sorted({round(float(t),4) for t in times})
        if times:result[key]=times
    return result


def validate_song_metadata(value):
    """Validate durable timing and explicit chord corrections."""
    if not isinstance(value, dict) or set(value) - {'timing', 'chord_overrides'}:
        raise ValueError('Song metadata must contain timing and chord overrides')
    timing=value.get('timing', {})
    if not isinstance(timing, dict) or set(timing) - {'constant_tempo', 'bpm', 'bar_edits'} or type(timing.get('constant_tempo', False)) is not bool:
        raise ValueError('Invalid constant tempo setting')
    bpm=timing.get('bpm')
    if bpm is not None and (type(bpm) not in (int,float) or not math.isfinite(bpm) or not 20 <= bpm <= 300):
        raise ValueError('BPM must be between 20 and 300, or empty')
    overrides=value.get('chord_overrides', [])
    if not isinstance(overrides, list):
        raise ValueError('Chord overrides must be a list')
    cleaned=[]
    seen=set()
    for item in overrides:
        if not isinstance(item,dict): raise ValueError('Invalid chord override')
        ident,start,end,label=item.get('id'),item.get('start'),item.get('end'),item.get('label')
        if not isinstance(ident,str) or not ident or len(ident)>200 or ident in seen:
            raise ValueError('Every chord override needs a unique identifier')
        if type(start) not in (int,float) or type(end) not in (int,float) or not math.isfinite(start) or not math.isfinite(end) or not 0<=start<end:
            raise ValueError('Chord override range is invalid')
        if not isinstance(label,str) or not label.strip() or len(label)>200 or any(c in label for c in '\x00\r\n'):
            raise ValueError('Chord override label is invalid')
        if type(item.get('confirmed',True)) is not bool: raise ValueError('Chord override confirmation is invalid')
        seen.add(ident); cleaned.append({'id':ident,'start':float(start),'end':float(end),'label':chord_label(label.strip()),'confirmed':item.get('confirmed',True)})
    result={'constant_tempo':timing.get('constant_tempo',False),'bpm':float(bpm) if bpm is not None else None}
    edits=clean_bar_edits(timing.get('bar_edits'))
    if edits:result['bar_edits']=edits
    return {'timing': result, 'chord_overrides':cleaned}


class Library:
    def __init__(self, root, project_dir=None):
        self.project=Path(project_dir).resolve() if project_dir is not None else None
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / 'library.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS songs(id TEXT PRIMARY KEY,title TEXT NOT NULL,artist TEXT NOT NULL,
                filename TEXT NOT NULL,duration REAL NOT NULL,folder TEXT UNIQUE NOT NULL,status TEXT NOT NULL,
                error TEXT,active_run TEXT,created TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS song_metadata(song_id TEXT PRIMARY KEY REFERENCES songs(id),metadata TEXT NOT NULL DEFAULT '{}',metadata_revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS setlists(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,created TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memberships(setlist_id TEXT REFERENCES setlists(id),song_id TEXT REFERENCES songs(id),
                position INTEGER NOT NULL,PRIMARY KEY(setlist_id,song_id));
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,song_id TEXT REFERENCES songs(id),created TEXT NOT NULL,
                status TEXT NOT NULL,error TEXT,metadata TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,song_id TEXT REFERENCES songs(id),run_id TEXT REFERENCES runs(id),
                name TEXT NOT NULL,kind TEXT NOT NULL,original_path TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 0,UNIQUE(run_id,name));
            CREATE TABLE IF NOT EXISTS retained_documents(run_id TEXT REFERENCES runs(id),document_id TEXT REFERENCES documents(id),
                PRIMARY KEY(run_id,document_id));
            CREATE TABLE IF NOT EXISTS edits(document_id TEXT REFERENCES documents(id),position INTEGER NOT NULL,
                content TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(document_id,position));
        ''')
        # Existing user libraries predate song/run metadata.
        run_columns={row['name'] for row in self.db.execute('PRAGMA table_info(runs)')}
        if 'metadata' not in run_columns: self.db.execute("ALTER TABLE runs ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}' ")
        song_columns={row['name'] for row in self.db.execute('PRAGMA table_info(songs)')}
        if 'deleted' not in song_columns: self.db.execute('ALTER TABLE songs ADD COLUMN deleted TEXT')
        with self.transaction() as db:
            db.execute('INSERT OR IGNORE INTO setlists VALUES(?,?,?)', ('default','Default',now()))
            db.execute('INSERT OR IGNORE INTO settings VALUES(?,?)', ('device','auto'))
            for key,value in confidence_defaults().items():
                db.execute('INSERT OR IGNORE INTO settings VALUES(?,?)',(key,str(value)))
            for key,value in opacity_defaults().items():
                db.execute('INSERT OR IGNORE INTO settings VALUES(?,?)',(key,str(value)))
    
    def song_metadata(self, song_id):
        # Creating defaults owns a transaction, or participates in the caller's.
        # A read must never leave an implicit write transaction behind.
        with self.transaction():
            self.song(song_id)
            row=self.db.execute('SELECT metadata,metadata_revision FROM song_metadata WHERE song_id=?',(song_id,)).fetchone()
            if row is None:
                self.db.execute('INSERT OR IGNORE INTO song_metadata(song_id,metadata) VALUES(?,?)',(song_id,json.dumps(metadata_defaults())))
                row=self.db.execute('SELECT metadata,metadata_revision FROM song_metadata WHERE song_id=?',(song_id,)).fetchone()
            try: value=json.loads(row['metadata'])
            except (TypeError,ValueError): value=metadata_defaults()
            return dict(validate_song_metadata(value), revision=row['metadata_revision'])

    def save_song_metadata(self, song_id, value, revision=None):
        cleaned=validate_song_metadata(value)
        with self.transaction() as db:
            self.song(song_id)
            current=self.song_metadata(song_id)
            if revision is not None and (type(revision) is not int or revision != current['revision']):
                raise ValueError('Song metadata changed. Reload it before editing again.')
            next_revision=current['revision']+1
            db.execute('INSERT OR REPLACE INTO song_metadata(song_id,metadata,metadata_revision) VALUES(?,?,?)',
                       (song_id,json.dumps(cleaned,allow_nan=False,separators=(',',':')),next_revision))
        return self.song_metadata(song_id)

    @contextmanager
    def transaction(self, *, immediate=False):
        with self.lock:
            nested=self.db.in_transaction
            savepoint='nested_'+uuid.uuid4().hex
            self.db.execute('SAVEPOINT '+savepoint if nested else ('BEGIN IMMEDIATE' if immediate else 'BEGIN'))
            try:
                yield self.db
            except BaseException:
                if nested:
                    self.db.execute('ROLLBACK TO '+savepoint)
                    self.db.execute('RELEASE '+savepoint)
                else:self.db.rollback()
                raise
            else:
                if nested:self.db.execute('RELEASE '+savepoint)
                else:
                    try:self.db.commit()
                    except BaseException:self.db.rollback();raise

    def close(self):
        with self.lock:
            self.db.close()

    def recover_interrupted(self):
        with self.transaction() as db:
            db.execute("UPDATE songs SET status='interrupted',error='Transcription was interrupted. You can try again.' WHERE status='transcribing'")
            db.execute("UPDATE runs SET status='interrupted' WHERE status='transcribing'")

    def contained(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root) or path == self.root:
            raise ValueError('Invalid library path')
        return path

    def song(self, song_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM songs WHERE id=?',(song_id,)).fetchone()
            if row is None:
                raise KeyError('Song not found')
            return dict(row)

    def source_path(self, song_id):
        return self.contained(Path(self.song(song_id)['folder']) / 'source.mp3')

    def folder(self, song_id):
        return self.contained(self.song(song_id)['folder'])

    def state(self):
        with self.lock:
            return {'songs':[dict(r) for r in self.db.execute('SELECT * FROM songs WHERE deleted IS NULL ORDER BY created')],
                    'trash':self.trash(),
                    'setlists':[self.setlist(r['id']) for r in self.db.execute("SELECT id FROM setlists ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END,created")],
                    'settings':self.read_settings(),
                    'root':str(self.root)}

    def import_audio(self, filename, data, setlist_id='default'):
        if not isinstance(filename,str) or not filename or Path(filename).name != filename or PureWindowsPath(filename).name != filename or any(c in filename for c in '\\/:\x00'):
            raise ValueError('Choose a file name without folder paths')
        if Path(filename).suffix.lower() != '.mp3':
            raise ValueError('Please choose an MP3 file')
        if not data or len(data) > 250 * 1024 * 1024:
            raise ValueError('Choose an MP3 smaller than 250 MB')
        try:
            audio = MP3(io.BytesIO(data))
        except Exception as exc:
            raise ValueError('This file could not be read as an MP3') from exc
        def tag(key):
            frame = audio.tags.get(key) if audio.tags else None
            if frame is None:
                return ''
            return next((str(value).strip() for value in getattr(frame,'text',[str(frame)])
                         if str(value).strip()),'')
        title, artist = tag('TIT2') or Path(filename).stem, tag('TPE1')
        if self.project is not None:validate_project(self.project)
        validate_song(self.root,self.root/('a'*12))
        with self.lock:
            self.setlist(setlist_id)
            used=lambda ident:self.db.execute('SELECT 1 FROM songs WHERE id=? OR folder=?',(ident,ident)).fetchone()
            with reserve_directory(self.root,12,used) as path:
                song_id=folder=path.name
                try:
                    with self.transaction() as db:
                        with (path/'source.mp3').open('xb') as stream:stream.write(data)
                        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                            (song_id,title,artist,filename,audio.info.length,folder,'imported',None,None,now()))
                        for sid in dict.fromkeys(['default',setlist_id]):self._add(db,sid,song_id)
                except BaseException:
                    (path/'source.mp3').unlink(missing_ok=True)
                    raise

        return self.song(song_id)

    def rename_song(self,song_id,title):
        title = self.clean_name(title)
        with self.transaction() as db:
            self.song(song_id)
            db.execute('UPDATE songs SET title=? WHERE id=?',(title,song_id))
        return self.song(song_id)

    # ---- Deleting a song: first to the Trash (hidden everywhere, files and history untouched, fully restorable),
    # then, only on request, forever. The Trash keeps a song's place in its set lists, so Restore puts it back where it was.
    def trash(self):
        with self.lock:
            return [{k:r[k] for k in ('id','title','artist','filename','duration','deleted')} for r in self.db.execute('SELECT * FROM songs WHERE deleted IS NOT NULL ORDER BY deleted DESC')]

    def trash_song(self,song_id):
        with self.transaction() as db:
            row=db.execute('SELECT deleted FROM songs WHERE id=?',(song_id,)).fetchone()
            if row is None:raise KeyError('Song not found')
            if row['deleted'] is None:db.execute('UPDATE songs SET deleted=? WHERE id=?',(now(),song_id))
        return self.song(song_id)

    def restore_song(self,song_id):
        with self.transaction() as db:
            if db.execute('SELECT 1 FROM songs WHERE id=?',(song_id,)).fetchone() is None:raise KeyError('Song not found')
            db.execute('UPDATE songs SET deleted=NULL WHERE id=?',(song_id,))
        return self.song(song_id)

    def purge_song(self,song_id):
        """Delete a trashed song's recording, charts, edit history, stems and analysis from this computer. Cannot be undone."""
        with self.lock:
            row=self.db.execute('SELECT * FROM songs WHERE id=?',(song_id,)).fetchone()
        if row is None:raise KeyError('Song not found')
        if row['deleted'] is None:raise ValueError('Move the song to the Trash before deleting it forever.')
        folder=self.contained(row['folder'])
        with self.transaction() as db:
            present={r['name'] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            def delete(table,where,args):
                if table in present:db.execute(f'DELETE FROM {table} WHERE {where}',args)
            documents=[r['id'] for r in db.execute('SELECT id FROM documents WHERE song_id=?',(song_id,))]
            runs=[r['id'] for r in db.execute('SELECT id FROM runs WHERE song_id=?',(song_id,))]
            for document in documents:
                for table in ('edits','timing_bindings','retained_documents'):delete(table,'document_id=?',(document,))
            for run in runs:delete('retained_documents','run_id=?',(run,))
            delete('documents','song_id=?',(song_id,));delete('runs','song_id=?',(song_id,))
            delete('analysis_stages','song_id=?',(song_id,));delete('analysis_invalidations','song_id=?',(song_id,))
            try:delete('analysis_jobs',"json_extract(snapshot,'$.song_id')=?",(song_id,))
            except Exception:pass   # SQLite without JSON support: finished job summaries are harmless to keep
            delete('song_separations','song_id=?',(song_id,));delete('separation_runs','song_id=?',(song_id,))
            delete('song_metadata','song_id=?',(song_id,));delete('memberships','song_id=?',(song_id,))
            db.execute('DELETE FROM songs WHERE id=?',(song_id,))
        warning=None
        try:
            if folder.exists():shutil.rmtree(folder)
        except OSError as exc:
            warning=f'The song was removed, but some of its files could not be deleted yet ({exc.strerror or exc}). They are harmless and can be deleted by hand: {folder}'
        return {'purged':True,'id':song_id,'warning':warning}

    @staticmethod
    def clean_name(name):
        if not isinstance(name,str) or not name.strip() or len(name.strip())>200 or '\x00' in name:
            raise ValueError('Enter a name between 1 and 200 characters')
        return name.strip()

    def setlist(self,setlist_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM setlists WHERE id=?',(setlist_id,)).fetchone()
            if row is None:
                raise KeyError('Set list not found')
            return {'id':row['id'],'name':row['name'],'song_ids':[r['song_id'] for r in self.db.execute('SELECT m.song_id FROM memberships m JOIN songs s ON s.id=m.song_id WHERE m.setlist_id=? AND s.deleted IS NULL ORDER BY m.position',(setlist_id,))]}

    def create_setlist(self,name):
        name = self.clean_name(name)
        setlist_id = uuid.uuid4().hex[:12]
        try:
            with self.transaction() as db:
                db.execute('INSERT INTO setlists VALUES(?,?,?)',(setlist_id,name,now()))
        except sqlite3.IntegrityError as exc:
            raise ValueError('A set list with this name already exists') from exc
        return self.setlist(setlist_id)

    def _add(self,db,setlist_id,song_id):
        position = db.execute('SELECT COALESCE(MAX(position),-1)+1 FROM memberships WHERE setlist_id=?',(setlist_id,)).fetchone()[0]
        db.execute('INSERT OR IGNORE INTO memberships VALUES(?,?,?)',(setlist_id,song_id,position))

    def add_to_setlist(self,setlist_id,song_id):
        with self.transaction() as db:
            self.setlist(setlist_id)
            self.song(song_id)
            self._add(db,setlist_id,song_id)
        return self.setlist(setlist_id)

    def reorder_setlist(self,setlist_id,song_ids):
        with self.transaction() as db:
            existing = self.setlist(setlist_id)['song_ids']
            if not isinstance(song_ids,list) or any(not isinstance(song_id,str) for song_id in song_ids) or len(song_ids)!=len(existing) or set(song_ids)!=set(existing):
                raise ValueError('The reordered set list must contain each song exactly once')
            for i,song_id in enumerate(song_ids):
                db.execute('UPDATE memberships SET position=? WHERE setlist_id=? AND song_id=?',(i,setlist_id,song_id))
        return self.setlist(setlist_id)

    def read_settings(self):
        with self.lock:
            values={r['key']:r['value'] for r in self.db.execute('SELECT * FROM settings')}
            return dict(validate_confidence_settings({k:int(values.get(k,v)) for k,v in confidence_defaults().items()}),
                        **validate_opacity_settings({k:int(values.get(k,v)) for k,v in opacity_defaults().items()}),
                        device=values.get('device','auto'))

    PREF_KEY=re.compile(r'cb-[a-z0-9:_.-]{1,80}')

    def read_prefs(self):
        """Small interface preferences (theme, folded panels, a song's key) kept with the library, so they survive every launch."""
        with self.lock:
            return {r['key'][3:]:r['value'] for r in self.db.execute("SELECT * FROM settings WHERE key LIKE 'ui.%'")}

    def write_prefs(self,values):
        if not isinstance(values,dict) or len(values)>40:raise ValueError('Expected a few preferences')
        for key,value in values.items():
            if not isinstance(key,str) or not self.PREF_KEY.fullmatch(key) or not isinstance(value,str) or len(value)>200:raise ValueError('Unknown preference')
        with self.transaction() as db:
            for key,value in values.items():db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',('ui.'+key,value))
            if db.execute("SELECT COUNT(*) FROM settings WHERE key LIKE 'ui.%'").fetchone()[0]>500:raise ValueError('Too many saved preferences')
        return self.read_prefs()

    def settings(self,values):
        if isinstance(values,str):
            values={'device':values}
        if not isinstance(values,dict) or set(values)-({'device'}|set(confidence_defaults())|set(opacity_defaults())):
            raise ValueError('Unknown setting')
        with self.transaction() as db:
            merged=dict(self.read_settings(),**values)
            if merged['device'] not in ('auto','cpu','cuda'):
                raise ValueError('Choose Automatic, NVIDIA GPU Only, or CPU Only')
            validated=validate_confidence_settings({k:merged[k] for k in confidence_defaults()})
            result=dict(validated,**validate_opacity_settings({k:merged[k] for k in opacity_defaults()}),device=merged['device'])
            for key,value in result.items():
                db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',(key,str(value)))
            return result

    def validate_song_paths(self,song_id):
        if self.project is not None:validate_project(self.project)
        validate_song(self.root,self.folder(song_id))

    def create_analysis_directory(self,song_id):
        with self.lock:
            self.validate_song_paths(song_id)
            with reserve_directory(self.contained(self.folder(song_id)/'analysis'),32) as path:return path

    def create_run(self,song_id):
        with self.lock:
            self.validate_song_paths(song_id)
            used=lambda ident:self.db.execute('SELECT 1 FROM runs WHERE id=?',(ident,)).fetchone()
            with reserve_directory(self.contained(self.folder(song_id)/'runs'),12,used) as path:
                with self.transaction() as db:
                    metadata=self.song_metadata(song_id)
                    db.execute('INSERT INTO runs(id,song_id,created,status,error,metadata) VALUES(?,?,?,?,?,?)',
                               (path.name,song_id,now(),'transcribing',None,json.dumps(metadata,allow_nan=False)))
                    db.execute("UPDATE songs SET status='transcribing',error=NULL WHERE id=?",(song_id,))
            return path

    def finish_run(self,song_id,run_id,status,error,clear_metadata=False):
        with self.transaction() as db:
            db.execute('UPDATE runs SET status=?,error=? WHERE id=? AND song_id=?',(status,error,run_id,song_id))
            has_docs = db.execute('SELECT 1 FROM documents WHERE run_id=?',(run_id,)).fetchone()
            if has_docs and status in ('complete','completed'):
                if clear_metadata:
                    db.execute('UPDATE songs SET status=?,error=?,active_run=? WHERE id=?',(status,error,run_id,song_id))
                    current=self.song_metadata(song_id)
                    db.execute('UPDATE song_metadata SET metadata=?,metadata_revision=? WHERE song_id=?',
                               (json.dumps(metadata_defaults(),allow_nan=False),current['revision']+1,song_id))
                else:
                    db.execute('UPDATE songs SET status=?,error=?,active_run=? WHERE id=?',(status,error,run_id,song_id))
            else:
                db.execute('UPDATE songs SET status=?,error=? WHERE id=?',(status,error,song_id))

    def runs(self,song_id):
        with self.lock:
            self.song(song_id)
            return [dict(dict(r),has_documents=bool(self.db.execute('SELECT 1 FROM documents WHERE run_id=?',(r['id'],)).fetchone()))
                    for r in self.db.execute('SELECT * FROM runs WHERE song_id=? ORDER BY created DESC',(song_id,))]

    def activate_run(self,song_id,run_id):
        with self.transaction() as db:
            self.song(song_id)
            run=db.execute('SELECT * FROM runs WHERE id=? AND song_id=?',(run_id,song_id)).fetchone()
            if not run or run['status']=='transcribing' or not db.execute('SELECT 1 FROM documents WHERE run_id=?',(run_id,)).fetchone():
                raise ValueError('Choose a registered run with transcription documents')
            try: archived=validate_song_metadata(json.loads(run['metadata']))
            except (TypeError,ValueError): archived=metadata_defaults()
            db.execute('UPDATE songs SET active_run=?,status=?,error=? WHERE id=?',(run_id,run['status'],run['error'],song_id))
            current=self.song_metadata(song_id)
            db.execute('UPDATE song_metadata SET metadata=?,metadata_revision=? WHERE song_id=?',
                       (json.dumps(archived,allow_nan=False),current['revision']+1,song_id))
            return self.song(song_id)


