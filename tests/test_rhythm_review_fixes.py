import copy,json,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,Mock
import pytest
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from test_timing_history import fixture
from test_reprocess import seed,ingest
from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore,RevisionConflict
from chordbuddy.rhythm_apply import RhythmService,build_rhythm_preview
from chordbuddy.analysis import AnalysisCoordinator
from chordbuddy.separation_contract import file_hash
from chordbuddy.inference_jobs import InferenceGate

def test_preview_must_not_stamp_old_content_with_new_revision(tmp_path):
    lib,docs,before=fixture(tmp_path)
    try:
        version=docs.timing_version(before);version['bars'][0]['beats'][1]=1.2;version['diagnostics']={'status':'accepted'}
        ident=docs.timing.put_version(version)
        service=RhythmService(SimpleNamespace(documents=docs))
        real_stamp=docs.revision_stamp
        def interleaved_edit(document_id):
            docs.revision_stamp=real_stamp
            changed=copy.deepcopy(before['content']);changed['sections'][0]['lyrics']='Concurrent user lyric'
            docs.save(document_id,changed,'Concurrent edit',before['revision'])
            return real_stamp(document_id)
        docs.revision_stamp=interleaved_edit
        try:
            preview=service.preview(before['id'],ident,'clear')
            saved=service.apply(before['id'],preview['id'],preview['stamp'],'clear')
        except RevisionConflict:
            saved=docs.get(before['id'])
        assert saved['content']['sections'][0]['lyrics']=='Concurrent user lyric', 'Preview read old content, stamped the newer revision, and overwrote the concurrent lyric'
    finally:lib.close()

def test_chord_confirmation_on_manual_grid_keeps_valid_layout(tmp_path):
    lib,docs,before=fixture(tmp_path)
    try:
        timed=docs.set_chart_timing(before['id'],{'constant_tempo':True,'bpm':80},before['revision'])
        content=copy.deepcopy(timed['content']);content['layout']={'bars_per_line':4,'breaks':['m4'],'bar_overrides':[],'lines':[]}
        docs.save(before['id'],content,'Format new grid',timed['revision'])
        try:
            docs.apply_song_metadata('song',{'timing':{'constant_tempo':False,'bpm':None},'chord_overrides':[{'id':'confirmed','label':'F','start':0,'end':2}]})
        except ValueError as exc:
            pytest.fail('Valid selected-grid formatting blocks chord confirmation: '+str(exc))
    finally:lib.close()

def test_legacy_binding_does_not_drift_when_chart_is_retained(tmp_path):
    lib,docs,before=fixture(tmp_path)
    try:
        # Recreate an existing pre-upgrade chart: global tempo edited after inference,
        # edited lyrics, and no companion timing rows yet.
        options=lib.folder('song')/'runs'/before['run_id']/'run-options.json'
        value=json.loads(options.read_text());value['metadata']={'timing':{'constant_tempo':False,'bpm':None}}
        options.write_text(json.dumps(value))
        lib.save_song_metadata('song',{'timing':{'constant_tempo':True,'bpm':80}})
        changed=copy.deepcopy(before['content']);changed['sections'][0]['lyrics']='Legacy user lyric'
        with lib.transaction() as db:
            db.execute('INSERT INTO edits VALUES(?,?,?,?)',(before['id'],1,json.dumps(changed),'Legacy lyrics'))
            db.execute('UPDATE documents SET cursor=1,revision=1 WHERE id=?',(before['id'],))
        before=docs.get(before['id'])
        ingest(docs,policy='keep',previous=before['run_id'])
        after=docs.get(before['id'])
        assert after['kept']
        assert after['timing_binding']==before['timing_binding'], f'Legacy retained grid drifted: {before["timing_binding"]} -> {after["timing_binding"]}'
    finally:lib.close()

def test_plain_chart_rename_with_unavailable_source(tmp_path):
    lib,docs,before=fixture(tmp_path)
    try:
        source=lib.source_path('song');source.rename(source.with_suffix('.temporarily-unavailable'))
        content=copy.deepcopy(before['content']);content['sections'][0]['name']='Offline rename'
        try:docs.save(before['id'],content,'Rename',before['revision'])
        except OSError as exc:pytest.fail('Source audio access unexpectedly required for a plain chart edit: '+str(exc))
    finally:lib.close()

