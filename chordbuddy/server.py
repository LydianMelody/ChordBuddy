"""Loopback-only desktop API. No library paths are accepted from the browser."""
from __future__ import annotations

from hashlib import blake2b
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
from .user_midi import UserMidi
from .visual_relay import VisualRelay,stream_key
from .visual_patches import VisualPatches
from .performance_store import PerformanceStore
import webbrowser
from .midi_service import MidiService
from .monitor_audio import MonitorAudio
from .cue_tracks import CueTracks
from . import update_check
from .power_service import PowerService


PROJECT=Path(__file__).resolve().parent.parent


class Application:
    def __init__(self,root,project_dir=PROJECT):
        self.token=secrets.token_urlsafe(32)
        self.library=Library(root,project_dir=project_dir)
        # your own visualizations: a folder beside the app (never inside it), so an update never touches them
        self.my_visuals=Path(project_dir)/'My Visuals'
        self.user_midi=UserMidi(self.library)   # your own MIDI files, kept with each song
        self.cue_tracks=CueTracks(self.library) # a song's cue track, if you've given it one
        self.visual_patches=VisualPatches(self.library)   # the patch bay's patches (which sounds drive which parts of a visualization)
        self.performances=PerformanceStore(self.library)   # saved arrangements of a song, and shows made of them
        self.midi=MidiService()    # live MIDI to and from a pedal or controller (opens nothing until a show or the setup asks)
        self.monitor=MonitorAudio(project_dir)   # the click and the cue track: only you hear them, OBS doesn't (opens nothing until there's something to play)
        self.power=PowerService()  # keeps the computer awake during a show
        # visualizers in another browser (an OBS Browser Source): the player's messages, relayed; their address has a key kept with the library
        self.visual_relay=VisualRelay()
        self.stream_key_path=self.library.root/'visualizer-stream.key'
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

    def open_user_midi(self,song_id,file_id):
        # The stored file itself, not a copy: export back over it from the music program and the change is picked up.
        path=self.user_midi.path(song_id,file_id)
        result={'path':str(path),'opened':False,'message':''}
        try:
            if os.name=='nt':
                os.startfile(str(path))
                result['opened']=True
            else:result['message']='Open this file in your music program: '+str(path)
        except OSError:
            result['message']='No program on this computer opens MIDI files yet. The file is here: '+str(path)
        if result['opened']:result['message']='Opened in your music program. Export back over this same file and Chord Buddy picks up the change.'
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
        self.midi.close()
        self.monitor.close()
        self.power.close()
        self.visual_relay.close()
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
    allow_reuse_address=os.name!='nt'   # on Windows it would let a second server share a port that is already in use
    # Connections waiting to be taken up. Python's default is 5, and a page opens far more than that at once (about 20 stylesheets and scripts, besides
    # requests that stay open, like MIDI input). Windows refuses one past the limit, and a refused stylesheet is never asked for again: the page came up
    # without some of its styles, more often the more the page asked for at startup.
    request_queue_size=128

    def server_close(self):
        super().server_close()
        if hasattr(self,'app'):self.app.close()       # a port that could not be bound closes before there is an app


# What the OBS stream key may read: the three things a visualizer fetches to draw a song, nothing that changes anything or reaches elsewhere.
STREAM_READS=re.compile(r'/api/(document/[^/]+|visual-features/[^/]+|user-midi/[^/]+/[^/]+)')


