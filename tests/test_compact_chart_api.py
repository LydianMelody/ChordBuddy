import copy,json,threading,urllib.request,urllib.error
from pathlib import Path
import pytest
from chordbuddy.server import make_server

def test_bulk_chart_save_is_one_revision_conflict_safe_and_undoable(tmp_path,mp3_bytes):
 server=make_server(tmp_path);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 def call(path,body=None):
  req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,data=None if body is None else json.dumps(body).encode(),headers={'X-ChordBuddy-Token':server.app.token,'Content-Type':'application/json'})
  with urllib.request.urlopen(req) as response:return json.load(response)
 try:
  song=server.app.library.import_audio('Compact fixture.mp3',mp3_bytes)
  with server.app.library.transaction() as db:db.execute('UPDATE songs SET duration=32 WHERE id=?',(song['id'],))
  run=server.app.library.create_run(song['id']);source='X:1\nK:C\n"C"C4|';(run/'score.abc').write_text(source)
  server.app.documents.ingest(song['id'],run,'completed',None)
  detail=call('/api/song/'+song['id']);chart=next(d for d in detail['documents'] if d['kind']=='chart');doc=call('/api/document/'+chart['id'])
  fixture=json.loads((Path(__file__).parent/'fixtures/compact-chart.json').read_text())['content']
  original=call('/api/document/'+doc['id'],{'content':fixture,'label':'Fixture','revision':doc['revision']});after=copy.deepcopy(fixture)
  for c in after['chords']:
   if c['label']=='G':c['label']='G7'
  music=json.loads((Path(__file__).parent/'fixtures/compact-chart.json').read_text())['music']
  version=server.app.documents.timing_version(dict(original,music=music));version['algorithm']='synthetic-test-grid'
  binding={'version_id':server.app.documents.timing.put_version(version),'overrides':{'constant_tempo':False,'bpm':None}}
  original=server.app.documents.save_bound_chart(doc['id'],fixture,binding,'Fixture timing',server.app.documents.revision_stamp(doc['id']))
  after['layout']={'bars_per_line':4,'breaks':[],'lines':[],'bar_overrides':[],'compact':{'version':1,'groups':[{'id':'s:0','section_id':'s','mode':'repeat','passes':[{'start':0,'end':8,'measure_ids':['m0','m1','m2','m3'],'chord_ids':['c0','c1','c2','c3']},{'start':8,'end':20,'measure_ids':['m4','m5','m6','m7'],'chord_ids':['c4','c5','c6','c7']}]}]}}
  count=server.app.library.db.execute('SELECT COUNT(*) FROM edits WHERE document_id=?',(doc['id'],)).fetchone()[0]
  saved=call('/api/document/'+doc['id'],{'content':after,'label':'All passes','revision':original['revision']})
  assert server.app.library.db.execute('SELECT COUNT(*) FROM edits WHERE document_id=?',(doc['id'],)).fetchone()[0]==count+1
  with pytest.raises(urllib.error.HTTPError) as conflict:call('/api/document/'+doc['id'],{'content':fixture,'label':'Stale','revision':original['revision']})
  assert conflict.value.code==409
  undone=call('/api/document/'+doc['id']+'/undo',{'revision':saved['revision']});assert undone['content']==fixture
  redone=call('/api/document/'+doc['id']+'/redo',{'revision':undone['revision']});assert redone['content']==after
  assert (run/'score.abc').read_text()==source
 finally:server.shutdown();server.server_close();thread.join()
 reopened=make_server(tmp_path)
 try:assert reopened.app.documents.get(doc['id'])['content']==after
 finally:reopened.server_close()
