import json
import os
import threading
import pytest
from test_stem_retention import setup,ready,prune
import chordbuddy.stem_retention as retention


def test_real_junction_is_refused_before_resolution(tmp_path):
 if os.name!='nt':pytest.skip('Windows junction regression')
 import _winapi
 lib,store,analysis,runs=setup(tmp_path)
 root=tmp_path/runs[0]['folder'];root.rename(root.with_name(root.name+'-preserved'))
 _winapi.CreateJunction(str(tmp_path/runs[-1]['folder']),str(root))
 result=prune(tmp_path,store,analysis,runs)
 assert result['warning'] and not result['purged']
 assert (tmp_path/runs[-1]['folder']/'bass.wav').exists();lib.close()


def test_prepared_journal_precedes_every_unlink(tmp_path,monkeypatch):
 lib,store,analysis,runs=setup(tmp_path);original=retention._unlink
 def verify(path):
  entry=json.loads((tmp_path/'retention'/('stem-purge-'+path.parent.name+'.json')).read_text())
  assert entry['assets'] and entry['source_sha256']
  assert store._run(path.parent.name)['status']=='purging'
  original(path)
 monkeypatch.setattr(retention,'_unlink',verify)
 assert len(prune(tmp_path,store,analysis,runs)['purged'])==2;lib.close()


def test_partial_interruption_resumes_exact_plan_without_removing_source(tmp_path,monkeypatch):
 lib,store,analysis,runs=setup(tmp_path);original=retention._unlink;calls=[]
 class Interrupted(BaseException):pass
 def interrupt(path):
  original(path);calls.append(path);raise Interrupted()
 monkeypatch.setattr(retention,'_unlink',interrupt)
 with pytest.raises(Interrupted):prune(tmp_path,store,analysis,runs)
 assert len(calls)==1 and store._run(runs[0]['id'])['status']=='completed'
 # Status rolls back with the writer reservation; the fsynced exact journal
 # remains authoritative for the partial removal and enables safe resumption.
 journal=json.loads((tmp_path/'retention'/('stem-purge-'+runs[0]['id']+'.json')).read_text())
 assert journal['assets'] and journal['phase']=='prepared'
 monkeypatch.setattr(retention,'_unlink',original)
 result=prune(tmp_path,store,analysis,runs)
 assert len(result['purged'])==2 and not result['warning']
 assert (tmp_path/'song/source.mp3').read_bytes()==b'original';lib.close()


def test_journal_failure_before_intent_does_not_remove_audio(tmp_path,monkeypatch):
 lib,store,analysis,runs=setup(tmp_path)
 def fail(*args):raise OSError('Journal locked')
 monkeypatch.setattr(retention,'_record',fail)
 result=prune(tmp_path,store,analysis,runs)
 assert result['warning'] and all((tmp_path/r['folder']/'bass.wav').exists() for r in runs);lib.close()


def test_failure_after_db_commit_reconciles(tmp_path,monkeypatch):
 lib,store,analysis,runs=setup(tmp_path);original=retention._record
 def fail(path,entry,project):
  if entry['phase']=='committed':raise OSError('Journal finalization locked')
  original(path,entry,project)
 monkeypatch.setattr(retention,'_record',fail)
 assert prune(tmp_path,store,analysis,runs)['warning']
 assert store._run(runs[0]['id'])['status']=='purged'
 monkeypatch.setattr(retention,'_record',original)
 assert not prune(tmp_path,store,analysis,runs)['warning'];lib.close()


def test_changed_obsolete_stem_or_manifest_cannot_expand_delete_scope(tmp_path):
 lib,store,analysis,runs=setup(tmp_path);root=tmp_path/runs[0]['folder'];p=root/'manifest.json'
 m=json.loads(p.read_text());m['assets'][1]['relative_path']='../../source.mp3';p.write_text(json.dumps(m))
 assert prune(tmp_path,store,analysis,runs)['warning']
 assert (tmp_path/'song/source.mp3').exists() and (root/'bass.wav').exists();lib.close()


def test_lock_failure_stops_remaining_files_and_preserves_active(tmp_path,monkeypatch):
 lib,store,analysis,runs=setup(tmp_path)
 def locked(path):raise PermissionError('File locked')
 monkeypatch.setattr(retention,'_unlink',locked)
 result=prune(tmp_path,store,analysis,runs)
 assert result['warning'] and not result['purged']
 assert all((tmp_path/r['folder']/'bass.wav').exists() for r in runs);lib.close()


