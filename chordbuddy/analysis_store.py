"""Validated immutable stage records and durable parent jobs."""
import json
from .path_policy import COLLISION_ATTEMPTS
from pathlib import Path
from .analysis_contract import digest
from .separation_contract import file_hash

class AnalysisStore:
    def __init__(self,library):
        self.library=library
        with library.transaction() as db:
            # executescript commits an outer transaction before running DDL.
            db.execute('CREATE TABLE IF NOT EXISTS analysis_stages(\n                id TEXT PRIMARY KEY,song_id TEXT NOT NULL REFERENCES songs(id),kind TEXT NOT NULL,\n                dependencies TEXT NOT NULL,manifest TEXT NOT NULL,reference TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS analysis_jobs(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS analysis_invalidations(song_id TEXT,kind TEXT,before_row INTEGER,PRIMARY KEY(song_id,kind))')

    def validate(self,song_id,dependencies,manifest):
        if file_hash(self.library.source_path(song_id))!=dependencies['source_sha256']:
            raise ValueError('Source changed; analyze this song again')
        if not manifest.get('assets'):raise ValueError('Stage has no validated artifacts')
        for asset in manifest['assets']:
            path=Path(asset['path'])
            if path.is_absolute() or '..' in path.parts:raise ValueError('Invalid stage artifact path')
            target=self.library.contained(path)
            if file_hash(target)!=asset['sha256']:raise ValueError('Stage artifact is missing or corrupt')

    def lookup(self,song_id,kind,dependencies):
        with self.library.lock:
            rows=self.library.db.execute('SELECT * FROM analysis_stages WHERE song_id=? AND kind=? AND dependencies=? AND rowid>COALESCE((SELECT before_row FROM analysis_invalidations WHERE song_id=? AND kind=?),0) ORDER BY rowid DESC',
                (song_id,kind,digest(dependencies),song_id,kind)).fetchall()
        for row in rows:
            try:
                manifest=json.loads(row['manifest']);ref=json.loads(row['reference'])
                if digest(manifest)!=ref['manifest_sha256']:continue
                self.validate(song_id,dependencies,manifest)
                return ref
            except (OSError,ValueError,KeyError,TypeError):continue
        return None

    def invalidate(self,song_id,kind):
        with self.library.transaction() as db:
            maximum=db.execute('SELECT COALESCE(MAX(rowid),0) FROM analysis_stages').fetchone()[0]
            db.execute('INSERT OR REPLACE INTO analysis_invalidations VALUES(?,?,?)',(song_id,kind,maximum))

    def publish(self,song_id,kind,dependencies,manifest):
        if kind not in {'source','separation','transcription','chart','rhythm'}:raise ValueError('Invalid stage kind')
        self.validate(song_id,dependencies,manifest)
        with self.library.transaction() as db:
            for _ in range(COLLISION_ATTEMPTS):
                ident=self._new_id()
                if db.execute('SELECT 1 FROM analysis_stages WHERE id=?',(ident,)).fetchone():continue
                ref={'id':ident,'kind':kind,'song_id':song_id,'source_sha256':dependencies['source_sha256'],
                     'recipe_sha256':digest(dependencies),'manifest_sha256':digest(manifest)}
                db.execute('INSERT INTO analysis_stages VALUES(?,?,?,?,?,?)',(ident,song_id,kind,digest(dependencies),json.dumps(manifest,allow_nan=False),json.dumps(ref)))
                return ref
        raise ValueError('Could not allocate a unique analysis stage ID. Retry the operation.')

    @staticmethod
    def _new_id():
        from .path_policy import new_id
        return new_id(32)

    def create_job(self,value):
        # Creation must never use the update/upsert path for a colliding ID.
        with self.library.transaction() as db:
            for _ in range(COLLISION_ATTEMPTS):
                ident=self._new_id()
                if db.execute('SELECT 1 FROM analysis_jobs WHERE id=?',(ident,)).fetchone():continue
                value['id']=ident
                db.execute('INSERT INTO analysis_jobs VALUES(?,?)',(ident,json.dumps(value,allow_nan=False)))
                self.save_job(value)
                return
        raise ValueError('Could not allocate a unique analysis job ID. Retry the operation.')

    def manifest(self,ref):
        with self.library.lock:
            row=self.library.db.execute('SELECT manifest FROM analysis_stages WHERE id=? AND song_id=?',(ref['id'],ref['song_id'])).fetchone()
        if not row:raise ValueError('Stage not found')
        value=json.loads(row[0])
        if digest(value)!=ref['manifest_sha256']:raise ValueError('Stage manifest changed')
        return value

    def save_job(self,value):
        with self.library.transaction() as db:
            db.execute('INSERT OR REPLACE INTO analysis_jobs VALUES(?,?)',(value['id'],json.dumps(value,allow_nan=False)))

    def recover_interrupted(self):
        with self.library.transaction() as db:
            for row in db.execute('SELECT * FROM analysis_jobs').fetchall():
                value=json.loads(row['snapshot'])
                if value['status'] not in {'completed','partial','failed','cancelled','interrupted'}:
                    value.update(status='interrupted',stage='interrupted',error='Work interrupted; completed caches remain available.')
                    db.execute('UPDATE analysis_jobs SET snapshot=? WHERE id=?',(json.dumps(value),row['id']))