def test_clear_grid_maps_break_by_recording_time_not_ordinal(tmp_path):
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib)
    try:
        ingest(docs,extra={'beat.lab':''.join(f'{i*.5} {i%4+1} 4 4\n' for i in range(40)),'downbeat.lab':''.join(f'{i*2}\n' for i in range(10))})
        before=docs.get(next(d['id'] for d in docs.for_song('song') if d['kind']=='chart'))
        original=docs.timing_version(before);original['diagnostics']={'status':'accepted'}
        timed=docs.set_chart_timing(before['id'],{'constant_tempo':True,'bpm':60},before['revision'])
        timed['content']['layout']={'bars_per_line':4,'breaks':['m1'],'bar_overrides':[],'lines':[]}
        result=build_rhythm_preview(timed,original,'clear')
        assert not result['conflicts']
        new_id=result['content']['layout']['breaks'][0]
        before_time=next(b['start'] for b in timed['music']['measures'] if b['id']=='m1')
        after_time=next(b['start'] for b in original['bars'] if b['id']==new_id)
        assert after_time==before_time, f'Formatting moved from {before_time}s to unrelated ordinal bar at {after_time}s'
    finally:lib.close()

def test_cache_hit_does_not_derive_chart_from_other_source(tmp_path):
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib)
    job=AnalysisCoordinator(ROOT,lib,docs,None,None,None,InferenceGate())
    job.job={'id':'job','song_id':'song','status':'running','stage':'transcription','stages':{}}
    job.prepared=lib.source_path('song')
    source=lib.source_path('song');calls=[]
    def start(song_id,prepared,run,device):
        calls.append(1);(run/'score.abc').write_text('X:1\nK:C\nC4|')
        job.engine_result=(song_id,run,'completed',None)
    job.engine=Mock(start=start,wait=lambda:None)
    try:
        with patch('chordbuddy.analysis.transcription_recipe',lambda *a:{'fixture':'model'}):
            job.source_hash=file_hash(source);a=job.run_stage('transcription','job','owner',{'manifest_sha256':'prepare-a'},lambda:None)
            run_a=job.store.manifest(a)['run_id']
            chart_a=docs.get(next(d['id'] for d in docs.for_song('song') if d['kind']=='chart' and d['run_id']==run_a))
            chart_a['content']['sections'][0]['lyrics']='Keep A edits'
            docs.save(chart_a['id'],chart_a['content'],'A lyrics',chart_a['revision'])
            source.write_bytes(b'other audio');job.source_hash=file_hash(source)
            b=job.run_stage('transcription','job','owner',{'manifest_sha256':'prepare-b'},lambda:None)
            run_b=job.store.manifest(b)['run_id']
            chart_b=docs.get(next(d['id'] for d in docs.for_song('song') if d['kind']=='chart' and d['run_id']==run_b))
            chart_b['content']['sections'][0]['lyrics']='Keep B edits'
            docs.save(chart_b['id'],chart_b['content'],'B lyrics',chart_b['revision'])
            source.write_bytes(b'audio');job.source_hash=file_hash(source)
            again=job.run_stage('transcription','job','owner',{'manifest_sha256':'prepare-a'},lambda:None)
            assert again==a and len(calls)==2
            chart=job.run_stage('chart','job','owner',{'manifest_sha256':'prepare-a'},lambda:None)
            selected=docs.get(job.store.manifest(chart)['document_id'])
            assert selected['run_id']==run_a, f'Source A cache hit published chart from source B run {run_b}'
            assert not selected['kept'] and selected['content']['sections'][0]['lyrics']=='Keep A edits'
            assert docs.get(chart_b['id'])['kept'] and docs.get(chart_b['id'])['content']['sections'][0]['lyrics']=='Keep B edits'
    finally:lib.close()

def test_unobserved_passage_is_not_globally_certified(tmp_path):
    import numpy as np
    from chordbuddy.separation_audio import write_float
    from chordbuddy.rhythm import analyze_drum_rhythm
    rate=44100;audio=np.zeros((22*rate,2),dtype=np.float32)
    for i in range(32):
        start=round((.5+i*.5)*rate);audio[start:start+440]=np.random.default_rng(i).normal(0,.2,(440,1))*np.exp(-np.arange(440)[:,None]/80)
    path=tmp_path/'silent-ending.wav';write_float(path,audio.ravel())
    bars=[]
    for i in range(10):
        beats=[.58+2*i+.5*j for j in range(4)]
        bars.append({'id':f'm{i}','start':beats[0],'end':.58+2*(i+1),'beats':beats,'meter':[4,4]})
    result=analyze_drum_rhythm(path,{'bars':bars},{},{},lambda:None,lambda p:None)
    silent=result['bars'][8]['start']
    assert any(p['status']=='unresolved' for p in result['diagnostics'].get('passages',[])) or result['diagnostics']['status']=='unresolved', f'Silent final 4s marked accepted and moved {silent-bars[8]["start"]:.3f}s; diagnostics={result["diagnostics"]}'

