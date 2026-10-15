"""Regressions for read-triggered transaction leakage and premature schema commits."""
import json
import sqlite3
import subprocess
import sys
import pytest
from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.timing_store import TimingStore
from chordbuddy.separation_store import SeparationStore
from chordbuddy.separation_audio import write_float, validate_mix
from chordbuddy.separation_contract import TRACKS, file_hash

def reader_counts(root):
    with sqlite3.connect((root/'library.sqlite3').as_uri()+'?mode=ro', uri=True) as db:
        return {table:db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in
                ('song_metadata','runs','documents','edits','separation_runs','song_separations','analysis_jobs','analysis_stages')
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()}

def test_opening_imported_song_does_not_leave_a_transaction(tmp_path, mp3_bytes):
    lib=Library(tmp_path)
    try:
        docs=DocumentStore(lib)
        song=lib.import_audio('Fresh.mp3',mp3_bytes)
        docs.song_detail(song['id'])
        assert not lib.db.in_transaction
        assert reader_counts(tmp_path)['song_metadata']==1
    finally:lib.close()

def test_processing_and_manual_edits_are_committed_before_close_and_after_fresh_process(tmp_path, mp3_bytes):
    lib=Library(tmp_path)
    try:
        docs=DocumentStore(lib); separation=SeparationStore(lib); analysis=AnalysisStore(lib)
        song=lib.import_audio('Fresh.mp3',mp3_bytes); sid=song['id']
        docs.song_detail(sid)
        run=lib.create_run(sid)
        (run/'score.abc').write_text('X:1\nM:4/4\nL:1/4\nK:C\n"C"C4|\n')
        (run/'events.json').write_text(json.dumps({'events':[{'time':0,'values':{'chord':'C:maj'}}]}))
        docs.ingest(sid,run,'completed',None)
        chart=docs.get(next(d['id'] for d in docs.for_song(sid) if d['kind']=='chart'))
        chart['content']['sections'][0]['lyrics']='Space uni-corn'
        chart['content']['chords'][0]['label']='Dm'
        saved=docs.save(chart['id'],chart['content'],'Manual line and chord',chart['revision'])
        lib.rename_song(sid,'Saved title')
        sr=separation.create_run(sid,'fixture')
        srdir=lib.contained(sr['folder'])
        for role in TRACKS+('guitar',):write_float(srdir/(role+'.wav'),[0.0]*32)
        manifest=validate_mix(srdir)
        manifest.update(source_sha256=file_hash(lib.source_path(sid)),recipe_sha256='fixture')
        separation.update_progress(sr['id'],'validating')
        separation.activate_validated(sr['id'],manifest)
        source=lib.source_path(sid)
        ref=analysis.publish(sid,'source',{'source_sha256':file_hash(source)},
            {'assets':[{'path':str(source.relative_to(lib.root)),'sha256':file_hash(source)}]})
        analysis.save_job({'id':'fixturejob','kind':'analysis','song_id':sid,'status':'completed',
                           'stages':{'source':{'id':ref['id'],'status':'completed'}}})
        seen=reader_counts(tmp_path)
        assert seen['runs']==1 and seen['song_metadata']==1
        assert seen['documents']>=2 and seen['edits']>=3
        assert (seen['separation_runs'],seen['song_separations'],seen['analysis_jobs'],seen['analysis_stages'])==(1,1,1,1)
        assert not lib.db.in_transaction
        revision=saved['revision']; chart_id=saved['id']
    finally:lib.close()
    script="""import json,sys
from pathlib import Path
from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore
lib=Library(Path(sys.argv[1])); docs=DocumentStore(lib)
song=lib.song(sys.argv[2]); chart=docs.get(sys.argv[3])
print(json.dumps({'title':song['title'],'active':song['active_run'],
'revision':chart['revision'],'lyric':chart['content']['sections'][0]['lyrics'],
'chord':chart['content']['chords'][0]['label'],
'separation':lib.db.execute('SELECT active_id FROM song_separations').fetchone()[0]}))
lib.close()
"""
    reopened=json.loads(subprocess.check_output([sys.executable,'-B','-c',script,str(tmp_path),sid,chart_id],text=True))
    assert reopened=={'title':'Saved title','active':run.name,'revision':revision,
                     'lyric':'Space uni-corn','chord':'Dm','separation':sr['id']}

@pytest.mark.parametrize('store_type',[AnalysisStore,TimingStore,SeparationStore])
def test_store_schema_creation_does_not_commit_its_callers_transaction(tmp_path,store_type):
    lib=Library(tmp_path)
    try:
        with pytest.raises(RuntimeError,match='caller rollback'):
            with lib.transaction() as db:
                db.execute("INSERT INTO settings VALUES('sentinel','uncommitted')")
                store_type(lib)
                raise RuntimeError('caller rollback')
        assert lib.db.execute("SELECT value FROM settings WHERE key='sentinel'").fetchone() is None
        assert not lib.db.in_transaction
    finally:lib.close()

def test_nested_failure_rolls_back_inner_only_and_outer_failure_rolls_back_inner_success(tmp_path):
    lib=Library(tmp_path)
    try:
        with lib.transaction() as db:
            db.execute("INSERT INTO settings VALUES('outer','kept')")
            with pytest.raises(ValueError):
                with lib.transaction() as inner:
                    inner.execute("INSERT INTO settings VALUES('inner','lost')")
                    raise ValueError('inner rollback')
        assert lib.db.execute("SELECT value FROM settings WHERE key='outer'").fetchone()[0]=='kept'
        assert lib.db.execute("SELECT value FROM settings WHERE key='inner'").fetchone() is None
        with pytest.raises(ValueError):
            with lib.transaction():
                with lib.transaction() as db:db.execute("INSERT INTO settings VALUES('nested','lost')")
                raise ValueError('outer rollback')
        assert lib.db.execute("SELECT value FROM settings WHERE key='nested'").fetchone() is None
    finally:lib.close()
