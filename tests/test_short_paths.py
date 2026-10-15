import io
from pathlib import Path
import pytest
from mutagen.id3 import ID3, TIT2
from chordbuddy.library import Library
from chordbuddy.separation_store import SeparationStore

@pytest.fixture
def library(tmp_path):
    lib=Library(tmp_path)
    yield lib
    lib.close()

def ids(monkeypatch,values):
    import chordbuddy.path_policy as policy
    values=iter(values)
    monkeypatch.setattr(policy,'new_id',lambda length:next(values)[:length])

def test_new_song_folder_is_only_id_and_title_remains_in_sqlite(library,mp3_bytes):
    audio=io.BytesIO(mp3_bytes);tags=ID3();title='A very long title / '+('\U0001f3b5'*70)
    tags.add(TIT2(encoding=3,text=title));tags.save(audio)
    song=library.import_audio('demo.mp3',audio.getvalue())
    assert song['folder']==song['id'] and len(song['id'])==12
    assert song['title']==title
    assert library.source_path(song['id']).read_bytes()==audio.getvalue()

def test_import_retries_filesystem_and_database_collisions(library,mp3_bytes,monkeypatch):
    original=library.import_audio('first.mp3',mp3_bytes)
    orphan='f'*12;(library.root/orphan).mkdir();(library.root/orphan/'source.mp3').write_bytes(b'preserve')
    ids(monkeypatch,[original['id'],orphan,'a'*12])
    new=library.import_audio('second.mp3',mp3_bytes)
    assert new['id']=='a'*12
    assert library.source_path(original['id']).read_bytes()==mp3_bytes
    assert (library.root/orphan/'source.mp3').read_bytes()==b'preserve'

@pytest.mark.parametrize('kind,length',[('runs',12),('separation',32),('analysis',32)])
def test_run_collision_retries_without_touching_existing_files(library,mp3_bytes,monkeypatch,kind,length):
    song=library.import_audio('song.mp3',mp3_bytes);parent=library.folder(song['id'])/kind
    old=parent/('b'*length);old.mkdir(parents=True);(old/'keep').write_bytes(b'untouched')
    ids(monkeypatch,['b'*length,'c'*length])
    if kind=='runs':new=library.create_run(song['id'])
    elif kind=='separation':
        store=SeparationStore(library);new=store.safe_path(store.create_run(song['id'],'recipe')['folder'])
    else:new=library.create_analysis_directory(song['id'])
    assert new.name=='c'*length and (old/'keep').read_bytes()==b'untouched'

def test_import_path_failure_precedes_song_files_and_rows(library,mp3_bytes,monkeypatch):
    longroot=library.root/('long'*18);longroot.mkdir()
    monkeypatch.setattr(library,'root',longroot)
    with pytest.raises(ValueError,match=r'240.*shorter|shorter.*240'):
        library.import_audio('song.mp3',mp3_bytes)
    assert list(longroot.iterdir())==[]
    assert library.db.execute('SELECT count(*) FROM songs').fetchone()[0]==0

@pytest.mark.parametrize('kind',['runs','separation','analysis'])
def test_existing_long_folder_rejected_before_new_run(library,mp3_bytes,kind):
    song=library.import_audio('song.mp3',mp3_bytes);old=library.folder(song['id']);long=old.with_name('legacy-'+'x'*78)
    old.rename(long)
    with library.transaction() as db:db.execute('UPDATE songs SET folder=? WHERE id=?',(long.name,song['id']))
    store=SeparationStore(library)
    with pytest.raises(ValueError,match='shorter'):
        if kind=='runs':library.create_run(song['id'])
        elif kind=='separation':store.create_run(song['id'],'recipe')
        else:library.create_analysis_directory(song['id'])
    assert sorted(p.name for p in long.iterdir())==['source.mp3']
    assert library.song(song['id'])['status']=='imported'

def test_utf16_exact_boundary_and_temporary_cache_budget():
    from chordbuddy.path_policy import validate_paths,utf16_units,song_paths
    assert utf16_units('\U0001f3b5')==2
    root=Path.cwd()/'qa/sp/lib'
    paths=song_paths(root,root/('a'*12))
    assert not any('joblib' in str(p) for p in paths)      # librosa's cache is no longer reserved (see path_policy.py)
    assert any(str(p).endswith('.partial') for p in paths)
    validate_paths(paths)
    base=str(Path.cwd())+'/'
    exact=Path(base+'x'*(240-utf16_units(base)))
    validate_paths([exact])
    with pytest.raises(ValueError,match='241'):validate_paths([str(exact)+'x'])
    with pytest.raises(ValueError,match='242'):validate_paths([str(exact)+'\U0001f3b5'])

