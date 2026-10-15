"""Bounded paths for the pinned portable workers; no legacy-folder migration."""
from contextlib import contextmanager
from pathlib import Path
import uuid
import os

MAX_PATH_UNITS = 240
COLLISION_ATTEMPTS = 32
# LIBROSA_CACHE_DIR is deliberately NOT set: each job gets a fresh scratch folder, so librosa's disk cache could never be reused,
# and reserving room for its deepest file (joblib/librosa/filters/mel/<hash>/metadata.json.thread-<id>-pid-<pid>) alone
# cost about 48 characters of the install-folder budget.
CACHE_DIRS = {'HF_HOME':'h', 'TORCH_HOME':'t', 'XDG_CACHE_HOME':'x',
              'CUDA_CACHE_PATH':'d', 'NUMBA_CACHE_DIR':'n', 'MPLCONFIGDIR':'m',
              'TORCHINDUCTOR_CACHE_DIR':'i', 'TRITON_CACHE_DIR':'r'}

class PathBudgetError(ValueError):
    """An app-generated path exceeds the portable filesystem budget."""

def utf16_units(value):
    return len(str(value).encode('utf-16-le')) // 2

def validate_paths(paths):
    resolved=[Path(path).resolve() for path in paths]
    if not resolved:return
    path=max(resolved,key=utf16_units)
    units=utf16_units(path)
    if units > MAX_PATH_UNITS:
        raise PathBudgetError(f'Generated path needs {units} UTF-16 units; the limit is 240. '
                              f'Close Chord Buddy and move the whole portable folder to a shorter location '
                              f'(at least {units-240} units shorter), then retry. No song folders are renamed. Path: {path}')

def worker_paths(work):
    work=Path(work)
    return [work/'manifest.json', work/'source.mp3', work/'original.wav',
            work/'guitar-stage.json', work/'proposal.json', work/'request.json',
            work/'c'/('tmp'+'x'*32)/('x'*32),
            work/'c/d'/'f'/'f'/('a'*64),
            work/'c/m'/'fontlist-v999.json']

def song_paths(library_root,folder):
    root,folder=Path(library_root),Path(folder)
    run=folder/'runs'/('a'*12)
    # Pinned model outputs include score, beat/chord/key/structure annotations,
    # events, confidence sidecars and unfiltered copies; reserve export suffixes.
    paths=[folder/'source.mp3',root/'library.sqlite3-wal',root/'library.sqlite3-shm',
           root/'retention'/('stem-purge-'+'a'*32+'.json.partial'),
           run/'unfiltered'/'structure.lab',run/'confidence.json.tmp',
           run/'edited'/'Song chart.json.partial',run/'run-options.json']
    for kind in ('separation','analysis'):
        paths.extend(worker_paths(folder/kind/('a'*32)))
    return paths

def validate_song(library_root,folder):
    validate_paths(song_paths(library_root,folder))

def validate_project(project):
    """Pinned model/module and temporary paths use the installation, not library root."""
    project=Path(project).resolve()
    model=project/'.models/hf/hub/models--m-a-p--SheetSage2'
    validate_paths([
        model/'snapshots'/('a'*40)/'render_assets/soundfonts/acoustic_grand_piano-mp3/Ab1.mp3',
        model/'blobs'/('a'*64+'.incomplete'),
        project/'.models/modules/transformers_modules/m-a-p/SheetSage2'/('a'*40)/'configuration_sheetsage2.py',
        project/'.models/tmp'/('tmp'+'a'*32)/('a'*32+'.py'),
        project/'.models/hf/hub/.locks/models--m-a-p--MERT-v2-FullSong'/('a'*64+'.lock'),
    ])

def new_id(length):
    return uuid.uuid4().hex[:length]

@contextmanager
def reserve_directory(parent,length,used=lambda ident:False):
    """Exclusive mkdir is the filesystem claim; callers hold the database lock."""
    parent=Path(parent)
    for _ in range(COLLISION_ATTEMPTS):
        ident=new_id(length)
        if used(ident):continue
        path=parent/ident
        try:path.mkdir(parents=True,exist_ok=False)
        except FileExistsError:continue
        try:yield path
        except BaseException:
            # Only our empty reservation; never remove another run's contents.
            try:path.rmdir()
            except OSError:pass
            raise
        return
    raise ValueError('Could not allocate a unique song/run ID after 32 attempts. Retry the operation.')

def worker_environment(project,work):
    """Short per-job caches, outside the immutable hashed inference recipe."""
    project=Path(project).resolve();work=Path(work).resolve()
    if not work.is_relative_to(project):raise ValueError('Separation must stay inside the project')
    validate_paths(worker_paths(work))
    cache=work/'c';cache.mkdir(exist_ok=True)
    env=os.environ.copy()
    env.pop('LIBROSA_CACHE_DIR',None)   # never inherit a cache location that could be long or outside the project
    for key in ('TMP','TEMP','TMPDIR'):env[key]=str(cache)
    for key,short in CACHE_DIRS.items():
        folder=cache/short;folder.mkdir(exist_ok=True);env[key]=str(folder)
    # GPU kernels compiled for this graphics card are reused by every job. A fresh cache per job made each separation stage
    # recompile them (about 15 s each on an RTX 5090, 24 s instead of 9 s); the default limit of 256 MB is also too small.
    shared=project/'.models'/'cuda-cache';shared.mkdir(parents=True,exist_ok=True)
    env['CUDA_CACHE_PATH']=str(shared);env['CUDA_CACHE_MAXSIZE']=str(2*1024**3)
    env.update(PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',DO_NOT_TRACK='1',TORCH_FORCE_WEIGHTS_ONLY_LOAD='1')
    return env
