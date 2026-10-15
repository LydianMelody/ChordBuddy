"""Immutable timing versions with chart-position bindings, never a global selector."""
import copy
import json
import math
from pathlib import Path
from .analysis_contract import digest

class TimingStore:
    def __init__(self,library):
        self.library=library
        with library.transaction() as db:
            # executescript commits an outer transaction before running DDL.
            db.execute('CREATE TABLE IF NOT EXISTS timing_versions(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS timing_bindings(document_id TEXT REFERENCES documents(id),position INTEGER,\n                binding TEXT NOT NULL,PRIMARY KEY(document_id,position))')

    def put_version(self,value):
        value=copy.deepcopy(value);value.pop('id',None)
        bars=value.get('bars',[])
        if not bars:raise ValueError('No timing grid is available')
        previous=-1;ids=set()
        for bar in bars:
            points=bar['beats']+[bar['end']]
            if bar['id'] in ids or not all(type(t) in (int,float) and math.isfinite(t) for t in points):raise ValueError('Invalid timing grid')
            if bar['start']!=points[0] or bar['start']<previous or any(b<=a for a,b in zip(points,points[1:])):raise ValueError('Timing grid crosses or reverses')
            previous=bar['end'];ids.add(bar['id'])
        ident=digest(value)
        with self.library.transaction() as db:db.execute('INSERT OR IGNORE INTO timing_versions VALUES(?,?)',(ident,json.dumps(value,allow_nan=False)))
        return ident

    def version(self,ident):
        with self.library.lock:row=self.library.db.execute('SELECT value FROM timing_versions WHERE id=?',(ident,)).fetchone()
        if not row:raise ValueError('Timing version unavailable')
        value=json.loads(row[0])
        if digest(value)!=ident:raise ValueError('Timing version changed')
        return dict(value,id=ident)

    def binding(self,document_id,position):
        with self.library.lock:
            row=self.library.db.execute('SELECT binding FROM timing_bindings WHERE document_id=? AND position=?',(document_id,position)).fetchone()
            if row:return json.loads(row[0])
            doc=self.library.db.execute('SELECT * FROM documents WHERE id=?',(document_id,)).fetchone()
            song=self.library.song(doc['song_id'])
            path=self.library.contained(Path(song['folder'])/'runs'/doc['run_id']/'run-options.json')
            try:options=json.loads(path.read_text(encoding='utf-8'))
            except (OSError,ValueError):options={}
            # Current legacy active chart reflects current settings; retained history
            # uses captured run settings and exposes unresolved provenance otherwise.
            if doc['run_id']==song['active_run'] and position==doc['cursor']:
                overrides=self.library.song_metadata(song['id']).get('timing',{})
                known=True
            else:
                overrides=options.get('metadata',{}).get('timing',{})
                known=False  # Inference options do not prove later manual history.
            return {'version_id':'legacy:'+doc['run_id'],'overrides':overrides,'legacy_provenance_known':known}

    def record_binding(self,db,document_id,position,binding):
        db.execute('INSERT OR REPLACE INTO timing_bindings VALUES(?,?,?)',(document_id,position,json.dumps(binding,allow_nan=False)))