def test_analysis_admission_rejects_path_before_invalidating_cache(library,mp3_bytes):
    from chordbuddy.analysis import AnalysisCoordinator
    from chordbuddy.inference_jobs import InferenceGate
    song=library.import_audio('song.mp3',mp3_bytes);old=library.folder(song['id']);long=old.with_name('legacy-'+'x'*78);old.rename(long)
    with library.transaction() as db:db.execute('UPDATE songs SET folder=? WHERE id=?',(long.name,song['id']))
    job=AnalysisCoordinator(Path.cwd(),library,None,None,None,None,InferenceGate(),stage_runner=lambda *a:pytest.fail('worker must not start'))
    with pytest.raises(ValueError,match='shorter'):job.start(song['id'],['source'])
    assert job.gate.owner is None
    for table in ('analysis_jobs','analysis_invalidations'):
        assert library.db.execute('SELECT count(*) FROM '+table).fetchone()[0]==0
    assert list(long.iterdir())==[long/'source.mp3']

def test_cache_environment_uses_bounded_children(tmp_path):
    from chordbuddy.path_policy import worker_environment as environment
    env=environment(Path.cwd(),tmp_path)
    assert 'LIBROSA_CACHE_DIR' not in env          # no cache that could never be reused, and no budget spent reserving room for it
    assert Path(env['TEMP'])==tmp_path/'c'
    assert Path(env['HF_HOME'])==tmp_path/'c/h'
    assert Path(env['CUDA_CACHE_PATH'])==Path.cwd()/'.models'/'cuda-cache'      # shared by every job, so GPU kernels are compiled once
    assert int(env['CUDA_CACHE_MAXSIZE'])>=2*1024**3

def test_an_inherited_librosa_cache_location_is_dropped(tmp_path,monkeypatch):
    from chordbuddy.path_policy import worker_environment as environment
    monkeypatch.setenv('LIBROSA_CACHE_DIR','C:/somewhere/very/long/and/outside')
    assert 'LIBROSA_CACHE_DIR' not in environment(Path.cwd(),tmp_path)

def test_the_install_folder_can_be_about_ninety_characters_long():
    # Worst case below the library folder is the CUDA cache file, not librosa's: that is what limits the install path now.
    from chordbuddy.path_policy import MAX_PATH_UNITS,song_paths,utf16_units,validate_project
    root=Path('C:/R/Data');folder=root/('a'*12)
    worst=max(song_paths(root,folder),key=utf16_units)
    beyond_library=utf16_units(worst)-len(str(root))
    assert beyond_library<=135,beyond_library        # it was 178 while librosa's cache was reserved
    assert MAX_PATH_UNITS-beyond_library-len(chr(92)+'Data')>=100     # install folder budget, in characters

def test_collision_exhaustion_keeps_existing_song(library,mp3_bytes,monkeypatch):
    import chordbuddy.path_policy as policy
    song=library.import_audio('original.mp3',mp3_bytes)
    monkeypatch.setattr(policy,'new_id',lambda length:song['id'])
    with pytest.raises(ValueError,match='unique'):library.import_audio('again.mp3',mp3_bytes)
    assert len(library.state()['songs'])==1
    assert library.source_path(song['id']).read_bytes()==mp3_bytes

@pytest.mark.parametrize('kind',['runs','separation'])
def test_database_id_collision_in_different_song_is_retried(library,mp3_bytes,monkeypatch,kind):
    a=library.import_audio('a.mp3',mp3_bytes);b=library.import_audio('b.mp3',mp3_bytes)
    store=SeparationStore(library)
    if kind=='runs':old=library.create_run(a['id']).name
    else:old=store.create_run(a['id'],'recipe')['id']
    ids(monkeypatch,[old,'d'*len(old)])
    if kind=='runs':new=library.create_run(b['id']).name
    else:new=store.create_run(b['id'],'recipe')['id']
    assert new=='d'*len(old)

def test_analysis_job_collision_does_not_overwrite_old_snapshot(library,mp3_bytes,monkeypatch):
    import json
    from chordbuddy.analysis import AnalysisCoordinator
    from chordbuddy.inference_jobs import InferenceGate
    song=library.import_audio('song.mp3',mp3_bytes)
    job=AnalysisCoordinator(Path.cwd(),library,None,None,None,None,InferenceGate(),stage_runner=lambda *a:{'id':'fixture'})
    old={'id':'b'*32,'status':'completed','song_id':'old-song'};job.store.save_job(old)
    ids(monkeypatch,['b'*32,'c'*32])
    job.start(song['id']);job.wait()
    assert job.job['id']=='c'*32
    assert json.loads(library.db.execute('SELECT snapshot FROM analysis_jobs WHERE id=?',(old['id'],)).fetchone()[0])==old

def test_stage_id_collision_preserves_prior_stage(library,mp3_bytes,monkeypatch):
    from chordbuddy.analysis_store import AnalysisStore
    from chordbuddy.separation_contract import file_hash
    song=library.import_audio('song.mp3',mp3_bytes);store=AnalysisStore(library)
    deps={'source_sha256':file_hash(library.source_path(song['id']))}
    manifest={'assets':[{'path':song['folder']+'/source.mp3','sha256':deps['source_sha256']}]}
    a=store.publish(song['id'],'source',deps,manifest)
    ids(monkeypatch,[a['id'],'d'*32])
    b=store.publish(song['id'],'source',deps,manifest)
    assert b['id']=='d'*32 and store.manifest(a)==manifest

