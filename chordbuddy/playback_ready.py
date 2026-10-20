"""Playback is admitted by a complete, source-validated saved analysis bundle."""
import json
import threading
from .analysis_contract import digest
from .separation_contract import file_hash
from . import original_playback as original

STAGES=('source','separation','transcription','chart')
WITHOUT_STEMS=('source','transcription','chart')      # a song analyzed without splitting its stems
ACTIVE={'running','cancelling','starting','preparing','separating','refining','validating','loading','transcribing','exporting'}

class PlaybackReadiness:
    def __init__(self,store,separation):
        self.store=store;self.library=store.library;self.separation=separation
        self.lock=threading.RLock();self.verified={};self.light={};self._hashes={}

    def state(self,song_id,job=None):
        with self.lock:
            return self._state(song_id,job)

    def _source_hash(self,path):
        """The recording's hash, worked out again only when the file changes (this runs on every state refresh)."""
        stat=path.stat();key=(str(path),stat.st_size,stat.st_mtime_ns)
        if key not in self._hashes:
            if len(self._hashes)>64:self._hashes.clear()
            self._hashes[key]=file_hash(path)
        return self._hashes[key]

    def _state(self,song_id,job):
        self.library.song(song_id)
        result={'song_id':song_id,'ready':False,'active':None,'analysis_id':None,
                'reason':'Analyze this song to enable playback and the mixer.'}
        relevant=job if job and job.get('song_id')==song_id and job.get('kind')!='rhythm' else None
        busy=bool(relevant and relevant.get('status') in ACTIVE)
        blocked=dict(result,reason='Analysis in progress. Playback is paused until it finishes.')
        # Splitting the stems of a song that already plays its recording does not stop that recording.
        if busy and relevant.get('kind')!='separation':return blocked
        with self.library.lock:
            jobs=[json.loads(r[0]) for r in self.library.db.execute('SELECT snapshot FROM analysis_jobs ORDER BY rowid DESC')]
        candidates=[j for j in jobs if j.get('song_id')==song_id and j.get('kind')=='analysis' and j.get('status')=='completed']
        latest=next((j for j in jobs if j.get('song_id')==song_id and j.get('kind')=='analysis'),None)
        failed=(relevant or latest or {}).get('status') in {'failed','partial','cancelled','interrupted'}
        if failed:result['reason']='Analysis did not complete. Analyze again to enable playback.'
        source_hash=self._source_hash(self.library.source_path(song_id))
        for job in candidates:
            try:
                manifests={};stems=job.get('stems',True)
                for kind in (STAGES if stems else WITHOUT_STEMS):
                    stage=job['stages'][kind]
                    if stage['status']!='completed':raise ValueError('Incomplete analysis stage')
                    with self.library.lock:
                        row=self.library.db.execute('SELECT manifest,reference FROM analysis_stages WHERE id=? AND song_id=? AND kind=?',(stage['id'],song_id,kind)).fetchone()
                    if not row:raise ValueError('Missing analysis evidence')
                    manifest=json.loads(row['manifest']);ref=json.loads(row['reference'])
                    if ref['source_sha256']!=source_hash or digest(manifest)!=ref['manifest_sha256']:
                        raise ValueError('Analysis source or manifest changed')
                    # Reuse the existing validator; unchanged immutable artifacts are
                    # cached by metadata, while the recording is freshly hashed above.
                    paths=[self.library.contained(a['path']) for a in manifest['assets']]
                    stamp=(ref['manifest_sha256'],tuple((str(p),p.stat().st_size,p.stat().st_mtime_ns) for p in paths))
                    if self.verified.get(ref['id'])!=stamp:
                        self.store.validate(song_id,{'source_sha256':source_hash},manifest)
                        self.verified[ref['id']]=stamp
                    manifests[kind]=manifest
                if busy and stems:return blocked
                if not stems:
                    # Stems were skipped. If they were split later, the player uses them; until then it plays the recording.
                    split=self._split_later(song_id,source_hash)
                    if split:return dict(result,ready=True,active=split,analysis_id=job['id'],reason='Analysis ready.')
                    public,description=original.describe(song_id,self.library.contained(manifests['source']['assets'][0]['path']))
                    self.light[song_id]=description
                    return dict(result,ready=True,active=public,stems=False,analysis_id=job['id'],
                                reason='Analysis ready. Split the stems to use the mixer.')
                _,separation=self.separation.get_published_run(manifests['separation']['run_id'])
                if separation['song_id']!=song_id or separation['source_sha256']!=source_hash:
                    raise ValueError('Stems belong to another recording')
                if self.separation.recipe_provider and separation['recipe_sha256']!=self.separation.recipe_provider():
                    raise ValueError('Separation recipe changed')
                # Ignore cache invalidation markers here: they request recomputation,
                # not deletion of an otherwise valid previous completed result.
                return dict(result,ready=True,active=self.separation.public_manifest(separation),analysis_id=job['id'],
                            reason='Using the previous completed analysis.' if failed else 'Analysis ready.')
            except (OSError,ValueError,KeyError,TypeError,IndexError):
                result['reason']='Saved analysis is incomplete or stale. Analyze again to enable playback.'
        if busy:return blocked
        # Older successful charts predate unified job manifests. Audio readiness
        # is proven by the published stems, not by forcing those charts through
        # new inference. This read-only path does not certify rhythm provenance.
        legacy=self._saved_chart_and_stems(song_id,source_hash)
        if legacy:
            return dict(result,ready=True,active=legacy,legacy=True,
                        reason='Saved chart and validated stems are ready.'+(' Latest analysis did not finish.' if failed else ''))
        return result

    def _split_later(self,song_id,source_hash):
        """The published stems of this recording, when they were split after an analysis that skipped them."""
        try:
            active=self.separation.get_song_state(song_id)['active']
            if not active:return None
            _,separation=self.separation.get_published_run(active['run_id'])
            if separation['song_id']!=song_id or separation['source_sha256']!=source_hash:return None
            if self.separation.recipe_provider and separation['recipe_sha256']!=self.separation.recipe_provider():return None
            return self.separation.public_manifest(separation)
        except (OSError,ValueError,KeyError,TypeError,IndexError):return None

    def original_run(self,song_id):
        """Where the recording of an analyzed-without-stems song can be streamed from (decided by the last readiness check)."""
        with self.lock:
            if song_id not in self.light:self._state(song_id,None)
            description=self.light.get(song_id)
        if not description:raise KeyError('This song is not ready for playback')
        return description

    def _saved_chart_and_stems(self,song_id,source_hash):
        try:
            song=self.library.song(song_id);run_id=song['active_run']
            if not run_id:return None
            with self.library.lock:
                run=self.library.db.execute('SELECT status FROM runs WHERE id=? AND song_id=?',(run_id,song_id)).fetchone()
                if not run or run['status'] not in ('complete','completed'):return None
                chart=self.library.db.execute("SELECT e.content FROM documents d JOIN edits e ON e.document_id=d.id AND e.position=d.cursor WHERE d.song_id=? AND d.run_id=? AND d.kind='chart'",(song_id,run_id)).fetchone()
                if not chart:return None
                content=json.loads(chart['content'])
                if content.get('version')!=1 or not content.get('sections') or not isinstance(content.get('chords'),list):return None
                stages=self.library.db.execute("SELECT manifest,reference FROM analysis_stages WHERE song_id=? AND kind='transcription'",(song_id,)).fetchall()
            # Known contrary provenance is never treated as an unknown legacy run.
            for row in stages:
                manifest=json.loads(row['manifest'])
                if manifest.get('run_id')!=run_id:continue
                ref=json.loads(row['reference'])
                if ref['source_sha256']!=source_hash or digest(manifest)!=ref['manifest_sha256']:return None
                self.store.validate(song_id,{'source_sha256':source_hash},manifest)
            return self.separation.get_song_state(song_id)['active']
        except (OSError,ValueError,KeyError,TypeError,IndexError):return None