class Handler(BaseHTTPRequestHandler):
    server_version='ChordBuddy'
    # HTTP/1.1 so the page's many small files can share a connection. Only a finished static file keeps it open (see _static): everything else
    # (uploads that may stop early, streams without a length) closes as it always did, so a leftover body can never be read as the next request.
    protocol_version='HTTP/1.1'
    cache_policy='no-store'

    def handle(self):
        # A page that closes a kept-open connection (every tab close, every reload) is normal; on Windows it arrives as an abort or a reset.
        try:super().handle()
        except ConnectionError:pass

    def log_message(self,*args):
        # URLs can contain the private session token; do not print them.
        pass

    @property
    def app(self):
        return self.server.app

    def end_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Cross-Origin-Resource-Policy','same-origin')   # another website cannot embed or read anything this app serves
        self.send_header('Cache-Control',self.cache_policy)
        if self.close_connection:self.send_header('Connection','close')
        # 'wasm-unsafe-eval' lets the page compile WebAssembly (Signalsmith Stretch, for practice speed) and nothing else: eval stays blocked.
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'self' blob:; frame-ancestors 'none'")
        super().end_headers()

    def _allowed(self,path,query,method='POST'):
        expected=f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host')!=expected:
            return False
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://{expected}':
            return False
        if path.startswith('/api/'):
            token=self.headers.get('X-ChordBuddy-Token','')
            if path.startswith(('/api/audio/','/api/export/','/api/mix-export/','/api/stems-export/','/api/export-midi/','/api/export-outputs/','/api/song-export/','/api/visual-relay/player')):
                token=token or query.get('token',[''])[0]
            if secrets.compare_digest(token,self.app.token):return True
            # A visualizer in OBS holds only the stream key, never the session token: the key opens just the reads that draw a song.
            offered=self.headers.get('X-ChordBuddy-Stream','')
            key=stream_key(self.app.stream_key_path) if offered and method=='GET' and STREAM_READS.fullmatch(path) else None
            return bool(key) and secrets.compare_digest(offered,key)
        return True

    def _json(self,value,status=200):
        body=json.dumps(value,allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_if_changed(self,value):
        # For the answers the page asks for again and again (its regular poll). Each answer carries a tag made from its own bytes; a page
        # that sends the tag back (If-None-Match) while nothing changed gets a tiny 304 with no body, so it has nothing to read or redraw.
        # The page does this itself: the answer stays "no-store", so the browser never keeps or reuses one, and the connection still closes.
        body=json.dumps(value,allow_nan=False).encode('utf-8')
        tag='"'+blake2b(body,digest_size=12).hexdigest()+'"'
        same=tag in [t.strip() for t in self.headers.get('If-None-Match','').split(',')]
        self.send_response(304 if same else 200)
        self.send_header('ETag',tag)
        if not same:self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length','0' if same else str(len(body)))
        self.end_headers()
        if not same:self.wfile.write(body)

    def _body_size(self):
        try:return int(self.headers.get('Content-Length','0'))
        except ValueError:raise ValueError('Invalid request size')

    def _read(self,limit):
        size=self._body_size()
        if not 0<size<=limit:
            raise ValueError('The file or request is empty or too large')
        self.connection.settimeout(120)
        body=self.rfile.read(size)
        if len(body)!=size:
            raise ValueError('The upload was interrupted')
        return body

    def _models_import(self,query):
        # A model file the user already has: streamed to disk (they are large), then accepted only if its fingerprint is exactly right.
        size=int(self.headers.get('Content-Length','0'))     # not _body_size: a size that is no number is refused in Python's own words. loose on purpose? see report
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
            return self.app.models.adopt(_first(query,'name'),temp,move=True)
        finally:
            temp.unlink(missing_ok=True)

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def _dispatch(self,method):
        self.close_connection=True           # until a static file says otherwise
        self.cache_policy='no-store'
        self.connection.settimeout(None)     # the short wait between a kept-open connection's requests is over
        url=urlparse(self.path)
        path=unquote(url.path)
        query=parse_qs(url.query)
        try:
            if not self._allowed(path,query,method):
                self._json({'error':'This request is not authorized'},403)
                return
            if method=='GET':self._get(path,query)
            else:self._post(path,query)
        except RevisionConflict as exc:
            self._json({'error':str(exc)},409)
        except KeyError as exc:
            self._json({'error':str(exc).strip("'")},404)
        except (ValueError,TypeError) as exc:
            self._json({'error':str(exc)},400)
        except ConnectionError:
            pass          # the page went away mid-answer (a seek in the audio, a closed tab); Windows reports it as aborted as often as reset
        except OSError as exc:
            self._fail(f'Unable to read or save the file: {exc}',500)
        except Exception as exc:
            self._fail(f'Chord Buddy could not complete this action: {exc}',500)

    def _get(self,path,query=None):
        kind,handler,pieces=find_route(GET_ROUTES,path) or (None,None,())
        if kind is None:
            if path.startswith('/api/'):raise KeyError('Unknown action')
            return self._static(path)
        answer=handler(self,query or {},*pieces)
        if kind==OWN:return answer          # the handler wrote the whole answer itself
        return self._json_if_changed(answer) if kind==POLLED else self._json(answer)

    def _post(self,path,query):
        # Only /api/ addresses need the session token (_allowed), so anything else is turned away here, before a body of up to 24 MB is read for nobody.
        if not path.startswith('/api/'):raise KeyError('Unknown action')
        kind,handler,pieces=find_route(POST_ROUTES,path) or (None,None,())
        if kind==UPLOAD:return self._json(handler(self,query))
        # The body is read and checked before the address is: an unknown address with a bad body is told about the body, as it always was.
        body=json.loads(self._read(24*1024*1024))
        if not isinstance(body,dict):
            raise ValueError('Expected an object')
        if kind is None:raise KeyError('Unknown action')
        return self._json(handler(self,body,*pieces))

    def _fail(self,message,status):
        try:self._json({'error':message},status)
        except OSError:pass       # the page is gone, or the answer had already begun: nothing left to tell it

    def _event_stream(self,role):
        # server-sent events from the visual relay, until the browser goes away
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream; charset=utf-8')
        self.end_headers()
        self.close_connection=True
        def write(text):
            self.wfile.write(text.encode('utf-8'));self.wfile.flush()
        try:self.app.visual_relay.stream(role,write)
        except OSError:pass                              # the page closed or reloaded (Windows reports it as aborted, not reset)

    def _attachment(self,kind,name,size=None):
        # The headers of a download. Without a size it is a stream: its end is the connection closing.
        self.send_response(200)
        self.send_header('Content-Type',kind)
        self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(name))
        if size is not None:self.send_header('Content-Length',str(size))
        self.close_connection=True
        self.end_headers()

    def _download(self,data,name):
        self._attachment('application/octet-stream',name,len(data))
        self.wfile.write(data)

    def _run_files(self,run_id):
        # where a run's audio is: the song's own recording (playable before any stems exist), or a finished separation
        if original_playback.song_of(run_id):
            description=self.app.playback.original_run(original_playback.song_of(run_id));return description['root'],description['manifest']
        return self.app.separation_store.get_published_run(run_id)

    def _idle(self,song_id):
        # the same id back, once the song is known not to be mid-analysis: its files would change under an export
        if self.app._song_busy(song_id):raise RevisionConflict('This song is being analyzed. Wait for it to finish, then export it.')
        return song_id

    # --- GET routes that take more than a line (GET_ROUTES below points here) ---

    def _viewer_stream(self,query):
        key=stream_key(self.app.stream_key_path)
        if not key or not secrets.compare_digest(_first(query,'key'),key):
            return self._json({'error':'This stream address is not valid. Copy it again from Chord Buddy (More options, Visualizer for OBS).'},403)
        self._event_stream('viewer')

    def _relay_address(self,query):
        key=stream_key(self.app.stream_key_path,True)
        return {'url':f'http://127.0.0.1:{self.server.server_port}/visualizer.html?stream={key}','port':self.server.server_port}

    def _user_midi(self,query,rest):
        parts=rest.split('/')
        if len(parts)==1:return self._json({'files':self.app.user_midi.list(parts[0])})
        if len(parts)==2:
            data=self.app.user_midi.read(parts[0],parts[1])
            self.send_response(200)
            self.send_header('Content-Type','audio/midi')
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        raise KeyError('Page not found')

    def _rhythm_proposal(self,query,document_id,version_id):
        doc=self.app.documents.get(document_id);version=self.app.documents.timing.version(version_id)
        stamp=self.app.documents.revision_stamp(doc['id'])
        if version['transcription_id']!=doc['run_id'] or version['source_sha256']!=stamp['source_sha256']:raise ValueError('Proposal belongs to another source')
        return version

    def _waveform(self,query,run_id):
        root,manifest=self._run_files(run_id)
        asset=next(a for a in manifest['assets'] if a['role']=='original')
        key=(run_id,asset['file_sha256'])
        with self.app.waveform_lock:
            if key not in self.app.waveform_cache:
                value=waveform_peaks(asset,lambda start,count:read_frames(root/asset['relative_path'],asset,start,count))
                if len(self.app.waveform_cache)>=2:self.app.waveform_cache.pop(next(iter(self.app.waveform_cache)))
                self.app.waveform_cache[key]=dict(value,run_id=run_id)
            return self.app.waveform_cache[key]

    def _mix_export(self,query,run_id):
        levels,master=parse_levels(_first(query,'levels'),_first(query,'master','1'))
        root,manifest=self.app.separation_store.get_published_run(run_id)
        self._attachment('audio/mpeg',_download_name(query,'Chord Buddy mix',120)+'.mp3')
        encode_mix(PROJECT,root,manifest,levels,master,self.wfile.write)

    def _stems_export(self,query,run_id):
        root,manifest=self.app.separation_store.get_published_run(run_id)
        name=_download_name(query,'Chord Buddy',100)
        self._attachment('application/zip',name+' - stems.zip')
        export_stems(PROJECT,root,manifest,name,self.wfile.write)

    def _song_export(self,query,song_id):
        # The whole song (recording, analysis, edits and, if asked, stems) as one zip named after the song.
        manifest,files,name=self.app.transfer.export_plan(self._idle(song_id),_first(query,'stems','0')=='1')
        self._attachment('application/zip',name)
        self.app.transfer.write_zip(manifest,files,self.wfile.write)

    def _separation_audio(self,query,run_id):
        if set(query)!={'start_frame','frame_count'} or any(len(v)!=1 for v in query.values()):raise ValueError('Expected frame bounds')
        start=int(query['start_frame'][0]);count=int(query['frame_count'][0])     # any whole number, negative too. loose on purpose? see report
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
        self.end_headers();self.wfile.write(payload)

    def _static(self,path):
        web=(PROJECT/'chordbuddy'/'web').resolve()
        if path=='/visualizations/index.json':
            # the visualizer's scenes: every .js file in web/visualizations whose name does not start with _ (templates, drafts)
            # with a version for each (its time and size), so a file that was changed is loaded fresh; files can come and go at any time.
            # `mine` lists the same for the My Visuals folder in the app's root (served at /my-visuals/).
            def scan(folder):
                versions={}
                try:files=list(folder.glob('*.js'))
                except OSError:files=[]
                for p in files:
                    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 _-]*\.js',p.name):continue
                    try:
                        if p.is_file():stat=p.stat();versions[p.name]=f'{stat.st_mtime_ns:x}-{stat.st_size:x}'
                    except OSError:continue                      # deleted while being listed
                return versions
            versions,mine=scan(web/'visualizations'),scan(self.app.my_visuals)
            return self._json({'files':sorted(versions),'versions':versions,'mine':sorted(mine),'mine_versions':mine})
        if path.startswith('/my-visuals/'):
            # a file of My Visuals (a visualization, or a picture or font it uses), never anything outside that folder
            web=self.app.my_visuals.resolve();relative=path.removeprefix('/my-visuals/')
        else:
            relative='index.html' if path=='/' else path.lstrip('/')
        # Looked at before anything touches the disk: on Windows a name with a drive letter or a leading backslash ("\\host\share") is an
        # absolute path, and merely resolving a network one makes the computer try to sign in to that host.
        if any(c in relative for c in '\\:\x00') or relative.startswith('/'):
            raise KeyError('Page not found')
        target=(web/relative).resolve()
        if not target.is_relative_to(web) or not target.is_file():
            raise KeyError('Page not found')
        stat=target.stat()
        # Always asked about, never trusted blindly: "no-cache" plus a tag from the file's own time and size means an unchanged file costs one
        # tiny answer (304), and an updated app or an edited visualization is still seen at once.
        tag='"%x-%x"'%(stat.st_mtime_ns,stat.st_size)
        self.cache_policy='no-cache'
        same=tag in [t.strip() for t in self.headers.get('If-None-Match','').split(',')]
        if same:
            self.send_response(304)
            self.send_header('ETag',tag)
            self.send_header('Content-Length','0')
        else:
            body=target.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type',mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length',str(len(body)))
            self.send_header('ETag',tag)
        self.close_connection=False
        self.end_headers()
        if not same:self.wfile.write(body)
        self.connection.settimeout(15)       # an idle kept-open connection is closed after a moment

    # --- POST routes that take more than a line (POST_ROUTES below points here) ---

    def _song_import(self,query):
        # A song zip from another computer can be gigabytes: it is streamed to disk, never held in memory.
        size=self._body_size()
        self.connection.settimeout(120)
        return self.app.transfer.receive(self.rfile.read,size)

    def _user_midi_upload(self,query):
        midi=self.app.user_midi;song=_first(query,'song');name=_first(query,'name')
        if _first(query,'unique')=='1':name=midi.next_name(song,name or 'Custom MIDI')   # generated files never collide with or overwrite anything
        return midi.add(song,name,self._read(16*1024*1024),_first(query,'replace',None))

    def _song_metadata(self,body):
        song_id=body.get('song_id',body.get('id'))     # no song at all goes on as None, for the document store to refuse. loose on purpose? see report
        metadata=body.get('metadata')
        if metadata is None:
            metadata={k:body[k] for k in ('timing','chord_overrides') if k in body}
        return self.app.documents.apply_song_metadata(song_id,metadata,body.get('revision'))

    def _confirm_chord(self,body):
        song_id=body.get('song_id',body.get('id'))
        current=self.app.library.song_metadata(song_id)
        overrides=[item for item in current['chord_overrides'] if item['id']!=body.get('id')]
        override={k:body[k] for k in ('id','start','end','label') if k in body}
        override['confirmed']=True
        overrides.append(override)
        return self.app.documents.apply_song_metadata(song_id,{'timing':current['timing'],'chord_overrides':overrides},body.get('revision'))

    def _open_folder(self,body):
        folder=self.app.library.folder(body['song_id'])
        if os.name=='nt':os.startfile(str(folder))
        return {'ok':True}

    def _update_page(self,body):
        webbrowser.open(update_check.PAGE_URL)     # always this one address: nothing in the request can change where it goes
        return {'opened':True}

    def _monitor_load(self,body):
        track=self.app.cue_tracks.get(body['song_id'])
        if not track:raise KeyError('This song has no cue track')
        return {**self.app.monitor.load_track(track['version'],self.app.cue_tracks.path(body['song_id'])),'key':track['version']}

    def _cue_track_remove(self,body):
        self.app.cue_tracks.remove(body['song_id']);return {'ok':True}

    def _user_midi_remove(self,body):
        self.app.user_midi.remove(body['song_id'],body['id']);return {'ok':True}

    def _user_midi_folder(self,body):
        folder=self.app.user_midi.folder_path(body['song_id'])
        if os.name=='nt':os.startfile(str(folder))
        return {'ok':True,'path':str(folder)}

    def _document(self,body,rest):
        tail=rest.split('/')
        if len(tail)==1:
            return self.app.documents.save(tail[0],body['content'],body.get('label','Edit document'),body['revision'])
        if len(tail)==2 and tail[1]=='export':
            return self.app.documents.retry_export(tail[0],body['revision'])
        if len(tail)==2:
            return self.app.documents.history(tail[0],tail[1],body['revision'],body.get('position'))
        raise KeyError('Unknown document action')

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


