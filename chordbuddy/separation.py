"""Serialized, persisted fixed-chain separation independent of chart edits."""
import json
import shutil
import threading
import time
from pathlib import Path
from .separation_contract import ACTIVE,file_hash,recipe_digest
from .separation_recipe import build_recipe,model_root,separation_home,MODELS
from .path_policy import worker_environment as environment, validate_project
from .separation_checks import validate_mix
from .owned_process import OwnedProcess
class Cancelled(Exception):pass
class SeparationManager:
    def __init__(self,project,store,gate,pipeline=None,recipe_factory=None):
        self.project=Path(project).resolve();self.store=store;self.gate=gate
        self.recipe_lock=threading.RLock();self._recipe_cache=None
        self.pipeline=pipeline or SeparationManager._pipeline;self.recipe_factory=recipe_factory or self._installed_recipe
        self.lock=threading.RLock();self.cancelled=threading.Event();self.thread=None;self.process=None;self.run_id=None;self.terminal_error=None
    def _installed_recipe(self):
        # Validate on first selection and whenever an installed recipe input changes.
        # Avoid rehashing multi-GB immutable weights on every UI poll/PCM request.
        paths=[self.project/'tools/ffmpeg.exe']
        paths += [self.project/'chordbuddy'/name for name in ('separation_worker.py','separation_recipe.py','separation_audio.py')]
        for stage,(_,weight,config,_) in MODELS.items():
            root=model_root(self.project,stage)
            paths += [separation_home(self.project)/'runtime/python.exe',root/'weights'/weight,root/'evidence'/config,root/'evidence/upstream-commit.txt']
            paths += sorted((root/'source/models/bs_roformer').glob('*.py'))
        signature=tuple((str(p),p.stat().st_mtime_ns,p.stat().st_size) for p in paths)
        with self.recipe_lock:
            if self._recipe_cache is None or self._recipe_cache[0]!=signature:
                self._recipe_cache=(signature,build_recipe(self.project))
            return self._recipe_cache[1]
    def current_recipe_digest(self):
        return recipe_digest(self.recipe_factory())
    def snapshot(self):
        with self.lock:
            if not self.run_id:return None
            job=self.store.snapshot(self.store._run(self.run_id))
            if getattr(self,'retention',None):job['retention']=self.retention
            if self.terminal_error:job.update(status='failed',error=self.terminal_error,message=self.terminal_error)
            return job
    def start(self,song_id,device='auto',rerun=False):
        if device not in ('auto','cuda','cpu'):raise ValueError('Invalid device')
        validate_project(self.project)
        source=self.store.library.source_path(song_id)
        if not source.resolve().is_relative_to(self.project):raise ValueError('Separation library must stay inside this project')
        with self.lock:
            if self.thread and self.thread.is_alive():raise RuntimeError('Separation already running')
            owner=self.gate.try_acquire('separation',song_id,'pending')
            try:
                run=self.store.create_run(song_id,'pending')
                self.run_id=run['id'];self.cancelled.clear();self.terminal_error=None;self.retention=None
                self.thread=threading.Thread(target=self._run,args=(run,device,owner,rerun),daemon=True)
                self.thread.start();return self.snapshot()
            except BaseException:self.gate.release(owner);raise
    def check_cancel(self):
        if self.cancelled.is_set():raise Cancelled('Separation cancelled')
    def cancel(self,job_id):
        with self.lock:
            if job_id!=self.run_id:return self.store.snapshot(self.store._run(job_id))
            job=self.snapshot()
            if job['status'] not in ACTIVE:return job
            self.store.request_cancel(job_id);self.cancelled.set()
            if self.process:self.process.cancel()
            return self.snapshot()
    def wait(self):
        thread=self.thread
        if thread:thread.join()
    def _run(self,run,device,owner,rerun):
        safe=False
        try:
            self.check_cancel();recipe=self.recipe_factory();self.check_cancel()
            run.update(recipe=recipe,recipe_sha256=recipe_digest(recipe),device=device,rerun=rerun)
            with self.store.library.transaction() as db:db.execute('UPDATE separation_runs SET recipe_sha256=? WHERE id=?',(run['recipe_sha256'],run['id']))
            self.pipeline(self,run);safe=True
            if self.store._run(run['id'])['status']=='completed':
                try:
                    from .stem_retention import prune_stem_history
                    self.retention=prune_stem_history(self.project,self.store,song_id=run['song_id'])
                except Exception as exc:self.retention={'warning':'Old stems kept: '+str(exc)}
        except Exception as exc:
            status='cancelled' if self.cancelled.is_set() or isinstance(exc,Cancelled) else 'failed'
            try:self.store.fail_run(run['id'],status,str(exc));safe=True
            except Exception as persist_error:self.terminal_error='Could not persist terminal state: '+str(persist_error)
        finally:
            if safe:self.gate.release(owner)
    def _process(self,argv,run,stage):
        self.check_cancel();root=self.store.safe_path(run['folder']);last=0
        self.store.update_progress(run['id'],stage)
        with OwnedProcess(argv,cwd=self.project,env=environment(self.project,root)) as proc:
            with self.lock:
                self.process=proc
                if self.cancelled.is_set():proc.cancel()
            try:
                with (root/'worker.log').open('a',encoding='utf-8') as log:
                    for line in proc.stdout:
                        log.write(line);log.flush()
                        if line.startswith('CHORDBUDDY_SEPARATION ') and time.monotonic()-last>.25:
                            value=json.loads(line.split(' ',1)[1]);self.store.update_progress(run['id'],stage,value);last=time.monotonic()
                code=proc.wait();self.check_cancel()
                if code:raise RuntimeError(stage.capitalize()+' failed. See the separation worker log.')
            finally:
                with self.lock:self.process=None
    def _pipeline(self,run):
        self.check_cancel();root=self.store.safe_path(run['folder']);source=self.store.library.source_path(run['song_id'])
        source_hash=file_hash(source)
        # The source is immutable through the app; snapshot/hash detects external changes.
        snapshot=root/'source.mp3';shutil.copyfile(source,snapshot)
        if file_hash(snapshot)!=source_hash:raise ValueError('Source changed while copying')
        previous=self.store.get_song_state(run['song_id'])
        if not run['rerun'] and previous['active'] and previous['active']['recipe_sha256']==run['recipe_sha256'] and self.store._run(previous['active']['run_id'])['source_sha256']==source_hash:
            self.store.fail_run(run['id'],'cancelled','Existing validated separation is already available')
            return
        duration=self.store.library.song(run['song_id'])['duration']
        if shutil.disk_usage(root).free<max(256*1024**2,duration*44100*8*12):raise ValueError('Not enough free disk space for separation')
        if run.get('prepared'):
            prepared=Path(run['prepared']).resolve()
            if not prepared.is_relative_to(self.project):raise ValueError('Prepared audio escapes project')
            shutil.copyfile(prepared,root/'original.wav')
        else:
            self._process([str(self.project/'tools/ffmpeg.exe'),'-nostdin','-v','error','-n','-i',str(snapshot),'-ar','44100','-ac','2','-c:a','pcm_f32le',str(root/'original.wav')],run,'preparing')
        for stage,status in [('base','separating'),('guitar','refining')]:
            self._process([str(separation_home(self.project)/'runtime/python.exe'),'-B',str(self.project/'chordbuddy/separation_worker.py'),'--project',str(self.project),'--run',str(root),'--stage',stage,'--device',run['device']],run,status)
        self.store.update_progress(run['id'],'validating');self.check_cancel()
        metadata=json.loads((root/'guitar-stage.json').read_text())
        if metadata['input_sha256']!=file_hash(root/'guitar.wav'):raise ValueError('Guitar specialist input mismatch')
        manifest=validate_mix(root,self.check_cancel)
        manifest.update(source_sha256=source_hash,recipe=run['recipe'],recipe_sha256=run['recipe_sha256'])
        self.check_cancel();self.store.activate_validated(run['id'],manifest)

