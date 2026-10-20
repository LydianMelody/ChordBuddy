"""One durable admission owner; independently reusable validated analysis stages."""
import copy
import json
import threading
from pathlib import Path
from .analysis_store import AnalysisStore
from .analysis_contract import digest,transcription_dependencies
from .analysis_audio import prepare_source
from .separation_contract import file_hash
from .engine import Engine,MODEL_REVISION,MODEL_ID,BASE_MODEL_ID
from .separation import Cancelled
from .owned_process import OwnedProcess
from .path_policy import worker_environment as environment, validate_project
from .confidence import confidence_defaults

TERMINAL={'completed','partial','failed','cancelled','interrupted'}

def transcription_recipe(project,device):
    project=Path(project).resolve();inputs={}
    for name in ('worker.py','confidence.py','engine.py'):
        inputs['adapter/'+name]=file_hash(project/'chordbuddy'/name)
    for ident in (MODEL_ID,BASE_MODEL_ID):
        root=project/'.models/hf/hub'/('models--'+ident.replace('/','--'))
        snapshots=root/'snapshots'
        if not snapshots.is_dir():raise ValueError('Installed transcription model is missing')
        files=sorted(p for p in snapshots.rglob('*') if p.is_file())
        if not files:raise ValueError('Installed transcription model is incomplete')
        for path in files:
            if not path.resolve().is_relative_to(project):raise ValueError('Model path escapes project')
            inputs[ident+'/'+str(path.relative_to(root))]=file_hash(path)
    return {'model':MODEL_ID,'revision':MODEL_REVISION,'parent':BASE_MODEL_ID,'inputs':inputs,'device':device,'schema':1}