# --- The routes -------------------------------------------------------------------------------------------------------------------------
# One line per address: (address, how it is answered, what answers it). In an address {id} stands for one piece between slashes (never empty)
# and {rest} for everything after a prefix (slashes and all, possibly nothing); they reach the handler as its last arguments, in order.
# The FIRST line that matches wins, so a {rest} comes after any longer address it would swallow. How a route is answered:
#   JSON     the handler returns a value, sent as JSON. GET: handler(h,query,*pieces). POST: handler(h,body,*pieces), body a JSON object.
#   POLLED   the same for a GET the page repeats: tagged, so an unchanged answer is a 304 (see _json_if_changed)
#   OWN      a GET whose handler writes the whole answer itself: a stream, a download, an error of its own
#   UPLOAD   a POST whose body is a file, not JSON: handler(h,query) reads it and returns a value, sent as JSON
# A handler raises to refuse (see _dispatch for which error is which status). Nothing here checks the type of a body field: each service
# checks its own, and a missing field ends as a 404 that names it. loose on purpose? see report
JSON,POLLED,OWN,UPLOAD='json','polled','own','upload'


def _first(query,name,default=''):
    return query.get(name,[default])[0]


def _revision(query):
    revision=_first(query,'revision',None)
    return int(revision) if revision is not None else None