def test_export_budget_failure_still_reports_committed_edit(tmp_path):
    from test_timing_history import fixture
    lib,docs,doc=fixture(tmp_path)
    try:
        # Historical/user document names can be longer than the pinned output names.
        with lib.transaction() as db:db.execute('UPDATE documents SET name=? WHERE id=?',('e'*235+'.json',doc['id']))
        doc['content']['sections'][0]['lyrics']='Keep this database edit'
        saved=docs.save(doc['id'],doc['content'],'Words',doc['revision'])
        assert saved['content']['sections'][0]['lyrics']=='Keep this database edit'
        assert '240' in saved.get('export_warning','')
        dest=docs._export_destination(docs._row(doc['id']))
        assert not dest.exists() and not dest.with_name(dest.name+'.partial').exists()
    finally:lib.close()

@pytest.mark.parametrize('kind',['runs','separation','analysis'])
def test_existing_junction_cannot_redirect_new_runs_outside_library(tmp_path,mp3_bytes,kind):
    import os
    if os.name!='nt':pytest.skip('Windows junction check')
    import _winapi
    lib=Library(tmp_path)
    try:
        song=lib.import_audio('song.mp3',mp3_bytes)
        outside=tmp_path.parent/(tmp_path.name+'out');outside.mkdir()
        junction=lib.folder(song['id'])/kind
        _winapi.CreateJunction(str(outside),str(junction))
        store=SeparationStore(lib)
        with pytest.raises(ValueError,match='Invalid.*path'):
            if kind=='runs':lib.create_run(song['id'])
            elif kind=='separation':store.create_run(song['id'],'recipe')
            else:lib.create_analysis_directory(song['id'])
        assert list(outside.iterdir())==[]
    finally:lib.close()

def test_cache_layout_does_not_change_saved_stem_recipe_identity():
    from chordbuddy.separation_contract import file_hash
    # This adapter file is hashed into every saved stem recipe, so editing it marks every analyzed song stale ("Analyze again").
    # Cache layout must change outside it. It was changed once on purpose (2026-10-14): the models moved to .models/separation
    # with one shared runtime. If you update this hash, say so in the release notes.
    assert file_hash(Path('chordbuddy/separation_recipe.py'))=='ebc72baeb17be282a1d442211c5e46d3975e742f619d54ccb9430e5e1274a873'

def test_import_checks_actual_installation_root_even_with_short_external_library(tmp_path,mp3_bytes):
    from chordbuddy.server import Application
    project=tmp_path/('p'*110)
    app=Application(tmp_path,project_dir=project)
    try:
        with pytest.raises(ValueError,match='shorter'):app.library.import_audio('song.mp3',mp3_bytes)
        assert app.library.state()['songs']==[]
        assert not project.exists()
    finally:app.close()

def test_analysis_checks_actual_installation_root_before_job(library,mp3_bytes):
    from chordbuddy.analysis import AnalysisCoordinator
    from chordbuddy.inference_jobs import InferenceGate
    song=library.import_audio('song.mp3',mp3_bytes)
    job=AnalysisCoordinator(library.root/('p'*110),library,None,None,None,None,InferenceGate(),stage_runner=lambda *a:{'id':'must not run'})
    with pytest.raises(ValueError,match='shorter'):job.start(song['id'])
    assert job.gate.owner is None
    assert library.db.execute('SELECT count(*) FROM analysis_jobs').fetchone()[0]==0

def test_budget_error_reports_longest_path_so_one_move_is_sufficient():
    from chordbuddy.path_policy import validate_paths,utf16_units
    base=str(Path.cwd())+'/'
    short=base+'x'*(245-utf16_units(base));long=base+'y'*(270-utf16_units(base))
    with pytest.raises(ValueError,match='270.*30 units shorter'):validate_paths([short,long])

def test_inside_library_deep_junction_is_rejected_before_job(library,mp3_bytes):
    import os
    if os.name!='nt':pytest.skip('Windows junction check')
    import _winapi
    from chordbuddy.analysis import AnalysisCoordinator
    from chordbuddy.inference_jobs import InferenceGate
    song=library.import_audio('song.mp3',mp3_bytes)
    target=library.root/('deep-'+'x'*140);target.mkdir()
    _winapi.CreateJunction(str(target),str(library.folder(song['id'])/'separation'))
    job=AnalysisCoordinator(Path.cwd(),library,None,None,None,None,InferenceGate(),stage_runner=lambda *a:{'id':'must not run'})
    with pytest.raises(ValueError,match='shorter'):job.start(song['id'])
    assert list(target.iterdir())==[]
    assert library.db.execute('SELECT count(*) FROM analysis_jobs').fetchone()[0]==0
