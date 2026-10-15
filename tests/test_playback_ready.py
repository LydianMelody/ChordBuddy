import json
from types import SimpleNamespace
import pytest
from chordbuddy.library import Library
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.separation_contract import file_hash
from chordbuddy.playback_ready import PlaybackReadiness

@pytest.fixture
def setup(tmp_path):
    lib=Library(tmp_path)
    with lib.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',('s','Song','','source.mp3',1,'s','imported',None,None,'now'))
    folder=tmp_path/'s';folder.mkdir();(folder/'source.mp3').write_bytes(b'source')
    store=AnalysisStore(lib);manifest={'run_id':'sep','song_id':'s','source_sha256':file_hash(folder/'source.mp3'),'recipe_sha256':'recipe','frames':44100,'common_gain':1}
    sep=SimpleNamespace(get_published_run=lambda ident:(folder,dict(manifest,run_id=ident)),recipe_provider=lambda:'recipe',public_manifest=lambda m:m)
    reader=PlaybackReadiness(store,sep)
    def complete(ident='ok',run='sep'):
        stages={}
        for kind in ('source','separation','transcription','chart'):
            asset=folder/(ident+'-'+kind);asset.write_text(kind)
            ref=store.publish('s',kind,{'source_sha256':manifest['source_sha256']},{'run_id':run,'assets':[{'path':str(asset.relative_to(tmp_path)),'sha256':file_hash(asset)}]})
            stages[kind]={'id':ref['id'],'status':'completed'}
        job={'id':ident,'kind':'analysis','song_id':'s','status':'completed','stages':stages}
        store.save_job(job);return job
    yield lib,store,reader,complete,folder,manifest
    lib.close()

def test_status_alone_and_partial_results_do_not_unlock(setup):
    lib,store,reader,complete,folder,_=setup
    assert not reader.state('s')['ready']
    job=complete();job['status']='partial';store.save_job(job)
    assert not reader.state('s')['ready']
    job.update(status='completed',stages={});store.save_job(job)
    assert not reader.state('s')['ready']

def test_valid_completed_cache_is_ready_without_new_analysis(setup):
    _,_,reader,complete,_,_=setup
    complete();state=reader.state('s')
    assert state['ready'] and state['active']['run_id']=='sep' and state['analysis_id']=='ok'

def test_busy_blocks_but_failed_reanalysis_retains_valid_prior_bundle(setup):
    _,store,reader,complete,_,_=setup
    complete();store.invalidate('s','separation')
    running={'id':'new','kind':'analysis','song_id':'s','status':'running','stage':'transcription'}
    assert not reader.state('s',running)['ready']
    for status in ('failed','cancelled','partial','interrupted'):
        job=dict(running,status=status,error='fixture');store.save_job(job)
        state=reader.state('s',job)
        assert state['ready'] and state['active']['run_id']=='sep'
        assert 'previous' in state['reason'].lower()

def test_source_and_artifact_mutation_relock_even_after_cached_read(setup):
    _,_,reader,complete,folder,_=setup
    complete();assert reader.state('s')['ready']
    (folder/'ok-transcription').write_text('corrupt')
    assert not reader.state('s')['ready']
    complete('next');assert reader.state('s')['ready']
    (folder/'source.mp3').write_bytes(b'changed source')
    assert not reader.state('s')['ready']

def test_other_song_job_does_not_block_and_changed_recipe_does(setup):
    _,_,reader,complete,_,manifest=setup
    complete();assert reader.state('s',{'kind':'analysis','song_id':'other','status':'running'})['ready']
    manifest['recipe_sha256']='obsolete';assert not reader.state('s')['ready']

def test_newest_valid_complete_bundle_wins_and_corrupt_replacement_falls_back(setup):
    _,_,reader,complete,folder,_=setup
    complete();complete('new','new-sep');assert reader.state('s')['active']['run_id']=='new-sep'
    (folder/'new-chart').write_text('corrupt')
    assert reader.state('s')['active']['run_id']=='sep'

def test_application_endpoint_admits_only_reader_validation(tmp_path):
    from pathlib import Path
    from unittest.mock import Mock
    from chordbuddy.server import Application
    from test_reprocess import seed
    app=Application(tmp_path,Path.cwd());seed(app.library)
    try:
        app.analysis.job={'id':'running','song_id':'song','kind':'analysis','status':'running'}
        assert not app.playback_state('song')['ready']
        app.analysis.job={'id':'failed','song_id':'song','kind':'analysis','status':'failed'}
        assert not app.playback_state('song')['ready']
        app.analysis.job=None
        assert not app.playback_state('song')['ready']
    finally:
        app.analysis.job=None;app.close()