def _download_name(query,default,limit):
    # the name a download is saved under: nothing Windows refuses in a file name, and never empty
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+',' ',_first(query,'name',default)).strip()[:limit] or default


def _routes(rows):
    def pattern(address):
        pieces=re.split(r'(\{id\}|\{rest\})',address)
        return re.compile(''.join('([^/]+)' if p=='{id}' else '(.*)' if p=='{rest}' else re.escape(p) for p in pieces),re.DOTALL)
    return [(pattern(address),kind,handler) for address,kind,handler in rows]


def find_route(table,path):
    """(kind, handler, pieces) of the first route whose address is this path, or None."""
    for pattern,kind,handler in table:
        match=pattern.fullmatch(path)
        if match:return kind,handler,match.groups()
    return None


# The OBS stream key may read /api/document/, /api/visual-features/ and one file of /api/user-midi/ (STREAM_READS above): keep the two in step.
GET_ROUTES=_routes([
    ('/visual-stream',OWN,Handler._viewer_stream),
    ('/api/visual-relay/address',JSON,Handler._relay_address),
    ('/api/visual-relay/player',OWN,lambda h,q:h._event_stream('player')),
    ('/api/update-check',JSON,lambda h,q:update_check.check()),
    ('/api/monitor/status',JSON,lambda h,q:h.app.monitor.status()),
    ('/api/cue-track/{rest}',JSON,lambda h,q,song:{'track':h.app.cue_tracks.get(song)}),
    ('/api/midi/ports',JSON,lambda h,q:h.app.midi.ports()),
    ('/api/midi/status',JSON,lambda h,q:h.app.midi.status()),
    ('/api/midi/log',JSON,lambda h,q:list(h.app.midi.log)),
    ('/api/midi/events',JSON,lambda h,q:h.app.midi.read_events(int(_first(q,'after','0')),float(_first(q,'wait','0')))),     # "nan" and "inf" get through here; read_events copes. loose on purpose? see report
    ('/api/power',JSON,lambda h,q:h.app.power.status()),
    ('/api/shows',JSON,lambda h,q:h.app.performances.shows()),
    ('/api/performances/{rest}',JSON,lambda h,q,song:h.app.performances.performances_for_song(song)),
    ('/api/show/{id}/export',JSON,lambda h,q,show:h.app.performances.export_show(show,h.app.visual_patches)),
    ('/api/performance/{rest}',JSON,lambda h,q,performance:h.app.performances.performance(performance,_revision(q))),
    ('/api/show/{rest}',JSON,lambda h,q,show:h.app.performances.show(show,_revision(q))),
    ('/api/visual-patches',JSON,lambda h,q:h.app.visual_patches.read()),
    ('/api/visual-patches/{rest}',JSON,lambda h,q,song:h.app.visual_patches.read(song)),
    ('/api/user-midi/{rest}',OWN,Handler._user_midi),
    ('/api/documents/{id}/rhythm/proposals/{id}',JSON,Handler._rhythm_proposal),
    ('/api/waveform/{rest}',JSON,Handler._waveform),
    ('/api/mix-export/{rest}',OWN,Handler._mix_export),
    ('/api/stems-export/{rest}',OWN,Handler._stems_export),
    ('/api/song-export/{rest}',OWN,Handler._song_export),
    ('/api/separation-audio/{rest}',OWN,Handler._separation_audio),
    ('/api/visual-features/{rest}',JSON,lambda h,q,run:visual_features.load_or_compute(*h._run_files(run))),
    ('/api/playback/{rest}',POLLED,lambda h,q,song:h.app.playback_state(song)),
    ('/api/separation/{rest}',POLLED,lambda h,q,song:h.app.separation_store.get_song_state(song)),
    ('/api/prefs',JSON,lambda h,q:h.app.library.read_prefs()),
    ('/api/models',JSON,lambda h,q:h.app.models.status()),
    ('/api/chord-model',JSON,lambda h,q:h.app.chord_model.status()),
    ('/api/state',POLLED,lambda h,q:h.app.state()),
    ('/api/song/{rest}',JSON,lambda h,q,song:h.app.documents.song_detail(song)),
    ('/api/document/{rest}',JSON,lambda h,q,document:h.app.documents.get(document)),
    ('/api/audio/{rest}',OWN,lambda h,q,song:h._audio(h.app.library.source_path(song))),
    ('/api/export/{rest}',OWN,lambda h,q,document:h._download(*h.app.documents.export(document))),
    ('/api/export-midi/{rest}',OWN,lambda h,q,document:h._download(*h.app.documents.midi_download(document,_first(q,'mode','single')))),
    ('/api/export-outputs/{rest}',OWN,lambda h,q,document:h._download(*h.app.documents.outputs_zip(document))),
])

