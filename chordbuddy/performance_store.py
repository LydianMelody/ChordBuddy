from __future__ import annotations
import json
import re
import uuid
from datetime import datetime, timezone

from .documents import RevisionConflict

MAX_BODY=2*1024*1024
MAX_DEPTH=32
MAX_ITEMS=20000
MAX_ENTRIES=500
SCHEMA=1
ID=re.compile(r'[A-Za-z0-9_-]{1,64}')
TABLES='''
    CREATE TABLE IF NOT EXISTS performances(id TEXT PRIMARY KEY,song_id TEXT NOT NULL REFERENCES songs(id),name TEXT NOT NULL,
        head INTEGER NOT NULL,draft TEXT,draft_base INTEGER,created TEXT NOT NULL,updated TEXT NOT NULL,deleted TEXT);
    CREATE TABLE IF NOT EXISTS performance_revisions(performance_id TEXT NOT NULL REFERENCES performances(id),revision INTEGER NOT NULL,
        body TEXT NOT NULL,saved TEXT NOT NULL,PRIMARY KEY(performance_id,revision));
    CREATE INDEX IF NOT EXISTS performances_by_song ON performances(song_id);
    CREATE TABLE IF NOT EXISTS shows(id TEXT PRIMARY KEY,name TEXT NOT NULL,head INTEGER NOT NULL,draft TEXT,draft_base INTEGER,
        created TEXT NOT NULL,updated TEXT NOT NULL,deleted TEXT);
    CREATE TABLE IF NOT EXISTS show_revisions(show_id TEXT NOT NULL REFERENCES shows(id),revision INTEGER NOT NULL,
        body TEXT NOT NULL,saved TEXT NOT NULL,PRIMARY KEY(show_id,revision));
'''


def now():
    return datetime.now(timezone.utc).isoformat()


def _measure(value,depth=0,counter=None):
    """Refuses JSON too deep or too large to be something the editor made. What each action means is checked by performance-actions.js."""
    counter=counter if counter is not None else [0]
    counter[0]+=1
    if depth>MAX_DEPTH or counter[0]>MAX_ITEMS:raise ValueError('This performance is too large to save.')
    if isinstance(value,dict):
        for key,item in value.items():
            if not isinstance(key,str):raise ValueError('This performance is not valid.')
            _measure(item,depth+1,counter)
    elif isinstance(value,list):
        for item in value:_measure(item,depth+1,counter)
    elif not (value is None or isinstance(value,(str,int,float,bool))):raise ValueError('This performance is not valid.')


def _encode(body):
    _measure(body)
    text=json.dumps(body,ensure_ascii=False,allow_nan=False,separators=(',',':'))
    if len(text.encode('utf-8'))>MAX_BODY:raise ValueError('This performance is too large to save.')
    return text


def _check_id(value,what):
    if not isinstance(value,str) or not ID.fullmatch(value):raise ValueError(f'This {what} has an invalid identifier.')
    return value


