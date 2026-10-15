"""Exercise chart edits through the same HTTP interface as the desktop UI."""
import json
import threading
import urllib.request

from chordbuddy.server import make_server


def test_chart_http_save_undo_export_and_reopen(tmp_path, mp3_bytes):
    server=make_server(tmp_path)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    def call(path,body=None):
        data=None if body is None else json.dumps(body).encode()
        req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,data=data,
            headers={'X-ChordBuddy-Token':server.app.token,'Content-Type':'application/json'})
        with urllib.request.urlopen(req) as response:
            return json.load(response)
    try:
        song=server.app.library.import_audio('Chart test.mp3',mp3_bytes)
        run=server.app.library.create_run(song['id'])
        (run/'events.json').write_text(json.dumps({'events':[{'time':0,'values':{'chord':'G#:min7/b7'}}]}))
        (run/'score.abc').write_text('X:1\nK:C\n"G#m7/F#"G4|')
        server.app.documents.ingest(song['id'],run,'completed',None)
        detail=call('/api/song/'+song['id'])
        chart=next(d for d in detail['documents'] if d['kind']=='chart')
        doc=call('/api/document/'+chart['id'])
        assert doc['content']['chords'][0]['label']=='G#m7/F#'
        content=doc['content']
        content['sections'][0]['lyrics']='A little song\nFor the morning'
        content['chords'][0].update(line=0,offset=2)
        saved=call('/api/document/'+doc['id'],{'content':content,'label':'Add lyrics','revision':doc['revision']})
        exported=call('/api/export/'+doc['id'])
        assert exported['sections'][0]['lyrics']==content['sections'][0]['lyrics']
        undone=call('/api/document/'+doc['id']+'/undo',{'revision':saved['revision']})
        assert undone['content']['sections'][0]['lyrics']==''
        redone=call('/api/document/'+doc['id']+'/redo',{'revision':undone['revision']})
        assert redone['content']['chords'][0]['offset']==2
        assert '"G#m7/F#"' in (run/'score.abc').read_text()
        assert call('/api/song/'+song['id'])['documents'][0]['kind']=='chart'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    reopened=make_server(tmp_path)
    try:
        assert reopened.app.documents.get(doc['id'])['content']['sections'][0]['lyrics']==content['sections'][0]['lyrics']
    finally:
        reopened.server_close()
