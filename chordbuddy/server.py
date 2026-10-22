"""Loopback-only desktop API. No library paths are accepted from the browser."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import threading
from urllib.parse import parse_qs, quote, unquote, urlparse

mimetypes.add_type('font/woff2','.woff2')  # Windows Python often lacks it; the frontend bundles woff2 fonts

from .documents import DocumentStore, RevisionConflict
from .engine import Engine, ACTIVE_STATUSES
from .transcription_models import TranscriptionModels
from .library import Library
from .separation_store import SeparationStore
from .separation import SeparationManager
from .inference_jobs import InferenceGate
from .separation_audio import wire_chunk,read_frames
from .separation_checks import waveform_peaks
from .mix_export import parse_levels,encode_mix,export_stems
from . import visual_features
from .model_downloads import ModelManager
from .analysis import AnalysisCoordinator,TERMINAL
from .rhythm_apply import RhythmService
from .playback_ready import PlaybackReadiness
from .filenames import safe_stem
from . import original_playback
from .song_transfer import SongTransfer


PROJECT=Path(__file__).resolve().parent.parent


class Application:
    def __init__(self,root,project_dir=PROJECT):
        self.token=secrets.token_urlsafe(32)
        self.library=Library(root,project_dir=project_dir)
        self.library.recover_interrupted()
        self.documents=DocumentStore(self.library)
        self.inference_gate=InferenceGate()
        self._transcription_owner=None
        self._inference_recovery_error=None
        self._last_job_kind='transcription'
        self.engine=Engine(project_dir,self._ingest_transcription)
        self.models=ModelManager(project_dir)
        self.chord_model=TranscriptionModels(project_dir,self.engine.python_path)
        self.separation_store=SeparationStore(self.library,recipe_provider=lambda:self.separation.current_recipe_digest())
        self.separation_store.recover_interrupted()
        self.separation=SeparationManager(project_dir,self.separation_store,self.inference_gate)
        self.analysis=AnalysisCoordinator(project_dir,self.library,self.documents,self.engine,self.separation,None,self.inference_gate)
        self.analysis.recover_interrupted()
        self.playback=PlaybackReadiness(self.analysis.store,self.separation_store)
        self.rhythm=RhythmService(self)
        self.analysis.rhythm_service=self.rhythm
        self.transfer=SongTransfer(self)
        self.job_lock=threading.Lock()
        self._closed=False
        self.waveform_cache={}
        self.waveform_lock=threading.Lock()

    def _ingest_transcription(self,*args):
        try:
            self.documents.ingest(*args)
        except Exception as exc:
            self._inference_recovery_error=f'Terminal transcription state could not be saved: {exc}. Restart Chord Buddy to recover before starting another job.'
            raise
        else:
            self._inference_recovery_error=None
            self.inference_gate.release(self._transcription_owner)
            self._transcription_owner=None

    def state(self):
        transcription=self.engine.snapshot()
        separation=self.separation.snapshot()
        if separation and separation['status'] in {'preparing','separating','refining','validating','cancelling'}:job=separation
        elif transcription and transcription.get('status') in ACTIVE_STATUSES:job=transcription
        else:job=separation if self._last_job_kind=='separation' else transcription
        if self._inference_recovery_error:
            job=dict(job or {},kind='transcription',status='failed',stage='failed',error=self._inference_recovery_error,message=self._inference_recovery_error)
        analysis=self.analysis.snapshot()
        if analysis and (analysis['status'] not in TERMINAL or self._last_job_kind=='analysis' or self.analysis.terminal_error):job=analysis
        return dict(self.library.state(),engine=dict(self.engine.readiness(),model=self.engine.attribution()),job=job,models=self.models.status(),chord_model=self.chord_model.status())

    def playback_state(self,song_id):
        with self.job_lock:
            job=self.analysis.snapshot()
            if not job or job.get('song_id')!=song_id or job.get('status') in TERMINAL:
                for candidate in (self.separation.snapshot(),self.engine.snapshot()):
                    if candidate and candidate.get('song_id')==song_id and candidate.get('status') in ACTIVE_STATUSES|{'preparing','separating','refining','validating','cancelling'}:
                        job=candidate;break
            return self.playback.state(song_id,job)

    def _song_busy(self,song_id):
        busy=ACTIVE_STATUSES|{'preparing','separating','refining','validating','cancelling','running','starting'}
        return any(job and job.get('song_id')==song_id and job.get('status') in busy for job in (self.analysis.snapshot(),self.separation.snapshot(),self.engine.snapshot()))

    def trash_song(self,song_id):
        with self.job_lock:
            if self._song_busy(song_id):raise RevisionConflict('This song is being analyzed. Cancel the analysis or wait for it to finish first.')
            return self.library.trash_song(song_id)

    def purge_song(self,song_id):
        with self.job_lock:
            if self._song_busy(song_id):raise RevisionConflict('This song is being analyzed. Cancel the analysis or wait for it to finish first.')
            return self.library.purge_song(song_id)

    def analyze(self,song_id,invalidate=(),stems=True,edit_policy='keep'):
        if type(stems) is not bool:raise ValueError('Invalid stems setting')
        with self.job_lock:
            if self._closed:raise RevisionConflict('Chord Buddy is closing')
            if self._inference_recovery_error:raise RevisionConflict(self._inference_recovery_error)
            # Only splitting the stems needs the separation models; the chart and lead sheet do not.
            if stems and not self.models.ready():raise ValueError('The stem separation models have not been downloaded yet. Use "Download models" first.')
            try:result=self.analysis.start(song_id,invalidate,stems,edit_policy)
            except RuntimeError as exc:raise RevisionConflict(str(exc)) from exc
            self._last_job_kind='analysis'
            return result

    def open_external_score(self,song_id,filename,xml):
        """Saves a lead sheet as a MusicXML file next to the song and opens it in whatever program the computer uses for that."""
        if not isinstance(xml,str) or not xml.strip() or len(xml)>16*1024*1024:raise ValueError('There is no score to open.')
        if '<!ENTITY' in xml:raise ValueError('This score cannot be opened.')
        try:
            from xml.etree import ElementTree
            root=ElementTree.fromstring(xml.encode('utf-8'))
        except Exception as exc:raise ValueError('The score is not valid MusicXML: '+str(exc)) from exc
        if root.tag!='score-partwise':raise ValueError('The score is not valid MusicXML.')
        name=str(filename or 'Lead sheet.musicxml')
        if name.lower().endswith('.musicxml'):name=name[:-9]
        return self._open_in_other_program(song_id,safe_stem(name,'Lead sheet')+'.musicxml',xml.encode('utf-8'),'MusicXML')

    def open_external_midi(self,song_id,document_id):
        """Saves a MIDI output next to the song (one file, or a folder of one file per track) and opens it in the program the computer uses for MIDI."""
        doc=self.documents._row(document_id)
        if doc['song_id']!=song_id:raise ValueError('That MIDI belongs to another song.')
        data,name=self.documents.midi_download(document_id,'single')
        return self._open_in_other_program(song_id,name,data,'MIDI')

    def _open_in_other_program(self,song_id,name,data,what):
        self.library.validate_song_paths(song_id)
        folder=self.library.folder(song_id)/'external'
        folder.mkdir(exist_ok=True)
        path=folder/name
        path.write_bytes(data)
        result={'path':str(path),'opened':False,'message':''}
        try:
            if os.name=='nt':
                os.startfile(str(path))
                result['opened']=True
            else:
                result['message']='Saved. Open this file in your '+('notation' if what=='MusicXML' else 'music')+' program: '+str(path)
        except OSError:
            result['message']='No program on this computer opens '+what+' files yet. The file is saved here: '+str(path)
        if result['opened']:result['message']='Opened in your '+('notation' if what=='MusicXML' else 'music')+' program. Changes made there are not read back.'
        return result

    def propose_rhythm(self,document_id):
        with self.job_lock:
            if self._closed:raise RevisionConflict('Chord Buddy is closing')
            if self._inference_recovery_error:raise RevisionConflict(self._inference_recovery_error)
            try:result=self.analysis.propose_rhythm(document_id)
            except RuntimeError as exc:raise RevisionConflict(str(exc)) from exc
            self._last_job_kind='analysis'
            return result

    def separate(self,song_id,rerun=False):
        if type(rerun) is not bool:raise ValueError('Invalid rerun setting')
        with self.job_lock:
            if self._closed:raise RevisionConflict('Chord Buddy is closing')
            if self._inference_recovery_error:raise RevisionConflict(self._inference_recovery_error)
            try:
                result=self.separation.start(song_id,self.library.read_settings()['device'],rerun)
                self._last_job_kind='separation'
                return result
            except RuntimeError as exc:raise RevisionConflict(str(exc)) from exc

    def transcribe(self,song_id,edit_policy=None):
        with self.job_lock:
            if self._closed:
                raise RevisionConflict('Chord Buddy is closing')
            current=self.engine.snapshot()
            if current and current.get('status') in ACTIVE_STATUSES:
                raise RevisionConflict('A song is already being transcribed')
            if self.inference_gate.owner is not None:
                raise RevisionConflict(self._inference_recovery_error or 'Another song is already being processed')
            ready=self.engine.readiness()
            if not ready['ready']:
                raise ValueError(ready['message'])
            if self.separation.snapshot() and self.separation.snapshot()['status'] in {'preparing','separating','refining','validating','cancelling'}:
                raise RevisionConflict('A song is already being separated')
            if edit_policy not in (None,'keep','replace'):
                raise ValueError('Choose Keep edits or Replace edits')
            # Own the gate before creating durable work. A failed terminal save
            # retains ownership until startup recovery makes the library safe.
            try:self._transcription_owner=self.inference_gate.try_acquire('transcription',song_id,'pending')
            except RuntimeError as exc:raise RevisionConflict(str(exc)) from exc
            run=None
            try:
                # Never acquire the engine lock while holding SQLite's lock:
                # the completion callback holds that lock while ingesting docs.
                with self.library.lock:
                    if self.documents.has_user_changes(song_id) and edit_policy is None:
                        raise ValueError('Choose Keep edits or Replace edits before reprocessing')
                    previous_run=self.library.song(song_id)['active_run']
                    settings=self.library.read_settings()
                    source=self.library.source_path(song_id)
                    run=self.library.create_run(song_id)
                    options={'previous_run':previous_run,'edit_policy':edit_policy or 'replace',
                             'model':self.engine.attribution(),
                             'confidence':{k:v for k,v in settings.items() if k in ('beat_flag_threshold','beat_remove_threshold','chord_flag_threshold')},
                             'metadata':self.library.song_metadata(song_id)}
                    (run/'run-options.json').write_text(json.dumps(options,allow_nan=False),encoding='utf-8')
                self._last_job_kind='transcription'
                return self.engine.start(song_id,source,run,settings['device'])
            except Exception as exc:
                if run is not None:
                    try:self.library.finish_run(song_id,run.name,'failed',str(exc))
                    except Exception as persist_error:
                        self._inference_recovery_error=f'Terminal transcription state could not be saved: {persist_error}. Restart Chord Buddy to recover before starting another job.'
                        raise
                self.inference_gate.release(self._transcription_owner)
                self._transcription_owner=None
                raise

    def activate_run(self,song_id,run_id):
        with self.job_lock:
            if self._closed:
                raise RevisionConflict('Chord Buddy is closing')
            if self.inference_gate.owner is not None:raise RevisionConflict('Wait for analysis to finish before restoring a run')
            current=self.engine.snapshot()
            if current and current.get('status') in ACTIVE_STATUSES:
                raise RevisionConflict('Wait for transcription to finish before restoring a run')
            with self.library.transaction():
                self.documents.freeze_active_timing(song_id)
                return self.library.activate_run(song_id,run_id)

    def close(self):
        with self.job_lock:
            if self._closed:
                return
            self._closed=True
            analysis=self.analysis.snapshot()
            if analysis and analysis['status'] not in TERMINAL:self.analysis.cancel(analysis['id'])
            self.analysis.wait()
            self.engine.cancel()
            self.engine.wait()
            job=self.separation.snapshot()
            if job:self.separation.cancel(job['id'])
            self.separation.wait()
            self.chord_model.cancel()
            self.chord_model.wait()
            self.library.close()


class Server(ThreadingHTTPServer):
    daemon_threads=True

    def server_close(self):
        super().server_close()
        self.app.close()


class Handler(BaseHTTPRequestHandler):
    server_version='ChordBuddy'

    def log_message(self,*args):
        # URLs can contain the private session token; do not print them.
        pass

    @property
    def app(self):
        return self.server.app

    def end_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

    def _allowed(self,path,query):
        expected=f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host')!=expected:
            return False
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://{expected}':
            return False
        if path.startswith('/api/'):
            token=self.headers.get('X-ChordBuddy-Token','')
            if path.startswith(('/api/audio/','/api/export/','/api/mix-export/','/api/stems-export/','/api/export-midi/','/api/export-outputs/','/api/song-export/')):
                token=token or query.get('token',[''])[0]
            return secrets.compare_digest(token,self.app.token)
        return True

    def _json(self,value,status=200):
        body=json.dumps(value,allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self,limit):
        try:
            size=int(self.headers.get('Content-Length','0'))
        except ValueError:
            raise ValueError('Invalid request size')
        if not 0<size<=limit:
            raise ValueError('The file or request is empty or too large')
        self.connection.settimeout(120)
        body=self.rfile.read(size)
        if len(body)!=size:
            raise ValueError('The upload was interrupted')
        return body

    def _models_import(self,query):
        # A model file the user already has: streamed to disk (they are large), then accepted only if its fingerprint is exactly right.
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<=2*1024**3:raise ValueError('Expected a model file')
        folder=PROJECT/'.models'/'uploads';folder.mkdir(parents=True,exist_ok=True)
        temp=folder/('upload-'+secrets.token_hex(6)+'.partial')
        try:
            left=size
            with open(temp,'wb') as out:
                while left:
                    block=self.rfile.read(min(1<<20,left))
                    if not block:raise ValueError('The upload was interrupted')
                    out.write(block);left-=len(block)
            return self.app.models.adopt(query.get('name',[''])[0],temp,move=True)
        finally:
            temp.unlink(missing_ok=True)

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def _dispatch(self,method):
        url=urlparse(self.path)
        path=unquote(url.path)
        query=parse_qs(url.query)
        try:
            if not self._allowed(path,query):
                self._json({'error':'This request is not authorized'},403)
                return
            if method=='GET':
                self._get(path)
            elif path=='/api/models/import':
                self._json(self._models_import(query))
            elif path=='/api/song-import':
                # A song zip from another computer can be gigabytes: it is streamed to disk, never held in memory.
                try:size=int(self.headers.get('Content-Length','0'))
                except ValueError:raise ValueError('Invalid request size')
                self.connection.settimeout(120)
                self._json(self.app.transfer.receive(self.rfile.read,size))
            elif path=='/api/import':
                self._json(self.app.library.import_audio(query.get('filename',[''])[0],self._read(250*1024*1024),query.get('setlist',['default'])[0]))
            else:
                payload=json.loads(self._read(24*1024*1024))
                if not isinstance(payload,dict):
                    raise ValueError('Expected an object')
                self._post(path,payload)
        except RevisionConflict as exc:
            self._json({'error':str(exc)},409)
        except KeyError as exc:
            self._json({'error':str(exc).strip("'")},404)
        except (ValueError,TypeError) as exc:
            self._json({'error':str(exc)},400)
        except (BrokenPipeError,ConnectionResetError):
            pass
        except OSError as exc:
            self._json({'error':f'Unable to read or save the file: {exc}'},500)
        except Exception as exc:
            self._json({'error':f'Chord Buddy could not complete this action: {exc}'},500)

    def _get(self,path):
        if re.fullmatch(r'/api/documents/[^/]+/rhythm/proposals/[^/]+',path):
            parts=path.split('/');doc=self.app.documents.get(parts[3]);version=self.app.documents.timing.version(parts[6])
            stamp=self.app.documents.revision_stamp(doc['id'])
            if version['transcription_id']!=doc['run_id'] or version['source_sha256']!=stamp['source_sha256']:raise ValueError('Proposal belongs to another source')
            return self._json(version)
        if path.startswith('/api/waveform/'):
            run_id=path.removeprefix('/api/waveform/')
            if original_playback.song_of(run_id):
                description=self.app.playback.original_run(original_playback.song_of(run_id));root,manifest=description['root'],description['manifest']
            else:
                root,manifest=self.app.separation_store.get_published_run(run_id)
            asset=next(a for a in manifest['assets'] if a['role']=='original')
            key=(run_id,asset['file_sha256'])
            with self.app.waveform_lock:
                if key not in self.app.waveform_cache:
                    value=waveform_peaks(asset,lambda start,count:read_frames(root/asset['relative_path'],asset,start,count))
                    if len(self.app.waveform_cache)>=2:self.app.waveform_cache.pop(next(iter(self.app.waveform_cache)))
                    self.app.waveform_cache[key]=dict(value,run_id=run_id)
                value=self.app.waveform_cache[key]
            return self._json(value)
        if path.startswith('/api/mix-export/'):
            run_id=path.removeprefix('/api/mix-export/');query=parse_qs(urlparse(self.path).query)
            levels,master=parse_levels(query.get('levels',[''])[0],query.get('master',['1'])[0])
            root,manifest=self.app.separation_store.get_published_run(run_id)
            name=re.sub(r'[\\/:*?"<>|\x00-\x1f]+',' ',query.get('name',['Chord Buddy mix'])[0]).strip()[:120] or 'Chord Buddy mix'
            self.send_response(200)
            self.send_header('Content-Type','audio/mpeg')
            self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(name+'.mp3'))
            self.send_header('Connection','close');self.close_connection=True
            self.end_headers()
            encode_mix(PROJECT,root,manifest,levels,master,self.wfile.write);return
        if path.startswith('/api/stems-export/'):
            run_id=path.removeprefix('/api/stems-export/');query=parse_qs(urlparse(self.path).query)
            root,manifest=self.app.separation_store.get_published_run(run_id)
            name=re.sub(r'[\\/:*?"<>|\x00-\x1f]+',' ',query.get('name',['Chord Buddy'])[0]).strip()[:100] or 'Chord Buddy'
            self.send_response(200)
            self.send_header('Content-Type','application/zip')
            self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(name+' - stems.zip'))
            self.send_header('Connection','close');self.close_connection=True
            self.end_headers()
            export_stems(PROJECT,root,manifest,name,self.wfile.write);return
        if path.startswith('/api/song-export/'):
            # The whole song (recording, analysis, edits and, if asked, stems) as one zip named after the song.
            song_id=path.removeprefix('/api/song-export/');query=parse_qs(urlparse(self.path).query)
            if self.app._song_busy(song_id):raise RevisionConflict('This song is being analyzed. Wait for it to finish, then export it.')
            manifest,files,name=self.app.transfer.export_plan(song_id,query.get('stems',['0'])[0]=='1')
            self.send_response(200)
            self.send_header('Content-Type','application/zip')
            self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(name))
            self.send_header('Connection','close');self.close_connection=True
            self.end_headers()
            self.app.transfer.write_zip(manifest,files,self.wfile.write);return
        if path.startswith('/api/separation-audio/'):
            run_id=path.removeprefix('/api/separation-audio/')
            query=parse_qs(urlparse(self.path).query)
            if set(query)!={'start_frame','frame_count'} or any(len(v)!=1 for v in query.values()):raise ValueError('Expected frame bounds')
            start=int(query['start_frame'][0]);count=int(query['frame_count'][0])
            if original_playback.song_of(run_id):
                payload,actual=original_playback.wire_chunk(self.app.playback.original_run(original_playback.song_of(run_id)),start,count)
            else:
                root,manifest=self.app.separation_store.get_published_run(run_id)
                payload,actual=wire_chunk(root,manifest,start,count)
            self.send_response(200)
            self.send_header('Content-Type','application/octet-stream')
            self.send_header('Content-Length',str(len(payload)))
            for name,value in [('Run-Id',run_id),('Start-Frame',start),('Frame-Count',actual),('Sample-Rate',44100)]:
                self.send_header('X-Stem-'+name,str(value))
            self.end_headers();self.wfile.write(payload);return
        if path.startswith('/api/visual-features/'):
            run_id=path.removeprefix('/api/visual-features/')
            if original_playback.song_of(run_id):
                description=self.app.playback.original_run(original_playback.song_of(run_id));root,manifest=description['root'],description['manifest']
            else:
                root,manifest=self.app.separation_store.get_published_run(run_id)
            return self._json(visual_features.load_or_compute(root,manifest))
        if path.startswith('/api/playback/'):
            return self._json(self.app.playback_state(path.removeprefix('/api/playback/')))
        if path.startswith('/api/separation/'):
            return self._json(self.app.separation_store.get_song_state(path.removeprefix('/api/separation/')))
        if path=='/api/prefs':
            return self._json(self.app.library.read_prefs())
        if path=='/api/models':
            return self._json(self.app.models.status())
        if path=='/api/chord-model':
            return self._json(self.app.chord_model.status())
        if path=='/api/state':
            return self._json(self.app.state())
        if path.startswith('/api/song/'):
            return self._json(self.app.documents.song_detail(path.removeprefix('/api/song/')))
        if path.startswith('/api/document/'):
            return self._json(self.app.documents.get(path.removeprefix('/api/document/')))
        if path.startswith('/api/audio/'):
            return self._audio(self.app.library.source_path(path.removeprefix('/api/audio/')))
        if path.startswith(('/api/export/','/api/export-midi/','/api/export-outputs/')):
            if path.startswith('/api/export-midi/'):data,name=self.app.documents.midi_download(path.removeprefix('/api/export-midi/'),parse_qs(urlparse(self.path).query).get('mode',['single'])[0])
            elif path.startswith('/api/export-outputs/'):data,name=self.app.documents.outputs_zip(path.removeprefix('/api/export-outputs/'))
            else:data,name=self.app.documents.export(path.removeprefix('/api/export/'))
            self.send_response(200)
            self.send_header('Content-Type','application/octet-stream')
            self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(name))
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith('/api/'):
            raise KeyError('Unknown action')
        web=(PROJECT/'chordbuddy'/'web').resolve()
        if path=='/visualizations/index.json':
            # the visualizer's scenes: every .js file in web/visualizations whose name does not start with _ (templates, drafts)
            folder=web/'visualizations'
            files=sorted(p.name for p in folder.glob('*.js') if p.is_file() and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*\.js',p.name))
            return self._json({'files':files})
        relative='index.html' if path=='/' else path.lstrip('/')
        target=(web/relative).resolve()
        if not target.is_relative_to(web) or not target.is_file():
            raise KeyError('Page not found')
        body=target.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type',mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _post(self,path,body):
        lib=self.app.library
        if re.fullmatch(r'/api/documents/[^/]+/timing',path):
            result=self.app.documents.set_chart_timing(path.split('/')[3],body['timing'],body['revision'])
        elif re.fullmatch(r'/api/documents/[^/]+/cleanup/(preview|apply)',path):
            document_id=path.split('/')[3]
            if path.endswith('/preview'):result=self.app.documents.preview_cleanup(document_id)
            else:result=self.app.documents.apply_cleanup(document_id,body['preview'],body['revision'])
        elif re.fullmatch(r'/api/documents/[^/]+/rhythm/(propose|preview|apply)',path):
            document_id=path.split('/')[3];action=path.split('/')[-1]
            if action=='propose':
                result=self.app.propose_rhythm(document_id)
            elif action=='preview':result=self.app.rhythm.preview(document_id,body['proposal_id'],body['policy'])
            else:result=self.app.rhythm.apply(document_id,body['preview_id'],body['stamp'],body['policy'])
        elif re.fullmatch(r'/api/songs/[^/]+/analyze',path):
            result=self.app.analyze(path.split('/')[3],body.get('invalidate',[]),body.get('stems',True),body.get('edit_policy','keep'))
        elif re.fullmatch(r'/api/analysis/[^/]+/cancel',path):
            result=self.app.analysis.cancel(path.split('/')[3])
        elif path=='/api/separate':
            result=self.app.separate(body['song_id'],body.get('rerun',False))
        elif path=='/api/separation/cancel':
            result=self.app.separation.cancel(body['job_id'])
        elif path=='/api/song':
            result=lib.rename_song(body['id'],body['title'],body.get('artist'))
        elif path=='/api/song/trash':
            result=self.app.trash_song(body['id'])
        elif path=='/api/song/restore':
            result=lib.restore_song(body['id'])
        elif path=='/api/song/purge':
            result=self.app.purge_song(body['id'])
        elif path=='/api/song-export/info':
            if self.app._song_busy(body['song_id']):raise RevisionConflict('This song is being analyzed. Wait for it to finish, then export it.')
            result=self.app.transfer.sizes(body['song_id'])
        elif path=='/api/song-import/apply':
            result=self.app.transfer.apply(body['token'],body.get('mode'),body.get('analysis',False),body.get('stems',False),body.get('setlist') or 'default',body.get('target'))
        elif path=='/api/song-import/cancel':
            result=self.app.transfer.cancel(body['token'])
        elif path=='/api/setlist':
            result=lib.create_setlist(body['name'])
        elif path=='/api/setlist/order':
            result=lib.reorder_setlist(body['id'],body['song_ids'])
        elif path=='/api/setlist/add':
            result=lib.add_to_setlist(body['id'],body['song_id'])
        elif path=='/api/prefs':
            result=lib.write_prefs(body)
        elif path=='/api/models/download':
            result=self.app.models.start()
        elif path=='/api/models/cancel':
            result=self.app.models.cancel()
        elif path=='/api/chord-model/download':
            result=self.app.chord_model.start()
        elif path=='/api/chord-model/cancel':
            result=self.app.chord_model.cancel()
        elif path=='/api/settings':
            result=lib.settings(body)
        elif path=='/api/song-metadata':
            song_id=body.get('song_id',body.get('id'))
            metadata=body.get('metadata')
            if metadata is None:
                metadata={k:body[k] for k in ('timing','chord_overrides') if k in body}
            result=self.app.documents.apply_song_metadata(song_id,metadata,body.get('revision'))
        elif path=='/api/confirm-chord':
            song_id=body.get('song_id',body.get('id'))
            current=lib.song_metadata(song_id)
            overrides=[item for item in current['chord_overrides'] if item['id']!=body.get('id')]
            override={k:body[k] for k in ('id','start','end','label') if k in body}
            override['confirmed']=True
            overrides.append(override)
            result=self.app.documents.apply_song_metadata(song_id,{'timing':current['timing'],'chord_overrides':overrides},body.get('revision'))
        elif path=='/api/start-chord-at-measure':
            result=self.app.documents.start_chord_at_measure(
                body['song_id'],body['chord_id'],body['measure_id'],body.get('revision'),body.get('document_id'))
        elif path=='/api/transcribe':
            result=self.app.transcribe(body['song_id'],body.get('edit_policy'))
        elif path=='/api/activate-run':
            result=self.app.activate_run(body['song_id'],body['run_id'])
        elif path=='/api/cancel':
            result=self.app.engine.cancel()
        elif path=='/api/lead-sheet/external':
            result=self.app.open_external_score(body['song_id'],body.get('filename'),body.get('xml'))
        elif path=='/api/midi/external':
            result=self.app.open_external_midi(body['song_id'],body['document_id'])
        elif path=='/api/open-folder':
            folder=lib.folder(body['song_id'])
            if os.name=='nt':
                os.startfile(str(folder))
            result={'ok':True}
        elif path.startswith('/api/document/'):
            tail=path.removeprefix('/api/document/').split('/')
            if len(tail)==1:
                result=self.app.documents.save(tail[0],body['content'],body.get('label','Edit document'),body['revision'])
            elif len(tail)==2 and tail[1]=='export':
                result=self.app.documents.retry_export(tail[0],body['revision'])
            elif len(tail)==2:
                result=self.app.documents.history(tail[0],tail[1],body['revision'])
            else:
                raise KeyError('Unknown document action')
        else:
            raise KeyError('Unknown action')
        self._json(result)

    def _audio(self,path):
        size=path.stat().st_size
        start,end=0,size-1
        requested=self.headers.get('Range')
        if requested:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',requested)
            if match and any(match.groups()):
                left,right=match.groups()
                if left:
                    start=int(left)
                    end=min(int(right),size-1) if right else size-1
                else:
                    start=max(0,size-int(right))
            else:
                start=size
            if not 0<=start<=end<size:
                self.send_response(416)
                self.send_header('Content-Range',f'bytes */{size}')
                self.send_header('Content-Length','0')
                self.end_headers()
                return
        self.send_response(206 if requested else 200)
        self.send_header('Content-Type','audio/mpeg')
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Length',str(end-start+1))
        if requested:
            self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers()
        with path.open('rb') as audio:
            audio.seek(start)
            remaining=end-start+1
            while remaining:
                data=audio.read(min(65536,remaining))
                if not data:
                    break
                self.wfile.write(data)
                remaining-=len(data)


def make_server(root,port=0,project_dir=PROJECT):
    server=Server(('127.0.0.1',port),Handler)
    server.app=Application(root,project_dir)
    return server
