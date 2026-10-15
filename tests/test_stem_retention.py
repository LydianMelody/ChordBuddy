import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from test_separation_store import seed
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.separation_audio import write_float,validate_mix
from chordbuddy.separation_contract import TRACKS,file_hash
import chordbuddy.stem_retention as retention

def setup(tmp_path):
 lib,store=seed(tmp_path);analysis=AnalysisStore(lib);runs=[]
 for i in range(3):
  run=store.create_run('song','recipe');runs.append(run);root=tmp_path/run['folder']
  for role in TRACKS+('guitar',):write_float(root/(role+'.wav'),[0.0]*32)
  manifest=validate_mix(root);manifest.update(source_sha256=file_hash(tmp_path/'song/source.mp3'),recipe_sha256='recipe')
  store.update_progress(run['id'],'validating');store.activate_validated(run['id'],manifest)
 return lib,store,analysis,runs

def ready(runs):return lambda song:{'ready':True,'active':{'run_id':runs[-1]['id']}}
def prune(root,store,analysis,runs):return retention.prune_stem_history(root,store,analysis,song_id='song',readiness=ready(runs))

def test_success_removes_only_obsolete_generated_stems_and_keeps_source_metadata(tmp_path):
 lib,store,analysis,runs=setup(tmp_path);before=(tmp_path/'song/source.mp3').read_bytes()
 result=prune(tmp_path,store,analysis,runs)
 assert len(result['purged'])==2 and not result['warning']
 for run in runs[:-1]:
  root=tmp_path/run['folder'];assert not (root/'bass.wav').exists()
  assert (root/'original.wav').exists() and (root/'manifest.json').exists()
  assert store._run(run['id'])['status']=='purged'
 assert all((tmp_path/runs[-1]['folder']/(r+'.wav')).exists() for r in TRACKS)
 assert (tmp_path/'song/source.mp3').read_bytes()==before
 assert len(store.library.db.execute('SELECT * FROM separation_runs').fetchall())==3
 assert prune(tmp_path,store,analysis,runs)['purged']==[]
 lib.close()

@pytest.mark.parametrize('mode',['running','old-playback','missing-source','corrupt-active','failed-replacement'])
def test_unproven_replacement_keeps_old_stems(tmp_path,mode):
 lib,store,analysis,runs=setup(tmp_path);reader=ready(runs)
 if mode=='running':analysis.save_job({'id':'job','kind':'analysis','song_id':'song','status':'running'})
 if mode=='old-playback':reader=lambda song:{'ready':True,'active':{'run_id':runs[0]['id']}}
 if mode=='missing-source':(tmp_path/'song/source.mp3').rename(tmp_path/'song/source-preserved.mp3')
 if mode=='corrupt-active':(tmp_path/runs[-1]['folder']/'bass.wav').write_bytes(b'corrupt')
 if mode=='failed-replacement':
  with lib.transaction() as db:db.execute("UPDATE separation_runs SET status='failed' WHERE id=?",(runs[-1]['id'],))
 result=retention.prune_stem_history(tmp_path,store,analysis,song_id='song',readiness=reader)
 assert not result['purged'];assert all((tmp_path/r['folder']/'bass.wav').exists() for r in runs)
 lib.close()

def test_requires_explicit_song_and_never_sweeps_other_song(tmp_path):
 lib,store,analysis,runs=setup(tmp_path)
 with pytest.raises(ValueError):retention.prune_stem_history(tmp_path,store,analysis)
 before=[(tmp_path/r['folder']/'bass.wav').read_bytes() for r in runs]
 assert retention.prune_stem_history(tmp_path,store,analysis,song_id='other')['purged']==[]
 assert [(tmp_path/r['folder']/'bass.wav').read_bytes() for r in runs]==before
 lib.close()

def test_complete_coordinator_hook_runs_after_durable_success_and_failure_never_prunes(tmp_path,monkeypatch):
 from test_analysis_jobs import coordinator
 import chordbuddy.stem_retention as retention
 calls=[]
 lib,job=coordinator(tmp_path/'ok',lambda kind,*args:{'id':kind})
 job.separation=SimpleNamespace(store=object())
 def prune(*args,**kw):
  assert job.store.library.db.execute('SELECT snapshot FROM analysis_jobs WHERE id=?',(job.job['id'],)).fetchone()
  saved=json.loads(job.store.library.db.execute('SELECT snapshot FROM analysis_jobs WHERE id=?',(job.job['id'],)).fetchone()[0]);assert saved['status']=='completed';calls.append(saved);raise OSError('Recycle unavailable')
 monkeypatch.setattr(retention,'prune_stem_history',prune);job.start('song');job.wait();assert len(calls)==1;assert job.snapshot()['status']=='completed';assert job.gate.owner is None;lib.close()
 def failing(kind,*args):
  if kind=='chart':raise ValueError('Chart failure')
  return {'id':kind}
 lib,job=coordinator(tmp_path/'failed',failing);job.separation=SimpleNamespace(store=object());job.start('song');job.wait();assert job.snapshot()['status']=='partial';assert len(calls)==1;lib.close()

def test_real_bundle_readiness_retains_old_until_replacement_completes(tmp_path):
 lib,store,analysis,runs=setup(tmp_path)
 def bundle(name,run):
  stages={}
  for kind in ('source','separation','transcription','chart'):
   asset=tmp_path/'song'/(name+'-'+kind+'.json');asset.write_text(kind)
   manifest={'run_id':run['id'],'assets':[{'path':str(asset.relative_to(tmp_path)),'sha256':file_hash(asset)}]}
   ref=analysis.publish('song',kind,{'source_sha256':file_hash(tmp_path/'song/source.mp3')},manifest)
   stages[kind]={'id':ref['id'],'status':'completed'}
  analysis.save_job({'id':name,'song_id':'song','kind':'analysis','status':'completed','stages':stages})
 bundle('old',runs[0])
 result=retention.prune_stem_history(tmp_path,store,analysis,song_id='song')
 assert not result['purged'] and all((tmp_path/r['folder']/'bass.wav').exists() for r in runs)
 bundle('new',runs[-1])
 result=retention.prune_stem_history(tmp_path,store,analysis,song_id='song')
 assert len(result['purged'])==2 and not result['warning'];lib.close()


def test_one_live_set_does_not_create_journal_or_write_database(tmp_path):
 lib,store,analysis,runs=setup(tmp_path)
 # The other two retained fixtures are failed, not obsolete completed candidates.
 with lib.transaction() as db:db.execute("UPDATE separation_runs SET status='failed' WHERE id!=?",(runs[-1]['id'],))
 changes=lib.db.total_changes
 result=prune(tmp_path,store,analysis,runs)
 assert not result['purged'] and lib.db.total_changes==changes
 assert not (tmp_path/'retention').exists();lib.close()