class PerformanceStore:
    """Saved arrangements of a song, and shows made of them. Every save is a new revision that is never changed again, so a show can pin the
    exact arrangement it was checked with. Saving against an old revision is refused (RevisionConflict), never merged or overwritten. A draft
    is the unsaved work on top of a revision. Deleting hides a record: revisions stay, so a show that pinned one still resolves.
    The frontend's performance-model.js describes what's inside a body."""
    def __init__(self,library):
        self.library=library
        with library.lock:
            library.db.executescript(TABLES)

    # ---- one song's performances
    def _performance_body(self,body):
        if not isinstance(body,dict) or body.get('schema')!=SCHEMA:raise ValueError('This performance was made by a different version of Chord Buddy.')
        _check_id(body.get('id'),'performance');_check_id(body.get('songId'),'song')
        for key in ('initial','cues','regions','jumps','holds'):
            if not isinstance(body.get(key),list):raise ValueError('This performance is not valid.')
        body['name']=self.library.clean_name(body.get('name'))
        return body

    def save_performance(self,body,base):
        """base: the revision this edit started from, 0 for a new one. Returns the record with its new revision."""
        body=self._performance_body(body);text=_encode(body);stamp=now()
        if type(base) is not int or base<0:raise ValueError('Save needs the revision it started from.')
        with self.library.transaction(immediate=True) as db:
            self.library.song(body['songId'])
            row=db.execute('SELECT * FROM performances WHERE id=?',(body['id'],)).fetchone()
            if row is None:
                if base!=0:raise RevisionConflict('This performance was deleted. Save it as a new one.')
                db.execute('INSERT INTO performances VALUES(?,?,?,?,?,?,?,?,?)',(body['id'],body['songId'],body['name'],1,None,None,stamp,stamp,None))
                revision=1
            else:
                if row['song_id']!=body['songId']:raise ValueError('A performance belongs to one song.')
                if row['deleted']:raise RevisionConflict('This performance was deleted. Save it as a new one.')
                if row['head']!=base:raise RevisionConflict('This performance changed in another window. Reload it to see those changes.')
                revision=base+1
                db.execute('UPDATE performances SET name=?,head=?,draft=NULL,draft_base=NULL,updated=? WHERE id=?',(body['name'],revision,stamp,body['id']))
            db.execute('INSERT INTO performance_revisions VALUES(?,?,?,?)',(body['id'],revision,text,stamp))
        return self.performance(body['id'])

    def save_performance_draft(self,body,base):
        body=self._performance_body(body);text=_encode(body)
        with self.library.transaction(immediate=True) as db:
            row=db.execute('SELECT head,deleted FROM performances WHERE id=?',(body['id'],)).fetchone()
            if row is None or row['deleted']:raise KeyError('Performance not found')
            if row['head']!=base:raise RevisionConflict('This performance changed in another window. Reload it to see those changes.')
            db.execute('UPDATE performances SET draft=?,draft_base=?,updated=? WHERE id=?',(text,base,now(),body['id']))
        return {'saved':True,'base':base}

    def performance(self,performance_id,revision=None):
        with self.library.lock:
            db=self.library.db
            row=db.execute('SELECT * FROM performances WHERE id=?',(performance_id,)).fetchone()
            if row is None:raise KeyError('Performance not found')
            want=row['head'] if revision is None else revision
            saved=db.execute('SELECT body,saved FROM performance_revisions WHERE performance_id=? AND revision=?',(performance_id,want)).fetchone()
            if saved is None:raise KeyError('That revision of the performance is not available')
            return {'id':row['id'],'song_id':row['song_id'],'name':row['name'],'head':row['head'],'revision':want,'saved':saved['saved'],
                    'deleted':bool(row['deleted']),'body':json.loads(saved['body']),
                    'draft':json.loads(row['draft']) if row['draft'] and revision is None else None,'draft_base':row['draft_base'] if revision is None else None}

    def performances_for_song(self,song_id):
        with self.library.lock:
            self.library.song(song_id)
            rows=self.library.db.execute('SELECT id,name,head,updated,draft IS NOT NULL AS has_draft FROM performances WHERE song_id=? AND deleted IS NULL ORDER BY name COLLATE NOCASE',(song_id,)).fetchall()
            return [{'id':r['id'],'name':r['name'],'head':r['head'],'updated':r['updated'],'has_draft':bool(r['has_draft'])} for r in rows]

    def delete_performance(self,performance_id):
        with self.library.transaction() as db:
            if not db.execute('UPDATE performances SET deleted=?,draft=NULL,draft_base=NULL WHERE id=? AND deleted IS NULL',(now(),performance_id)).rowcount:raise KeyError('Performance not found')
        return {'deleted':True}

    # ---- shows
    def _show_body(self,body):
        if not isinstance(body,dict) or body.get('schema')!=SCHEMA:raise ValueError('This show was made by a different version of Chord Buddy.')
        _check_id(body.get('id'),'show')
        entries=body.get('entries')
        if not isinstance(entries,list) or len(entries)>MAX_ENTRIES:raise ValueError('This show is not valid.')
        seen=set()
        for entry in entries:
            if not isinstance(entry,dict):raise ValueError('This show is not valid.')
            ident=_check_id(entry.get('id'),'show entry')
            if ident in seen:raise ValueError('Each show entry needs its own identifier.')
            seen.add(ident)
            _check_id(entry.get('songId'),'song')
            if entry.get('performanceId') is not None:
                _check_id(entry['performanceId'],'performance')
                if type(entry.get('revision')) is not int or entry['revision']<1:raise ValueError('A show entry must name a saved revision.')
        body['name']=self.library.clean_name(body.get('name'))
        return body

    def _check_entries(self,db,body):
        for entry in body['entries']:
            self.library.song(entry['songId'])
            if entry.get('performanceId') is None:continue         # the Original arrangement
            row=db.execute('SELECT p.song_id FROM performance_revisions r JOIN performances p ON p.id=r.performance_id WHERE r.performance_id=? AND r.revision=?',(entry['performanceId'],entry['revision'])).fetchone()
            if row is None:raise ValueError('A show entry names a performance revision that is not saved.')
            if row['song_id']!=entry['songId']:raise ValueError('A show entry names a performance of a different song.')

    def save_show(self,body,base):
        body=self._show_body(body);text=_encode(body);stamp=now()
        if type(base) is not int or base<0:raise ValueError('Save needs the revision it started from.')
        with self.library.transaction(immediate=True) as db:
            self._check_entries(db,body)
            row=db.execute('SELECT * FROM shows WHERE id=?',(body['id'],)).fetchone()
            if row is None:
                if base!=0:raise RevisionConflict('This show was deleted. Save it as a new one.')
                db.execute('INSERT INTO shows VALUES(?,?,?,?,?,?,?,?)',(body['id'],body['name'],1,None,None,stamp,stamp,None))
                revision=1
            else:
                if row['deleted']:raise RevisionConflict('This show was deleted. Save it as a new one.')
                if row['head']!=base:raise RevisionConflict('This show changed in another window. Reload it to see those changes.')
                revision=base+1
                db.execute('UPDATE shows SET name=?,head=?,draft=NULL,draft_base=NULL,updated=? WHERE id=?',(body['name'],revision,stamp,body['id']))
            db.execute('INSERT INTO show_revisions VALUES(?,?,?,?)',(body['id'],revision,text,stamp))
        return self.show(body['id'])

    def save_show_draft(self,body,base):
        body=self._show_body(body);text=_encode(body)
        with self.library.transaction(immediate=True) as db:
            row=db.execute('SELECT head,deleted FROM shows WHERE id=?',(body['id'],)).fetchone()
            if row is None or row['deleted']:raise KeyError('Show not found')
            if row['head']!=base:raise RevisionConflict('This show changed in another window. Reload it to see those changes.')
            db.execute('UPDATE shows SET draft=?,draft_base=?,updated=? WHERE id=?',(text,base,now(),body['id']))
        return {'saved':True,'base':base}

    def show(self,show_id,revision=None):
        with self.library.lock:
            db=self.library.db
            row=db.execute('SELECT * FROM shows WHERE id=?',(show_id,)).fetchone()
            if row is None:raise KeyError('Show not found')
            want=row['head'] if revision is None else revision
            saved=db.execute('SELECT body,saved FROM show_revisions WHERE show_id=? AND revision=?',(show_id,want)).fetchone()
            if saved is None:raise KeyError('That revision of the show is not available')
            return {'id':row['id'],'name':row['name'],'head':row['head'],'revision':want,'saved':saved['saved'],'deleted':bool(row['deleted']),
                    'body':json.loads(saved['body']),'draft':json.loads(row['draft']) if row['draft'] and revision is None else None,'draft_base':row['draft_base'] if revision is None else None}

    def shows(self):
        with self.library.lock:
            rows=self.library.db.execute('SELECT id,name,head,updated FROM shows WHERE deleted IS NULL ORDER BY name COLLATE NOCASE').fetchall()
            return [{'id':r['id'],'name':r['name'],'head':r['head'],'updated':r['updated']} for r in rows]

    def delete_show(self,show_id):
        with self.library.transaction() as db:
            if not db.execute('UPDATE shows SET deleted=?,draft=NULL,draft_base=NULL WHERE id=? AND deleted IS NULL',(now(),show_id)).rowcount:raise KeyError('Show not found')
        return {'deleted':True}

    # ---- moving a show between libraries: its arrangements come along, the recordings never do
    def export_show(self,show_id):
        record=self.show(show_id)
        songs={};performances=[]
        for entry in record['body']['entries']:
            song=self.library.song(entry['songId'])
            songs[entry['songId']]={'id':entry['songId'],'title':song['title'],'artist':song['artist']}
            if entry.get('performanceId'):
                saved=self.performance(entry['performanceId'],entry['revision'])
                performances.append({'id':entry['performanceId'],'revision':entry['revision'],'body':saved['body']})
        return {'format':'chordbuddy-show','version':SCHEMA,'show':record['body'],'performances':performances,'songs':list(songs.values())}

    def import_show(self,bundle):
        """Brings in a show from an export, under new identifiers, so nothing here is overwritten. Songs are matched by id, and missing ones are reported, not guessed at."""
        if not isinstance(bundle,dict) or bundle.get('format')!='chordbuddy-show':raise ValueError('That isn’t a Chord Buddy show file.')
        if bundle.get('version')!=SCHEMA:raise ValueError('That show was made by a different version of Chord Buddy.')
        _measure(bundle)
        show=bundle.get('show');performances=bundle.get('performances');songs=bundle.get('songs')
        if not isinstance(show,dict) or not isinstance(performances,list) or not isinstance(songs,list):raise ValueError('That isn’t a Chord Buddy show file.')
        missing=[]
        for song in songs:
            if not isinstance(song,dict):raise ValueError('That isn’t a Chord Buddy show file.')
            try:self.library.song(song.get('id'))
            except KeyError:missing.append({'id':song.get('id'),'title':song.get('title')})
        if missing:return {'show_id':None,'missing_songs':missing}
        with self.library.transaction(immediate=True):
            renamed={}
            for item in performances:
                if not isinstance(item,dict) or not isinstance(item.get('body'),dict):raise ValueError('That isn’t a Chord Buddy show file.')
                key=(item.get('id'),item.get('revision'))
                if key in renamed:continue
                body=dict(item['body'],id=self.new_id())
                saved=self.save_performance(body,0)
                renamed[key]=(saved['id'],saved['revision'])
            entries=[]
            for entry in show.get('entries') or []:
                if not isinstance(entry,dict):raise ValueError('That isn’t a Chord Buddy show file.')
                copy=dict(entry,id=self.new_id())
                if entry.get('performanceId'):
                    if (entry['performanceId'],entry.get('revision')) not in renamed:raise ValueError('That show file is missing an arrangement.')
                    copy['performanceId'],copy['revision']=renamed[(entry['performanceId'],entry['revision'])]
                entries.append(copy)
            saved=self.save_show(dict(show,id=self.new_id(),entries=entries,sourceList=None),0)
        return {'show_id':saved['id'],'missing_songs':[]}

    @staticmethod
    def new_id():
        return uuid.uuid4().hex[:16]