def test_transcription_validation_failure_preserves_active_run(tmp_path):
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib);old=ingest(docs)
    job=AnalysisCoordinator(ROOT,lib,docs,None,None,None,InferenceGate())
    job.job={'id':'job','song_id':'song','status':'running','stage':'transcription','stages':{}}
    job.source_hash=file_hash(lib.source_path('song'));job.prepared=lib.source_path('song')
    def start(song_id,prepared,run,device):
        (run/'score.abc').write_text('X:1\nK:C\nC4|');job.engine_result=(song_id,run,'completed',None)
    job.engine=Mock(start=start,wait=lambda:None)
    def fail_artifact(path):raise OSError('Injected unreadable completed artifact')
    job._asset=fail_artifact
    try:
        with patch('chordbuddy.analysis.transcription_recipe',lambda *a:{'fixture':'model'}):
            with pytest.raises(OSError,match='unreadable'):
                job.run_stage('transcription','job','owner',{'manifest_sha256':'prepare'},lambda:None)
        assert lib.song('song')['active_run']==old, 'Transcription became active before fallible artifact validation'
    finally:lib.close()

@pytest.mark.parametrize('failure',['after_stage_insert','after_ingest'])
def test_transcription_publication_rolls_back_all_nested_writes(tmp_path,monkeypatch,failure):
    from chordbuddy.separation import Cancelled
    lib,docs,before=fixture(tmp_path);old=before['run_id']
    job=AnalysisCoordinator(ROOT,lib,docs,None,None,None,InferenceGate())
    job.job={'id':'job','song_id':'song','status':'running','stage':'transcription','stages':{}}
    job.source_hash=file_hash(lib.source_path('song'));job.prepared=lib.source_path('song')
    def start(song_id,prepared,run,device):
        (run/'score.abc').write_text('X:1\nK:C\nC4|');job.engine_result=(song_id,run,'completed',None)
    job.engine=Mock(start=start,wait=lambda:None)
    if failure=='after_stage_insert':
        publish=job.store.publish
        def fail(*args):publish(*args);raise OSError('Publication failed after insert')
        monkeypatch.setattr(job.store,'publish',fail)
    else:
        real=docs.ingest
        def cancel(*args):real(*args);job.cancelled.set()
        monkeypatch.setattr(docs,'ingest',cancel)
    try:
        with patch('chordbuddy.analysis.transcription_recipe',lambda *a:{'fixture':'model'}):
            with pytest.raises((OSError,Cancelled)):
                job.run_stage('transcription','job','owner',{'manifest_sha256':'prepared'},job.check_cancel)
        assert lib.song('song')['active_run']==old
        assert docs.get(before['id'])['content']==before['content']
        assert lib.db.execute("SELECT COUNT(*) FROM analysis_stages WHERE kind='transcription'").fetchone()[0]==0
        assert lib.db.execute('SELECT COUNT(*) FROM documents WHERE run_id!=?',(old,)).fetchone()[0]==0
    finally:lib.close()

def test_cached_separation_reselects_matching_source(tmp_path):
    from chordbuddy.separation_store import SeparationStore
    from chordbuddy.separation_audio import write_float,validate_mix
    from chordbuddy.separation_contract import TRACKS
    lib=Library(tmp_path);seed(lib);docs=DocumentStore(lib);store=SeparationStore(lib)
    separation=SimpleNamespace(store=store,current_recipe_digest=lambda:'recipe')
    job=AnalysisCoordinator(ROOT,lib,docs,None,separation,None,InferenceGate())
    job.job={'id':'job','song_id':'song','status':'running','stages':{}}
    refs=[];ids=[]
    try:
        for data in (b'audio',b'other'):
            lib.source_path('song').write_bytes(data);source_hash=file_hash(lib.source_path('song'))
            run=store.create_run('song','recipe');root=store.safe_path(run['folder'])
            for role in TRACKS:write_float(root/(role+'.wav'),[.1,-.1]*8)
            write_float(root/'guitar.wav',[.2,-.2]*8)
            manifest=validate_mix(root);manifest.update(source_sha256=source_hash,recipe_sha256='recipe',recipe={})
            store.update_progress(run['id'],'validating');store.activate_validated(run['id'],manifest)
            refs.append(job.store.publish('song','separation',{'source_sha256':source_hash,'schema':1,'recipe':'recipe','prepared':'prepared'}, {'run_id':run['id'],'assets':[job._asset(root/'manifest.json')]+[job._asset(root/a['relative_path']) for a in manifest['assets']]}));ids.append(run['id'])
        lib.source_path('song').write_bytes(b'audio');job.source_hash=file_hash(lib.source_path('song'))
        assert job.run_stage('separation','job','owner',{'manifest_sha256':'prepared'},lambda:None)==refs[0]
        assert store.get_song_state('song')['active']['run_id']==ids[0]
    finally:lib.close()

