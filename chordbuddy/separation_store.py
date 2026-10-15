"""Independent separation history: never mutates transcription documents."""
import json
import re
import threading
from pathlib import Path
from .library import now
from .path_policy import reserve_directory
from .separation_contract import ACTIVE,SCHEMA_VERSION,TRACKS,file_hash

class SeparationStore:
    def __init__(self,library,recipe_provider=None):
        self.library=library
        self.recipe_provider=recipe_provider
        self._verified={}
        self._verify_lock=threading.RLock()
        with library.transaction() as db:
            schema="""
            CREATE TABLE IF NOT EXISTS separation_runs(
              id TEXT PRIMARY KEY,song_id TEXT NOT NULL REFERENCES songs(id),status TEXT NOT NULL,
              stage TEXT NOT NULL,progress TEXT,error TEXT,recipe_sha256 TEXT NOT NULL,
              source_sha256 TEXT,folder TEXT NOT NULL,created TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS song_separations(
              song_id TEXT PRIMARY KEY REFERENCES songs(id),active_id TEXT REFERENCES separation_runs(id));
            """
            for statement in schema.split(';'):
                if statement.strip():db.execute(statement)
    def safe_path(self,path):
        root=self.library.root.resolve();path=Path(path)
        if not path.is_absolute():path=root/path
        result=path.resolve()
        if result==root or not result.is_relative_to(root):raise ValueError('Invalid separation path')
        return result
    def _run(self,run_id):
        if not isinstance(run_id,str) or not re.fullmatch('[a-f0-9]{32}',run_id):raise KeyError('Unknown separation run')
        with self.library.lock:
            row=self.library.db.execute('SELECT * FROM separation_runs WHERE id=?',(run_id,)).fetchone()
        if row is None:raise KeyError('Unknown separation run')
        return dict(row)
    def snapshot(self,row):
        if not row:return None
        return {**{k:row[k] for k in ('id','song_id','status','stage','error')},'kind':'separation','progress':json.loads(row['progress']) if row['progress'] else None,'message':row['error'] or row['stage'].capitalize()}
    def create_run(self,song_id,recipe_sha256):
        with self.library.lock:
            self.library.validate_song_paths(song_id)
            used=lambda ident:self.library.db.execute('SELECT 1 FROM separation_runs WHERE id=?',(ident,)).fetchone()
            with reserve_directory(self.safe_path(self.library.folder(song_id)/'separation'),32,used) as path:
                run_id=path.name;folder=path.relative_to(self.library.root)
                with self.library.transaction() as db:
                    db.execute('INSERT INTO separation_runs VALUES(?,?,?,?,?,?,?,?,?,?)',(run_id,song_id,'preparing','preparing',None,None,recipe_sha256,None,str(folder),now()))
        return self._run(run_id)
    def update_progress(self,run_id,stage,progress=None):
        if stage not in ACTIVE-{'cancelling'}:raise ValueError('Invalid stage')
        with self.library.transaction() as db:
            db.execute("UPDATE separation_runs SET status=?,stage=?,progress=? WHERE id=? AND status IN ('preparing','separating','refining','validating')",(stage,stage,json.dumps(progress) if progress else None,run_id))
    def request_cancel(self,run_id):
        self._run(run_id)
        with self.library.transaction() as db:
            db.execute("UPDATE separation_runs SET status='cancelling',stage='cancelling' WHERE id=? AND status IN ('preparing','separating','refining','validating')",(run_id,))
        return self.snapshot(self._run(run_id))
    def fail_run(self,run_id,status,error):
        if status not in ('failed','cancelled','interrupted'):raise ValueError('Invalid terminal status')
        with self.library.transaction() as db:
            db.execute("UPDATE separation_runs SET status=?,stage=?,error=? WHERE id=? AND status!='completed'",(status,status,str(error),run_id))
    def recover_interrupted(self):
        with self.library.transaction() as db:
            db.execute("UPDATE separation_runs SET status='interrupted',stage='interrupted',error='Separation was interrupted. Retry when ready.' WHERE status IN ('preparing','separating','refining','validating','cancelling')")
    def activate_validated(self,run_id,manifest):
        run=self._run(run_id)
        if run['status']!='validating':raise ValueError('Run is not ready to publish')
        if manifest['source_sha256']!=file_hash(self.library.source_path(run['song_id'])):raise ValueError('Source audio changed during separation')
        root=self.safe_path(run['folder'])
        manifest.update(schema_version=SCHEMA_VERSION,run_id=run_id,song_id=run['song_id'])
        (root/'manifest.json').write_text(json.dumps(manifest,indent=2,allow_nan=False),encoding='utf-8')
        # Finish every fallible artifact read before the publication transaction.
        with self._verify_lock:
            self._verified.pop(run_id,None)
            validated=self._validate_run(run,fresh_source=True)
        # The database status is the publication boundary; avoid renaming a live directory.
        relative=str(root.relative_to(self.library.root))
        with self.library.transaction() as db:
            # Cancellation wins even if requested while finalizing artifacts.
            current=db.execute('SELECT status FROM separation_runs WHERE id=?',(run_id,)).fetchone()
            if current['status']!='validating':raise ValueError('Run was cancelled before activation')
            db.execute("UPDATE separation_runs SET status='completed',stage='completed',folder=?,source_sha256=?,progress=NULL WHERE id=?",(relative,manifest['source_sha256'],run_id))
            db.execute('INSERT OR REPLACE INTO song_separations VALUES(?,?)',(run['song_id'],run_id))
        return validated
    def get_published_run(self,run_id):
        with self._verify_lock:
            return self._get_published_run(run_id)
    def _get_published_run(self,run_id):
        run=self._run(run_id)
        if run['status']!='completed':raise KeyError('Separation is not published')
        return self._validate_run(run)
    def _validate_run(self,run,fresh_source=False):
        run_id=run['id']
        root=self.safe_path(run['folder']);path=self.safe_path(root/'manifest.json')
        manifest=json.loads(path.read_text(encoding='utf-8'))
        if manifest.get('schema_version')!=SCHEMA_VERSION or manifest.get('run_id')!=run_id or manifest.get('song_id')!=run['song_id']:raise ValueError('Invalid separation manifest')
        if [a.get('role') for a in manifest['assets']]!=list(TRACKS):raise ValueError('Invalid playback roles')
        source=self.library.source_path(run['song_id'])
        paths=[source,path]+[self.safe_path(root/a['relative_path']) for a in manifest['assets']]
        stamps=tuple((str(p),p.stat().st_mtime_ns,p.stat().st_size) for p in paths)
        changed=self._verified.get(run_id)!=stamps
        if (fresh_source or changed) and file_hash(source)!=manifest['source_sha256']:
            raise ValueError('Source changed; separation is stale')
        if changed:
            for a,p in zip(manifest['assets'],paths[2:]):
                if not p.is_relative_to(root) or file_hash(p)!=a['file_sha256']:raise ValueError('Separation audio is missing or corrupt')
            self._verified[run_id]=stamps
        return root,manifest
    def public_manifest(self,manifest):
        return {k:manifest[k] for k in ('schema_version','run_id','song_id','sample_rate','channels','frames','common_gain','recipe_sha256')}
    def get_song_state(self,song_id):
        self.library.song(song_id)
        with self.library.lock:
            row=self.library.db.execute('SELECT * FROM separation_runs WHERE song_id=? ORDER BY rowid DESC LIMIT 1',(song_id,)).fetchone()
            active=self.library.db.execute('SELECT active_id FROM song_separations WHERE song_id=?',(song_id,)).fetchone()
        result={'job':self.snapshot(dict(row)) if row else None,'active':None,'availability':'absent','error':None}
        if active:
            try:
                with self._verify_lock:
                    run=self._run(active['active_id'])
                    if run['status']!='completed':raise KeyError('Separation is not published')
                    _,manifest=self._validate_run(run,fresh_source=True)
                if self.recipe_provider and manifest['recipe_sha256']!=self.recipe_provider():
                    raise ValueError('Separation recipe changed; separate this song again')
                result.update(active=self.public_manifest(manifest),availability='ready')
            except (OSError,ValueError,KeyError) as exc:result.update(availability='stale',error=str(exc))
        return result

