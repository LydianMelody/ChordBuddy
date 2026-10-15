import hashlib
import json
import pytest
from chordbuddy.library import Library
from chordbuddy.separation_store import SeparationStore
from chordbuddy.separation_contract import recipe_digest

def seed(tmp_path):
    lib=Library(tmp_path)
    with lib.transaction() as db:
        db.execute("INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)",('song','Title','','source.mp3',1,'song','imported',None,None,'now'))
    (tmp_path/'song').mkdir()
    (tmp_path/'song/source.mp3').write_bytes(b'original')
    return lib,SeparationStore(lib)

def test_run_failure_and_recovery_leave_chart_identity(tmp_path):
    lib,store=seed(tmp_path)
    run=store.create_run('song','abc')
    assert store.get_song_state('song')['job']['id']==run['id']
    store.recover_interrupted()
    assert store.get_song_state('song')['job']['status']=='interrupted'
    assert lib.song('song')['status']=='imported'
    assert lib.song('song')['active_run'] is None
    assert store.get_song_state('song')['active'] is None
    lib.close()

def test_recipe_hash_order_stable():
    assert recipe_digest({'a':1,'b':2})==recipe_digest({'b':2,'a':1})
    assert recipe_digest({'a':1})!=recipe_digest({'a':2})

def test_paths_and_unknown_song_rejected(tmp_path):
    lib,store=seed(tmp_path)
    with pytest.raises(KeyError): store.create_run('other','abc')
    with pytest.raises((KeyError,ValueError)): store.get_published_run('../source.mp3')
    with pytest.raises(ValueError): store.safe_path(tmp_path/'../outside')
    lib.close()

def test_cancel_is_exact_and_idempotent(tmp_path):
    lib,store=seed(tmp_path)
    first=store.create_run('song','abc')
    store.request_cancel(first['id'])
    store.fail_run(first['id'],'cancelled','Stopped')
    second=store.create_run('song','abc')
    store.request_cancel(first['id'])
    assert store.get_song_state('song')['job']['id']==second['id']
    assert store.get_song_state('song')['job']['status']=='preparing'
    lib.close()

