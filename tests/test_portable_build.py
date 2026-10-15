import json
from pathlib import Path

import pytest
from chordbuddy.engine import MODEL_REVISION

try:
    import build_portable
except ImportError:
    build_portable=None


@pytest.fixture
def build_inputs(tmp_path):
    source,base,ffmpeg,destination=[tmp_path/name for name in ('source','python-base','ffmpeg','portable')]
    def file(root,name,data=b'fixture'):
        path=root/name
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(data)
    for name in ('chordbuddy/__init__.py','chordbuddy/web/index.html','docs/DESIGN.md','tests/test_sample.py',
                 'portable_start.py','Start Portable.cmd','HANDOFF.md','requirements.txt','setup_app.py'):
        file(source,name)
    for name in ('.env','.env.secret','.models/hf/token','.models/hf/stored_tokens','Data/private/source.mp3',
                 '__pycache__/setup_app.pyc','chordbuddy/__pycache__/app.pyc'):
        file(source,name,b'PRIVATE MUST NOT SHIP')
    file(source,'Start Chord Buddy.cmd',b'original .venv launcher')
    file(source,'Start Portable.cmd',b'@echo off\r\n"runtime\\pythonw.exe" "portable_start.py" %*\r\n')
    file(source,'.venv/Lib/site-packages/app_module.py')
    file(source,'.venv/Lib/site-packages/__pycache__/app_module.pyc')
    file(source,'.engine-venv/Lib/site-packages/torch/version.py',b"__version__='2.8.0+cpu'")
    file(source,'.engine-venv/Lib/site-packages/.env',b'PRIVATE MUST NOT SHIP')
    file(source,'.engine-venv/chordbuddy-ready.json',json.dumps({'python':'3.11','device':'cpu','revision':MODEL_REVISION}).encode())
    file(source,'.models/hf/hub/models--fixture/snapshots/revision/model.safetensors',b'weights')
    file(source,'.models/hf/hub/.locks/models--fixture/weight.lock')
    file(source,'.models/hf/hub/model.incomplete')
    file(source,'.models/modules/transformers_modules/fixture/model.py')
    file(source,'.models/modules/transformers_modules/fixture/__pycache__/model.pyc')
    for name in ('python.exe','pythonw.exe','python311.dll','python3.dll','vcruntime140.dll','LICENSE.txt',
                 'DLLs/_socket.pyd','Lib/encodings/__init__.py','Lib/json/__init__.py'):
        file(base,name)
    file(base,'Lib/site-packages/global_private.py',b'PRIVATE MUST NOT SHIP')
    file(base,'Lib/test/private_test.py')
    file(base,'Lib/json/__pycache__/decoder.pyc')
    file(ffmpeg,'bin/ffmpeg.exe')
    file(ffmpeg,'bin/avcodec.dll')
    file(ffmpeg,'LICENSE.txt',b'FFmpeg license')
    return source,base,ffmpeg/'bin',destination


def perform_build(inputs,**kwargs):
    assert build_portable is not None,'Portable folder builder is missing'
    source,base,ffmpeg,destination=inputs
    return build_portable.build(source,destination,python_base=base,ffmpeg_bin=ffmpeg,**kwargs)


def test_portable_excludes_private_environment_and_keeps_runtime_paths_relative(build_inputs):
    perform_build(build_inputs)
    source,base,ffmpeg,destination=build_inputs
    names=[path.relative_to(destination).as_posix() for path in destination.rglob('*') if path.is_file()]
    assert 'chordbuddy/web/index.html' in names
    launcher=(destination/'Start Chord Buddy.cmd').read_text()
    assert 'runtime\\pythonw.exe' in launcher and 'portable_start.py' in launcher
    assert (destination/'Start Chord Buddy.cmd').read_bytes()==(source/'Start Portable.cmd').read_bytes()
    assert '.venv' not in launcher
    assert 'runtime/python.exe' in names
    assert 'runtime/Lib/encodings/__init__.py' in names
    assert 'runtime/DLLs/_socket.pyd' in names
    assert 'runtime/app-packages/app_module.py' in names
    assert 'runtime/engine-packages/torch/version.py' in names
    assert 'tools/ffmpeg.exe' in names
    assert any('LICENSE' in name and name.startswith('tools/') for name in names)
    assert '.models/hf/hub/models--fixture/snapshots/revision/model.safetensors' in names
    assert '.models/modules/transformers_modules/fixture/model.py' in names
    assert not any('__pycache__' in name or name.endswith(('.pyc','.incomplete','.lock')) for name in names)
    assert not any(name.startswith(('.venv/','.engine-venv/','Data/')) for name in names)
    assert not any(path.read_bytes()==b'PRIVATE MUST NOT SHIP' for path in destination.rglob('*') if path.is_file())
    paths=(destination/'runtime'/'python311._pth').read_text().splitlines()
    assert paths==['Lib','DLLs','app-packages','engine-packages','..','import site']
    assert all(not Path(line).is_absolute() for line in paths if line!='import site')
    manifest=json.loads((destination/'portable.json').read_text())
    assert manifest['device']=='cpu'
    assert manifest['runtime']=='runtime/python.exe'
    assert manifest['ffmpeg']=='tools'
    assert (destination/'Data').is_dir() and not any((destination/'Data').iterdir())
    assert str(source) not in json.dumps(manifest)
    assert json.loads((destination/'runtime'/'chordbuddy-ready.json').read_text())['revision']==build_portable.MODEL_REVISION


def test_full_build_refuses_overwriting_existing_destination(build_inputs):
    destination=build_inputs[-1]
    destination.mkdir()
    sentinel=destination/'existing.txt'
    sentinel.write_text('keep me')
    with pytest.raises(FileExistsError):
        perform_build(build_inputs)
    assert sentinel.read_text()=='keep me'


def test_code_only_sync_preserves_data_weights_and_runtime(build_inputs):
    perform_build(build_inputs)
    source,base,ffmpeg,destination=build_inputs
    data=destination/'Data'/'library.sqlite3'
    data.parent.mkdir(exist_ok=True)
    data.write_bytes(b'user library')
    runtime=(destination/'runtime'/'python.exe').read_bytes()
    weight=destination/'.models/hf/hub/models--fixture/snapshots/revision/model.safetensors'
    (source/'chordbuddy'/'__init__.py').write_text('updated source')
    (source/'.models/hf/hub/models--fixture/snapshots/revision/model.safetensors').write_bytes(b'different weights')
    perform_build(build_inputs,code_only=True)
    assert (destination/'chordbuddy'/'__init__.py').read_text()=='updated source'
    assert data.read_bytes()==b'user library'
    assert (destination/'runtime'/'python.exe').read_bytes()==runtime
    assert weight.read_bytes()==b'weights'


def test_portable_requires_completed_cpu_engine_setup(build_inputs):
    source=build_inputs[0]
    marker=source/'.engine-venv/chordbuddy-ready.json'
    marker.write_text(json.dumps({'python':'3.11','device':'cuda','revision':MODEL_REVISION}))
    with pytest.raises(ValueError,match='CPU'):
        perform_build(build_inputs)
    assert not build_inputs[-1].exists()