POST_ROUTES=_routes([
    ('/api/models/import',UPLOAD,Handler._models_import),
    ('/api/song-import',UPLOAD,Handler._song_import),
    ('/api/import',UPLOAD,lambda h,q:h.app.library.import_audio(_first(q,'filename'),h._read(250*1024*1024),_first(q,'setlist','default'))),
    ('/api/cue-track/upload',UPLOAD,lambda h,q:h.app.cue_tracks.add(_first(q,'song'),_first(q,'name'),h._read(250*1024*1024))),
    ('/api/user-midi/upload',UPLOAD,Handler._user_midi_upload),
    ('/api/visual-relay/send',JSON,lambda h,b:{'viewers':h.app.visual_relay.send(b.get('messages'))}),
    ('/api/documents/{id}/timing',JSON,lambda h,b,document:h.app.documents.set_chart_timing(document,b['timing'],b['revision'])),
    ('/api/documents/{id}/cleanup/preview',JSON,lambda h,b,document:h.app.documents.preview_cleanup(document)),
    ('/api/documents/{id}/cleanup/apply',JSON,lambda h,b,document:h.app.documents.apply_cleanup(document,b['preview'],b['revision'])),
    ('/api/documents/{id}/rhythm/propose',JSON,lambda h,b,document:h.app.propose_rhythm(document)),
    ('/api/documents/{id}/rhythm/preview',JSON,lambda h,b,document:h.app.rhythm.preview(document,b['proposal_id'],b['policy'])),
    ('/api/documents/{id}/rhythm/apply',JSON,lambda h,b,document:h.app.rhythm.apply(document,b['preview_id'],b['stamp'],b['policy'])),
    ('/api/songs/{id}/analyze',JSON,lambda h,b,song:h.app.analyze(song,b.get('invalidate',[]),b.get('stems',True),b.get('edit_policy','keep'))),
    ('/api/analysis/{id}/cancel',JSON,lambda h,b,job:h.app.analysis.cancel(job)),
    ('/api/separate',JSON,lambda h,b:h.app.separate(b['song_id'],b.get('rerun',False))),
    ('/api/separation/cancel',JSON,lambda h,b:h.app.separation.cancel(b['job_id'])),
    ('/api/song',JSON,lambda h,b:h.app.library.rename_song(b['id'],b['title'],b.get('artist'))),
    ('/api/song/trash',JSON,lambda h,b:h.app.trash_song(b['id'])),
    ('/api/song/restore',JSON,lambda h,b:h.app.library.restore_song(b['id'])),
    ('/api/song/purge',JSON,lambda h,b:h.app.purge_song(b['id'])),
    ('/api/song-export/info',JSON,lambda h,b:h.app.transfer.sizes(h._idle(b['song_id']))),
    ('/api/song-import/apply',JSON,lambda h,b:h.app.transfer.apply(b['token'],b.get('mode'),b.get('analysis',False),b.get('stems',False),b.get('setlist') or 'default',b.get('target'))),
    ('/api/song-import/cancel',JSON,lambda h,b:h.app.transfer.cancel(b['token'])),
    ('/api/setlist',JSON,lambda h,b:h.app.library.create_setlist(b['name'])),
    ('/api/setlist/rename',JSON,lambda h,b:h.app.library.rename_setlist(b['id'],b['name'])),
    ('/api/setlist/delete',JSON,lambda h,b:h.app.library.delete_setlist(b['id'])),
    ('/api/setlist/order',JSON,lambda h,b:h.app.library.reorder_setlist(b['id'],b['song_ids'])),
    ('/api/setlist/add',JSON,lambda h,b:h.app.library.add_to_setlist(b['id'],b['song_id'])),
    ('/api/setlist/remove',JSON,lambda h,b:h.app.library.remove_from_setlist(b['id'],b['song_id'])),
    ('/api/prefs',JSON,lambda h,b:h.app.library.write_prefs(b)),
    ('/api/models/download',JSON,lambda h,b:h.app.models.start()),
    ('/api/models/cancel',JSON,lambda h,b:h.app.models.cancel()),
    ('/api/chord-model/download',JSON,lambda h,b:h.app.chord_model.start()),
    ('/api/chord-model/cancel',JSON,lambda h,b:h.app.chord_model.cancel()),
    ('/api/settings',JSON,lambda h,b:h.app.library.settings(b)),
    ('/api/song-metadata',JSON,Handler._song_metadata),
    ('/api/confirm-chord',JSON,Handler._confirm_chord),
    ('/api/start-chord-at-measure',JSON,lambda h,b:h.app.documents.start_chord_at_measure(b['song_id'],b['chord_id'],b['measure_id'],b.get('revision'),b.get('document_id'))),
    ('/api/transcribe',JSON,lambda h,b:h.app.transcribe(b['song_id'],b.get('edit_policy'))),
    ('/api/activate-run',JSON,lambda h,b:h.app.activate_run(b['song_id'],b['run_id'])),
    ('/api/cancel',JSON,lambda h,b:h.app.engine.cancel()),
    ('/api/lead-sheet/external',JSON,lambda h,b:h.app.open_external_score(b['song_id'],b.get('filename'),b.get('xml'))),
    ('/api/midi/external',JSON,lambda h,b:h.app.open_external_midi(b['song_id'],b['document_id'])),
    ('/api/open-folder',JSON,Handler._open_folder),
    ('/api/update-page',JSON,Handler._update_page),
    ('/api/monitor/schedule',JSON,lambda h,b:h.app.monitor.schedule(b['events'])),
    ('/api/monitor/cancel',JSON,lambda h,b:h.app.monitor.cancel(b.get('from'))),
    ('/api/monitor/gains',JSON,lambda h,b:h.app.monitor.set_gains(b.get('click'),b.get('cue'))),
    ('/api/monitor/load',JSON,Handler._monitor_load),
    ('/api/cue-track/remove',JSON,Handler._cue_track_remove),
    ('/api/midi/connect',JSON,lambda h,b:h.app.midi.connect(b['name'],output=b.get('output',True) is not False,input=b.get('input',True) is not False)),     # only a real false turns one off: 0 or "no" leave it on. loose on purpose? see report
    ('/api/midi/disconnect',JSON,lambda h,b:h.app.midi.disconnect(b['name'])),
    ('/api/midi/schedule',JSON,lambda h,b:h.app.midi.schedule(b['device'],b['events'],b.get('generation',0))),
    ('/api/midi/cancel',JSON,lambda h,b:h.app.midi.cancel(b.get('device'),b.get('from'),b.get('generation'))),
    ('/api/midi/cleanup',JSON,lambda h,b:h.app.midi.cleanup(b.get('device'))),
    ('/api/power/acquire',JSON,lambda h,b:h.app.power.acquire(b['holder'])),
    ('/api/power/release',JSON,lambda h,b:h.app.power.release(b['holder'])),
    ('/api/performance/save',JSON,lambda h,b:h.app.performances.save_performance(b['body'],b['base'])),
    ('/api/performance/draft',JSON,lambda h,b:h.app.performances.save_performance_draft(b['body'],b['base'])),
    ('/api/performance/delete',JSON,lambda h,b:h.app.performances.delete_performance(b['id'])),
    ('/api/show/save',JSON,lambda h,b:h.app.performances.save_show(b['body'],b['base'])),
    ('/api/show/draft',JSON,lambda h,b:h.app.performances.save_show_draft(b['body'],b['base'])),
    ('/api/show/import',JSON,lambda h,b:h.app.performances.import_show(b['bundle'],h.app.visual_patches)),
    ('/api/show/delete',JSON,lambda h,b:h.app.performances.delete_show(b['id'])),
    ('/api/visual-patches',JSON,lambda h,b:h.app.visual_patches.save(b['visual'],b.get('patch'),b.get('song_id'))),
    ('/api/user-midi/settings',JSON,lambda h,b:h.app.user_midi.save_settings(b['song_id'],b['id'],b['settings'])),
    ('/api/user-midi/rename',JSON,lambda h,b:h.app.user_midi.rename(b['song_id'],b['id'],b['name'])),
    ('/api/user-midi/remove',JSON,Handler._user_midi_remove),
    ('/api/user-midi/open',JSON,lambda h,b:h.app.open_user_midi(b['song_id'],b['id'])),
    ('/api/user-midi/folder',JSON,Handler._user_midi_folder),
    ('/api/document/{rest}',JSON,Handler._document),
])


def make_server(root,port=0,project_dir=PROJECT):
    server=Server(('127.0.0.1',port),Handler)
    server.app=Application(root,project_dir)
    return server