def test_rhythm_admission_rejects_closed_application(tmp_path):
    import threading
    from chordbuddy.server import Application
    app=SimpleNamespace(job_lock=threading.Lock(),_closed=True,analysis=Mock(),_inference_recovery_error=None)
    with pytest.raises(RevisionConflict,match='closing'):Application.propose_rhythm(app,'doc')
    app.analysis.propose_rhythm.assert_not_called()

def test_cleanup_rejects_known_mismatching_transcription_source(tmp_path):
    from chordbuddy.analysis_store import AnalysisStore
    lib,docs,doc=fixture(tmp_path);store=AnalysisStore(lib)
    try:
        asset=lib.folder('song')/'runs'/doc['run_id']/'beat.lab'
        store.publish('song','transcription',{'source_sha256':file_hash(lib.source_path('song'))},{'run_id':doc['run_id'],'assets':[{'path':str(asset.relative_to(lib.root)),'sha256':file_hash(asset)}]})
        lib.source_path('song').write_bytes(b'different recording')
        result=docs.preview_cleanup(doc['id'])
        assert not result['available'] and 'transcription' in result['reason'].lower()
    finally:lib.close()

def test_local_hypothesis_does_not_shift_a_silent_bar(tmp_path):
    import numpy as np
    from chordbuddy.separation_audio import write_float
    from chordbuddy.rhythm import analyze_drum_rhythm
    rate=44100;audio=np.zeros((22*rate,2),dtype=np.float32)
    for i in range(36):
        start=round((.5+i*.5)*rate);audio[start:start+440]=np.random.default_rng(i).normal(0,.2,(440,1))*np.exp(-np.arange(440)[:,None]/80)
    path=tmp_path/'local-silent.wav';write_float(path,audio.ravel());bars=[]
    for i in range(10):
        offset=.08 if i<5 else -.08;points=[.5+i*2+j*.5+offset for j in range(4)]
        bars.append({'id':f'm{i}','start':points[0],'end':.5+(i+1)*2+offset,'beats':points,'meter':[4,4]})
    for i in range(9):bars[i]['end']=bars[i+1]['start']
    result=analyze_drum_rhythm(path,{'bars':bars},{},{},lambda:None,lambda p:None)
    assert result['bars'][-1]==bars[-1]

def test_chord_confirmation_preserves_retained_grid_lyrics(tmp_path):
    lib,docs,doc=fixture(tmp_path)
    try:
        doc=docs.set_chart_timing(doc['id'],{'constant_tempo':True,'bpm':80},doc['revision'])
        content=copy.deepcopy(doc['content']);section=content['sections'][-1];section['lyrics']='hello'
        content['layout']={'bars_per_line':4,'breaks':['m4'],'bar_overrides':[],'lines':[{'section_id':section['id'],'line':0,'start_measure':'m4','end_measure':'m4','words':[{'offset':0,'measure_id':'m4','beat':0}]}]}
        saved=docs.save(doc['id'],content,'Place lyrics',doc['revision']);ingest(docs,policy='keep',previous=doc['run_id'])
        docs.apply_song_metadata('song',{'timing':{'constant_tempo':False,'bpm':None},'chord_overrides':[{'id':'confirmed','label':'F','start':0,'end':2}]})
        after=docs.get(doc['id']);assert after['kept']
        assert after['content']['layout']==saved['content']['layout'] and after['music']==saved['music']
        assert after['timing_binding']==saved['timing_binding']
    finally:lib.close()

def test_outer_commit_failure_rolls_back_nested_selection(tmp_path):
    lib,docs,doc=fixture(tmp_path);connection=lib.db
    class FailedCommit:
        def __getattr__(self,name):return getattr(connection,name)
        def commit(self):raise OSError('Injected commit failure')
    lib.db=FailedCommit()
    try:
        with pytest.raises(OSError,match='commit failure'):
            with lib.transaction() as db:
                with lib.transaction():db.execute("UPDATE songs SET active_run='uncommitted' WHERE id='song'")
        assert not connection.in_transaction
        assert lib.song('song')['active_run']==doc['run_id']
    finally:lib.db=connection;lib.close()