class AnalysisCoordinator:
    def __init__(self,project,library,documents,engine,separation,store,gate,stage_runner=None):
        self.project=Path(project).resolve();self.library=library;self.documents=documents
        self.separation=separation;self.store=store or AnalysisStore(library);self.gate=gate
        self.lock=threading.RLock();self.cancelled=threading.Event();self.thread=None;self.job=None
        self.owner=None;self.terminal_error=None;self.stage_runner=stage_runner or self.run_stage
        self.engine=Engine(self.project,lambda *args:setattr(self,'engine_result',args))
        self.engine_result=None;self.prepared=None;self.source_hash=None;self.invalidate=()
        self.rhythm_service=None;self.process=None
        self.new_run_id=None
        self.selected_transcription=None

    def snapshot(self):
        with self.lock:
            result=copy.deepcopy(self.job)
            if result and self.terminal_error:result.update(status='failed',error=self.terminal_error)
            return result

    def _state(self,**values):
        with self.lock:
            self.job.update(values);self.store.save_job(self.job)

    def start(self,song_id,invalidate=(),stems=True,edit_policy='keep'):
        if type(stems) is not bool:raise ValueError('Invalid stems setting')
        if edit_policy not in ('keep','replace'):raise ValueError('Invalid edit policy')
        if not isinstance(invalidate,(tuple,list)) or any(x not in {'source','separation','transcription','chart','rhythm'} for x in invalidate):raise ValueError('Invalid stage invalidation')
        validate_project(self.project)
        self.library.validate_song_paths(song_id)
        with self.lock:
            if self.thread and self.thread.is_alive():raise RuntimeError('Another analysis is active')
            self.owner=self.gate.try_acquire('analysis',song_id,'pending')
            self.job=None
            try:
                self.source_hash=file_hash(self.library.source_path(song_id));self.invalidate=tuple(invalidate);self.edit_policy=edit_policy
                self.new_run_id=None
                self.selected_transcription=None
                self.job={'kind':'analysis','song_id':song_id,'status':'running','stage':'preparing','progress':None,'error':None,'stages':{},'stems':stems}
                self.cancelled.clear();self.terminal_error=None;self.store.create_job(self.job)
                dependents={'source':('source','separation','transcription','chart','rhythm'),'separation':('separation','rhythm'),
                            'transcription':('transcription','chart','rhythm'),'chart':('chart',),'rhythm':('rhythm',)}
                for kind in {child for stage in self.invalidate for child in dependents[stage]}:self.store.invalidate(song_id,kind)
                self.thread=threading.Thread(target=self._run,daemon=True);self.thread.start()
                return self.snapshot()
            except BaseException as exc:self._start_failed(exc);raise

    def _start_failed(self,exc):
        if self.job and self.job.get('id'):
            try:self._state(status='failed',stage='failed',error=str(exc))
            except Exception as persistence:
                self.terminal_error='Could not persist failed admission. Restart to recover: '+str(persistence)
                return
        self.gate.release(self.owner)

    def check_cancel(self):
        if self.cancelled.is_set():raise Cancelled('Analysis cancelled')

    def _source_check(self):
        if file_hash(self.library.source_path(self.job['song_id']))!=self.source_hash:raise ValueError('Source changed during analysis')

    def cancel(self,job_id):
        with self.lock:
            if not self.job or self.job['id']!=job_id:raise KeyError('Unknown analysis job')
            if self.job['status'] in TERMINAL:return self.snapshot()
            self.cancelled.set();self._state(status='cancelling')
        self.engine.cancel()
        if self.process:self.process.cancel()
        if self.separation and self.separation.run_id:
            self.separation.cancel(self.separation.run_id)
        return self.snapshot()

    def wait(self):
        if self.thread:self.thread.join()

    def recover_interrupted(self):self.store.recover_interrupted()

    def propose_rhythm(self,document_id):
        validate_project(self.project)
        with self.lock:
            if self.thread and self.thread.is_alive():raise RuntimeError('Another analysis is active')
            self.owner=self.gate.try_acquire('rhythm',document_id,'pending')
            self.job=None
            try:
                self.library.validate_song_paths(self.documents.get(document_id)['song_id'])
                request=self.rhythm_service.prepare(document_id)
                self.job={'kind':'rhythm','song_id':request['song_id'],'document_id':document_id,
                          'status':'running','stage':'drum evidence','progress':None,'error':None,'stages':{}}
                self.cancelled.clear();self.terminal_error=None;self.store.create_job(self.job)
                self.thread=threading.Thread(target=self._run_rhythm,args=(request,),daemon=True);self.thread.start()
                return self.snapshot()
            except BaseException as exc:self._start_failed(exc);raise

    def _run_rhythm(self,request):
        status='failed';error=None
        try:
            self.check_cancel()
            deps={'source_sha256':request['stamp']['source_sha256'],'drums':request['drums_sha256'],
                  'baseline':digest(request['baseline']),'algorithm':file_hash(self.project/'chordbuddy/rhythm.py'),'settings':request['settings']}
            cached=self.store.lookup(request['song_id'],'rhythm',deps)
            if cached:
                manifest=self.store.manifest(cached);result=json.loads(self.library.contained(manifest['assets'][0]['path']).read_text(encoding='utf-8'))
            else:
                root=self.library.create_analysis_directory(request['song_id'])
                (root/'request.json').write_text(json.dumps(request,allow_nan=False),encoding='utf-8')
                argv=[str(self.project/'runtime/python.exe'),'-B','-m','chordbuddy.rhythm_worker','--project',str(self.project),'--request',str(root/'request.json'),'--output',str(root/'proposal.json')]
                with OwnedProcess(argv,cwd=self.project,env=environment(self.project,root)) as proc:
                    with self.lock:
                        self.process=proc
                        if self.cancelled.is_set():proc.cancel()
                    with (root/'worker.log').open('w',encoding='utf-8') as log:
                        for line in proc.stdout:
                            log.write(line)
                            try:self._state(progress=json.loads(line))
                            except ValueError:pass
                    code=proc.wait()
                self.process=None;self.check_cancel()
                if code:raise ValueError('Drum analysis failed; see the isolated worker log')
                result=json.loads((root/'proposal.json').read_text(encoding='utf-8'))
                if file_hash(request['drums'])!=request['drums_sha256']:raise ValueError('Drum artifact changed during analysis')
                self.store.publish(request['song_id'],'rhythm',deps,{'assets':[self._asset(root/'proposal.json')]})
            self.check_cancel()
            if self.documents.revision_stamp(request['document_id'])!=request['stamp']:raise ValueError('Chart changed while proposal was computed. Compute a fresh preview.')
            ident=self.documents.timing.put_version(result)
            self._state(proposal_id=ident);status='completed'
        except Exception as exc:status='cancelled' if self.cancelled.is_set() else 'failed';error=str(exc)
        finally:self.process=None
        try:self._state(status=status,stage=status,error=error)
        except Exception as exc:self.terminal_error='Could not persist terminal rhythm state. Restart to recover: '+str(exc)
        else:self.gate.release(self.owner)

    def _run(self):
        errors=[];completed={};fatal=False
        try:
            for kind in ('source','separation','transcription','chart'):
                self.check_cancel();self._source_check()
                if kind=='separation' and not self.job.get('stems',True):
                    with self.lock:self.job['stages'][kind]={'status':'skipped'}
                    continue
                if kind=='chart' and 'transcription' not in completed:continue
                self._state(stage=kind)
                try:
                    ref=self.stage_runner(kind,self.job['id'],self.owner,completed.get('source'),self.check_cancel)
                    self.check_cancel();self._source_check();completed[kind]=ref
                    with self.lock:self.job['stages'][kind]={'status':'completed','id':ref['id']}
                except Cancelled:raise
                except Exception as exc:
                    errors.append(kind+': '+str(exc))
                    with self.lock:self.job['stages'][kind]={'status':'failed','error':str(exc)}
                    if kind=='source' or self.terminal_error:fatal=True;break
            self.check_cancel()
            status='failed' if fatal or not any(k in completed for k in ('separation','transcription')) else 'partial' if errors else 'completed'
        except Cancelled as exc:status='cancelled';errors.append(str(exc))
        except Exception as exc:status='failed';errors.append(str(exc))
        try:
            self._state(status=status,stage=status,error='; '.join(errors) or None)
        except Exception as exc:
            self.terminal_error='Could not persist terminal analysis state. Restart to recover: '+str(exc)
        else:
            # Only after the whole bundle is durably complete may prior playback
            # stems become unnecessary. Retention failure never fails the analysis.
            if status=='completed' and self.separation:
                try:
                    from .stem_retention import prune_stem_history
                    retention=prune_stem_history(self.project,self.separation.store,self.store,song_id=self.job['song_id'])
                    self._state(retention=retention)
                except Exception as exc:
                    with self.lock:self.job['retention_warning']='Old stems kept: '+str(exc)
            if not self.terminal_error:self.gate.release(self.owner)

    def _asset(self,path):
        path=self.library.contained(path)
        return {'path':str(path.relative_to(self.library.root)),'sha256':file_hash(path)}

    def run_stage(self,kind,job_id,owner,prepared,check_cancel):
        song_id=self.job['song_id'];settings=self.library.read_settings();device=settings['device']
        deps={'source_sha256':self.source_hash,'schema':1}
        if kind=='source':
            deps['decoder']=file_hash(self.project/'tools/ffmpeg.exe');deps['format']=[44100,2,'float32',0]
            deps['adapter']=file_hash(self.project/'chordbuddy/analysis_audio.py')
        elif kind=='separation':
            deps['recipe']=self.separation.current_recipe_digest()
            deps['prepared']=prepared['manifest_sha256']
        elif kind=='transcription':
            deps=transcription_dependencies(self.source_hash,transcription_recipe(self.project,device),settings)
            deps['prepared']=prepared['manifest_sha256']
        else:
            run_id=self.selected_transcription
            if not run_id:raise ValueError('No transcription is available for chart derivation')
            run=self.library.folder(song_id)/'runs'/run_id
            deps.update(run_id=run_id,prepared=prepared['manifest_sha256'],derivation='chart-v1-cleanup-v1',
                        raw={p.name:file_hash(p) for p in run.iterdir() if p.suffix in ('.lab','.json','.abc') and p.name!='run-options.json'})
            deps['code']={name:file_hash(Path(__file__).parent/name) for name in ('chart.py','chart_cleanup.py')}
            cached=None if any(x in self.invalidate for x in ('chart','transcription','source')) else self.store.lookup(song_id,'chart',deps)
            if cached:return cached
            doc=next(self.documents.get(d['id']) for d in self.documents.for_song(song_id) if d['kind']=='chart' and d['run_id']==run_id)
            # Derive a new draft, never clean an existing edited chart implicitly.
            if doc['revision']==0 and self.separation and run_id==self.new_run_id:
                cleanup=self.documents.preview_cleanup(doc['id'])
                check_cancel()
                if cleanup.get('available'):doc=self.documents.apply_cleanup(doc['id'],cleanup,doc['revision'])
            target=self.library.create_analysis_directory(song_id)
            (target/'chart.json').write_text(json.dumps(doc['content'],allow_nan=False),encoding='utf-8')
            return self.store.publish(song_id,'chart',deps,{'document_id':doc['id'],'assets':[self._asset(target/'chart.json')]})
        invalid=kind in self.invalidate or 'source' in self.invalidate
        cached=None if invalid else self.store.lookup(song_id,kind,deps)
        if cached:
            manifest=self.store.manifest(cached)
            if kind=='source':self.prepared=self.library.contained(manifest['assets'][0]['path'])
            if kind=='transcription':
                check_cancel();self._source_check()
                self.documents.select_cached_run(song_id,manifest['run_id'])
                self.selected_transcription=manifest['run_id']
            if kind=='separation':
                root,value=self.separation.store.get_published_run(manifest['run_id'])
                if value['source_sha256']!=self.source_hash or value['recipe_sha256']!=deps['recipe']:raise ValueError('Cached separation does not match selected source/recipe')
                check_cancel();self._source_check()
                with self.library.transaction() as db:
                    db.execute('INSERT OR REPLACE INTO song_separations VALUES(?,?)',(song_id,manifest['run_id']))
            self._state(stage='Using saved '+kind)
            return cached
        check_cancel()
        if kind=='source':
            target=self.library.create_analysis_directory(song_id)
            value=prepare_source(self.project,self.library.source_path(song_id),target,check_cancel,reserved=True)
            self.prepared=Path(value.pop('path'))
            manifest=dict(value,assets=[self._asset(self.prepared)])
        elif kind=='separation':
            previous=self.separation.store.get_song_state(song_id)
            if not invalid and previous['active']:
                root,value=self.separation.store.get_published_run(previous['active']['run_id'])
                original=next(a for a in value['assets'] if a['role']=='original')
                invalid=original['file_sha256']!=file_hash(self.prepared)
            if invalid or not previous['active']:
                run=self.separation.store.create_run(song_id,deps['recipe'])
                self.separation.run_id=run['id'];self.separation.cancelled.clear()
                recipe=self.separation.recipe_factory()
                run.update(recipe=recipe,recipe_sha256=deps['recipe'],device=device,rerun=True,prepared=str(self.prepared))
                try:self.separation.pipeline(self.separation,run)
                except Exception as exc:
                    try:self.separation.store.fail_run(run['id'],'cancelled' if self.cancelled.is_set() else 'failed',str(exc))
                    except Exception as persistence:
                        self.terminal_error='Could not persist child terminal state. Restart to recover: '+str(persistence)
                    raise
                root,value=self.separation.store.get_published_run(run['id'])
            manifest={'run_id':value['run_id'],'assets':[self._asset(root/'manifest.json')]+[self._asset(root/a['relative_path']) for a in value['assets']]}
        else:
            run=self.library.create_run(song_id);previous=self.library.song(song_id)['active_run']
            (run/'run-options.json').write_text(json.dumps({'previous_run':previous,'edit_policy':getattr(self,'edit_policy','keep'),'metadata':self.library.song_metadata(song_id),'confidence':confidence_defaults()}))
            self.engine_result=None
            try:
                self.engine.start(song_id,self.prepared,run,device);self.engine.wait();check_cancel();self._source_check()
                result=self.engine_result
                if not result or result[2]!='completed':raise ValueError((result[3] if result else None) or 'Transcription incomplete')
                assets=[self._asset(p) for p in run.rglob('*') if p.is_file() and 'edited' not in p.parts and p.suffix in {'.lab','.abc','.mid','.json'}]
                manifest={'run_id':run.name,'run_folder':str(run.relative_to(self.library.root)),'assets':assets}
                # Nested writes use savepoints: no active selection survives a failed
                # stage publication, document ingestion, or last cancellation check.
                with self.library.transaction():
                    ref=self.store.publish(song_id,kind,deps,manifest)
                    check_cancel();self._source_check()
                    self.documents.ingest(*result)
                    state=self.library.db.execute('SELECT status FROM runs WHERE id=?',(run.name,)).fetchone()[0]
                    if state not in ('complete','completed'):raise ValueError('Transcription documents could not be validated')
                    check_cancel();self._source_check()
                self.new_run_id=run.name;self.selected_transcription=run.name
                return ref
            except Exception as exc:
                try:self.library.finish_run(song_id,run.name,'cancelled' if self.cancelled.is_set() else 'failed',str(exc))
                except Exception as persistence:self.terminal_error='Could not persist child terminal state. Restart to recover: '+str(persistence)
                raise
        check_cancel();self._source_check()
        return self.store.publish(song_id,kind,deps,manifest)
