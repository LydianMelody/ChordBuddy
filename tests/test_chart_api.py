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
        assert redone['history'][1:]==['Add lyrics'] and redone['cursor']==1
        # the History menu: jump several steps at once, and back; nothing is lost on the way
        back=call('/api/document/'+doc['id']+'/goto',{'revision':redone['revision'],'position':0})
        assert back['cursor']==0 and back['content']['sections'][0]['lyrics']=='' and back['can_redo'] and back['history'][1:]==['Add lyrics']
        again=call('/api/document/'+doc['id']+'/goto',{'revision':back['revision'],'position':1})
        assert again['content']['chords'][0]['offset']==2
        for bad in (5,-1,'1',None):
            try:call('/api/document/'+doc['id']+'/goto',{'revision':again['revision'],'position':bad});raise AssertionError(bad)
            except AssertionError:raise
            except Exception:pass
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


def test_cues_are_kept_apart_from_the_chords_through_save_undo_export_and_reopen(tmp_path, mp3_bytes):
    """A cue ("pick scratch") is its own short note at a moment of the recording; the chord under it is untouched."""
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
        song=server.app.library.import_audio('Cue test.mp3',mp3_bytes)
        run=server.app.library.create_run(song['id'])
        (run/'events.json').write_text(json.dumps({'events':[{'time':0,'values':{'chord':'D#:min'}}]}))
        (run/'score.abc').write_text('X:1\nK:C\n"D#m"G4|')
        server.app.documents.ingest(song['id'],run,'completed',None)
        chart=next(d for d in call('/api/song/'+song['id'])['documents'] if d['kind']=='chart')
        doc=call('/api/document/'+chart['id'])
        assert 'cues' not in doc['content'],'a chart without cues has no list'
        content=doc['content'];chords=json.dumps(content['chords'])
        content['cues']=[{'id':'b','text':'count-in','start':0.4},{'id':'a','text':' pick scratch ','start':0}]
        saved=call('/api/document/'+doc['id'],{'content':content,'label':'Add cue','revision':doc['revision']})
        assert saved['content']['cues']==[{'id':'a','text':'pick scratch','start':0},{'id':'b','text':'count-in','start':0.4}]
        assert json.dumps(saved['content']['chords'])==chords,'the chords are untouched'
        assert call('/api/export/'+doc['id'])['cues'][0]['text']=='pick scratch'
        undone=call('/api/document/'+doc['id']+'/undo',{'revision':saved['revision']})
        assert 'cues' not in undone['content']
        redone=call('/api/document/'+doc['id']+'/redo',{'revision':undone['revision']})
        assert [c['text'] for c in redone['content']['cues']]==['pick scratch','count-in']
        for bad in ([{'id':'x','text':'two\nlines','start':0}],[{'id':'x','text':'x'*41,'start':0}],[{'id':'x','text':'late','start':10**6}],
                    [{'id':'x','text':'a','start':0},{'id':'x','text':'b','start':0.1}]):
            try:
                call('/api/document/'+doc['id'],{'content':dict(redone['content'],cues=bad),'label':'Bad cue','revision':redone['revision']})
                raise AssertionError(bad)
            except urllib.error.HTTPError:
                pass
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    reopened=make_server(tmp_path)
    try:
        assert [c['text'] for c in reopened.app.documents.get(doc['id'])['content']['cues']]==['pick scratch','count-in']
    finally:
        reopened.server_close()
