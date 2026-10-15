import json,threading
from pathlib import Path
import pytest
from chordbuddy.documents import DocumentStore,RevisionConflict
from test_documents import prepare
from test_access_denied_recovery import deny_replace

def edited(tmp_path,mp3_bytes):
 lib,docs,song,run=prepare(tmp_path,mp3_bytes)
 doc=docs.get(next(d['id'] for d in docs.for_song(song['id']) if d['kind']=='chart'))
 value=json.loads(json.dumps(doc['content']));value['sections'][0]['lyrics']='Saved lyrics'
 saved=docs.save(doc['id'],value,'Lyrics',doc['revision']);path=run/'edited'/'Song chart.json'
 return lib,docs,saved,path

def test_identical_document_export_does_not_replace_locked_destination(tmp_path,mp3_bytes):
 lib,docs,doc,path=edited(tmp_path,mp3_bytes)
 with deny_replace(path):data,_=docs.export(doc['id'])
 assert data==path.read_bytes();lib.close()

def test_short_windows_lock_is_retried_after_database_commit(tmp_path,mp3_bytes):
 lib,docs,doc,path=edited(tmp_path,mp3_bytes);value=json.loads(json.dumps(doc['content']));value['sections'][0]['lyrics']='Changed lyrics'
 with deny_replace(path) as release:
  timer=threading.Timer(.1,release);timer.start()
  try:saved=docs.save(doc['id'],value,'Changed',doc['revision'])
  finally:timer.join()
 assert 'export_warning' not in saved
 assert json.loads(path.read_text(encoding='utf-8'))==saved['content'];assert saved['revision']==doc['revision']+1;lib.close()

def test_persistent_lock_preserves_db_old_export_and_warning_on_reopen_and_retry_without_history(tmp_path,mp3_bytes):
 lib,docs,doc,path=edited(tmp_path,mp3_bytes);old=path.read_bytes();value=json.loads(json.dumps(doc['content']));value['sections'][0]['lyrics']='Committed during lock'
 with deny_replace(path):
  saved=docs.save(doc['id'],value,'Changed',doc['revision']);assert saved['content']==value;assert 'export_warning' in saved;assert path.read_bytes()==old
  reopened=DocumentStore(lib);assert 'export_warning' in reopened.get(doc['id'])
  before=[tuple(x) for x in lib.db.execute('SELECT * FROM edits')]
  again=reopened.retry_export(doc['id'],saved['revision']);assert 'export_warning' in again;assert [tuple(x) for x in lib.db.execute('SELECT * FROM edits')]==before
 fresh=reopened.retry_export(doc['id'],saved['revision']);assert 'export_warning' not in fresh;assert fresh['revision']==saved['revision'];assert [tuple(x) for x in lib.db.execute('SELECT * FROM edits')]==before;assert json.loads(path.read_text(encoding='utf-8'))==value
 assert 'export_warning' not in DocumentStore(lib).get(doc['id']);lib.close()

def test_stale_export_retry_refuses_to_overwrite_or_change_history(tmp_path,mp3_bytes):
 lib,docs,doc,path=edited(tmp_path,mp3_bytes);before=path.read_bytes()
 with pytest.raises(RevisionConflict):docs.retry_export(doc['id'],doc['revision']-1)
 assert path.read_bytes()==before;lib.close()

def test_undo_and_redo_export_failure_do_not_duplicate_history(tmp_path,mp3_bytes):
 lib,docs,doc,path=edited(tmp_path,mp3_bytes)
 with deny_replace(path):
  undone=docs.history(doc['id'],'undo',doc['revision']);assert 'export_warning' in undone;assert undone['can_redo']
  assert 'export_warning' in DocumentStore(lib).get(doc['id'])
 count=lib.db.execute('SELECT COUNT(*) FROM edits').fetchone()[0];retried=docs.retry_export(doc['id'],undone['revision']);assert 'export_warning' not in retried;assert lib.db.execute('SELECT COUNT(*) FROM edits').fetchone()[0]==count
 redone=docs.history(doc['id'],'redo',retried['revision']);assert redone['content']==doc['content'];lib.close()

# Exercise the authenticated HTTP retry route separately from document saves.
from test_server import service,request
import urllib.error

def test_export_retry_api_commits_no_history_and_rejects_stale_revision(service,mp3_bytes):
 lib,docs,doc,path=edited(service.app.library.root,mp3_bytes)
 before=[tuple(x) for x in lib.db.execute('SELECT * FROM edits')]
 value=json.load(request(service,'/api/document/'+doc['id']+'/export',json.dumps({'revision':doc['revision']}).encode()))
 assert value['revision']==doc['revision'] and 'export_warning' not in value
 assert [tuple(x) for x in lib.db.execute('SELECT * FROM edits')]==before
 with pytest.raises(urllib.error.HTTPError) as error:request(service,'/api/document/'+doc['id']+'/export',json.dumps({'revision':doc['revision']-1}).encode())
 assert error.value.code==409;lib.close()