def test_playback_lock_order_does_not_deadlock(tmp_path):
 lib,store,analysis,runs=setup(tmp_path);requested=threading.Event();underlying=store._verify_lock
 class ObservedLock:
  def __enter__(self):requested.set();underlying.acquire();return self
  def __exit__(self,*args):underlying.release()
 store._verify_lock=ObservedLock();results=[]
 with underlying:
  worker=threading.Thread(target=lambda:results.append(prune(tmp_path,store,analysis,runs)),daemon=True);worker.start()
  assert requested.wait(3);acquired=lib.lock.acquire(timeout=1)
  if acquired:lib.lock.release()
 worker.join(5)
 assert acquired and not worker.is_alive() and not results[0]['warning'];lib.close()

def test_uncommitted_replacement_never_retires_last_good_files(tmp_path):
 from chordbuddy.separation_audio import write_float,validate_mix
 from chordbuddy.separation_contract import TRACKS,file_hash
 lib,store,analysis,runs=setup(tmp_path)
 before=[(tmp_path/r['folder']/'bass.wav').read_bytes() for r in runs]
 try:
  with pytest.raises(RuntimeError,match='abort replacement'):
   with lib.transaction():
    candidate=store.create_run('song','recipe');root=tmp_path/candidate['folder']
    for role in TRACKS+('guitar',):write_float(root/(role+'.wav'),[0.0]*32)
    manifest=validate_mix(root);manifest.update(source_sha256=file_hash(tmp_path/'song/source.mp3'),recipe_sha256='recipe')
    store.update_progress(candidate['id'],'validating');store.activate_validated(candidate['id'],manifest)
    result=retention.prune_stem_history(tmp_path,store,analysis,song_id='song',
       readiness=lambda song:{'ready':True,'active':{'run_id':candidate['id']}})
    assert not result['purged']
    assert not (tmp_path/'retention').exists()
    raise RuntimeError('abort replacement')
  assert [(tmp_path/r['folder']/'bass.wav').read_bytes() for r in runs]==before
  assert store.get_song_state('song')['active']['run_id']==runs[-1]['id']
 finally:lib.close()

def test_changed_committed_pointer_stops_before_creating_purge_journal(tmp_path):
 import sqlite3
 lib,store,analysis,runs=setup(tmp_path)
 def changed(song):
  with sqlite3.connect(tmp_path/'library.sqlite3') as other:
   other.execute('UPDATE song_separations SET active_id=? WHERE song_id=?',(runs[0]['id'],song))
  return {'ready':True,'active':{'run_id':runs[-1]['id']}}
 try:
  result=retention.prune_stem_history(tmp_path,store,analysis,song_id='song',readiness=changed)
  assert not result['purged']
  assert not (tmp_path/'retention').exists()
  assert all((tmp_path/r['folder']/'bass.wav').exists() for r in runs)
 finally:lib.close()

@pytest.mark.parametrize('boundary',['after_fence','before_unlink'])
def test_competing_publication_cannot_retire_active_audio(tmp_path,monkeypatch,boundary):
 import sqlite3
 lib,store,analysis,runs=setup(tmp_path);attempts=[]
 def compete():
  if attempts:return
  other=sqlite3.connect(tmp_path/'library.sqlite3',timeout=0)
  try:
   other.execute('UPDATE song_separations SET active_id=? WHERE song_id=?',(runs[0]['id'],'song'))
   other.commit();attempts.append('changed')
  except sqlite3.OperationalError as exc:
   assert 'locked' in str(exc).lower()
   attempts.append('blocked');other.rollback()
  finally:other.close()
 if boundary=='after_fence':
  original=retention.committed_publication
  def interleave(*args):
   result=original(*args);compete();return result
  monkeypatch.setattr(retention,'committed_publication',interleave)
 else:
  original=retention._unlink
  def interleave(path):
   compete();return original(path)
  monkeypatch.setattr(retention,'_unlink',interleave)
 try:
  result=prune(tmp_path,store,analysis,runs)
  assert attempts
  active=lib.db.execute('SELECT active_id FROM song_separations WHERE song_id=?',('song',)).fetchone()[0]
  active_row=store._run(active)
  assert active_row['status']=='completed'
  assert all((tmp_path/active_row['folder']/(role+'.wav')).exists() for role in ('bass','drums','vocals'))
  if attempts==['changed']:assert not result['purged']
 finally:lib.close()
