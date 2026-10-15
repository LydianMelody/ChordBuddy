"""Copy a self-contained Windows CPU edition; never install or run inference.

Full builds require a new or empty destination. --code-only updates source and
documentation in an existing portable folder while preserving Data, runtime,
models and all existing files. No mode deletes files.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

from chordbuddy.engine import MODEL_REVISION

DEFAULT_FFMPEG=Path('C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin')
PTH_LINES=['Lib','DLLs','app-packages','engine-packages','..','import site']
PRIVATE_NAMES={'token','stored_tokens','hf_token','.env','pyvenv.cfg'}
IGNORED_DIRS={'__pycache__','.pytest_cache','.git','.locks','.cache'}


def ignored(name,exclude_dirs=()):
    lower=name.lower()
    return (name in IGNORED_DIRS or name in exclude_dirs or lower in PRIVATE_NAMES
            or lower.startswith('.env.') or lower.endswith(('.pyc','.pyo','.lock','.incomplete')))


def copy_file(source,destination):
    destination.parent.mkdir(parents=True,exist_ok=True)
    if source.suffix.lower()=='.pth':
        for line in source.read_text(encoding='utf-8').splitlines():
            value=line.strip()
            if value and not value.startswith(('#','import ')) and (Path(value).is_absolute() or len(value)>1 and value[1]==':'):
                raise ValueError(f'Package path file contains an absolute environment path: {source.name}')
    shutil.copy2(source,destination)


def copy_tree(source,destination,exclude_dirs=()):
    source=source.resolve()
    count=0
    for directory,dirs,files in os.walk(source,followlinks=False):
        dirs[:]=[name for name in dirs if not ignored(name,exclude_dirs) and not (Path(directory)/name).is_symlink()]
        relative=Path(directory).relative_to(source)
        for name in files:
            if ignored(name):
                continue
            file=Path(directory)/name
            if file.is_symlink() and not file.resolve().is_relative_to(source):
                raise ValueError(f'File points outside the selected package tree: {file.name}')
            copy_file(file,destination/relative/name)
            count+=1
    return count


def copy_code(source,destination):
    count=0
    for name in ('chordbuddy','docs','tests'):
        directory=source/name
        if directory.is_dir():
            count+=copy_tree(directory,destination/name)
    for file in source.iterdir():
        if file.is_file() and not file.is_symlink() and not ignored(file.name) and file.name!='portable.json' and file.suffix.lower() in {'.py','.md','.txt','.cmd','.bat','.json'}:
            copy_file(file,destination/file.name)
            count+=1
    if not (source/'Start Portable.cmd').is_file():
        raise ValueError('The source Start Portable.cmd launcher is missing')
    copy_file(source/'Start Portable.cmd',destination/'Start Chord Buddy.cmd')
    return count


def build(source,destination,*,python_base=None,ffmpeg_bin=DEFAULT_FFMPEG,code_only=False):
    source,destination=Path(source).resolve(),Path(destination).resolve()
    if destination==source or destination.is_relative_to(source):
        raise ValueError('The portable destination must be outside the source application folder')
    if code_only:
        if not (destination/'portable.json').is_file():
            raise ValueError('--code-only requires an existing portable folder')
        print('Updating app source and documentation; preserving Data, models and runtime…',flush=True)
        count=copy_code(source,destination)
        (destination/'Data').mkdir(exist_ok=True)
        manifest_path=destination/'portable.json'
        manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['ffmpeg']='tools'
        manifest_path.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
        return {'destination':str(destination),'files_copied':count,'code_only':True}
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise FileExistsError('The destination already contains files. Choose a new empty folder or use --code-only for an existing portable build.')
    python_base=Path(python_base or sys.base_prefix).resolve()
    ffmpeg_bin=Path(ffmpeg_bin).resolve()
    app_packages=source/'.venv/Lib/site-packages'
    engine_packages=source/'.engine-venv/Lib/site-packages'
    marker=source/'.engine-venv/chordbuddy-ready.json'
    try:
        ready=json.loads(marker.read_text(encoding='utf-8'))
    except (OSError,ValueError) as exc:
        raise ValueError('Complete CPU engine setup before building the portable folder') from exc
    if ready.get('device')!='cpu' or ready.get('python')!='3.11' or ready.get('revision')!=MODEL_REVISION:
        raise ValueError('The portable baseline requires completed Python 3.11 CPU engine setup for the pinned model')
    required=[python_base/'python.exe',python_base/'python311.dll',python_base/'Lib',python_base/'DLLs',
              app_packages,engine_packages,source/'.models/hf/hub',source/'.models/modules',ffmpeg_bin/'ffmpeg.exe',
              source/'portable_start.py',source/'Start Portable.cmd']
    missing=[str(path) for path in required if not path.exists()]
    if missing:
        raise ValueError('Portable build input is missing: '+', '.join(missing))
    version=engine_packages/'torch/version.py'
    if not version.is_file() or '+cpu' not in version.read_text(encoding='utf-8'):
        raise ValueError('The portable baseline requires CPU Torch wheels; run setup_engine.py --device cpu first')
    destination.mkdir(parents=True,exist_ok=True)
    (destination/'Data').mkdir(exist_ok=True)
    runtime=destination/'runtime'
    count=0
    print('Copying application source, documentation and tests…',flush=True)
    count+=copy_code(source,destination)
    print('Copying isolated Python 3.11 runtime and standard library…',flush=True)
    for file in python_base.iterdir():
        if file.is_file() and (file.suffix.lower() in {'.dll','.zip'} or file.name.lower() in {'python.exe','pythonw.exe','license.txt'}):
            copy_file(file,runtime/file.name)
            count+=1
    count+=copy_tree(python_base/'Lib',runtime/'Lib',exclude_dirs={'site-packages','test','tests'})
    count+=copy_tree(python_base/'DLLs',runtime/'DLLs',exclude_dirs={'test','tests'})
    print('Copying application packages and CPU inference packages…',flush=True)
    count+=copy_tree(app_packages,runtime/'app-packages')
    count+=copy_tree(engine_packages,runtime/'engine-packages')
    pth='\n'.join(PTH_LINES)+'\n'
    (runtime/'python311._pth').write_text(pth,encoding='utf-8')
    (runtime/'python._pth').write_text(pth,encoding='utf-8')
    print('Copying existing model weights and trusted model code, without tokens or locks…',flush=True)
    count+=copy_tree(source/'.models/hf/hub',destination/'.models/hf/hub')
    count+=copy_tree(source/'.models/modules',destination/'.models/modules')
    print('Copying FFmpeg binaries and distribution licenses…',flush=True)
    for file in ffmpeg_bin.iterdir():
        if file.is_file() and file.suffix.lower() in {'.exe','.dll'}:
            copy_file(file,destination/'tools'/file.name)
            count+=1
    ffmpeg_root=ffmpeg_bin.parent
    for file in ffmpeg_root.rglob('*'):
        if file.is_file() and not file.is_symlink() and any(term in file.name.lower() for term in ('license','copying','copyright','notice')):
            copy_file(file,destination/'tools/licenses'/file.relative_to(ffmpeg_root))
            count+=1
    (runtime/'chordbuddy-ready.json').write_text(json.dumps(ready,indent=2),encoding='utf-8')
    manifest={'version':1,'python':'3.11','device':'cpu','runtime':'runtime/python.exe','model_revision':MODEL_REVISION,
              'app_packages':'runtime/app-packages','engine_packages':'runtime/engine-packages','ffmpeg':'tools'}
    # This last marker means all required copying completed successfully.
    (destination/'portable.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(f'Portable copy complete: {destination}',flush=True)
    return {'destination':str(destination),'files_copied':count,'code_only':False}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=Path(__file__).resolve().parent)
    parser.add_argument('--destination',type=Path)
    parser.add_argument('--python-base',type=Path,default=Path(sys.base_prefix))
    parser.add_argument('--ffmpeg-bin',type=Path,default=DEFAULT_FFMPEG)
    parser.add_argument('--code-only',action='store_true')
    args=parser.parse_args(argv)
    destination=args.destination or args.source.resolve().parent/'ChordBuddy-Portable'
    try:
        result=build(args.source,destination,python_base=args.python_base,ffmpeg_bin=args.ffmpeg_bin,code_only=args.code_only)
        print(f"Copied {result['files_copied']} files.",flush=True)
        return 0
    except (OSError,ValueError) as exc:
        print(f'Portable build failed: {exc}',file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
