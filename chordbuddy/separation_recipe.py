"""Only the already-installed private research chain; never downloads."""
import os
from pathlib import Path
from .separation_contract import file_hash
MODELS={
 'base':('bs-roformer-sw','BS-Rofo-SW-Fixed.ckpt','BS-Rofo-SW-Fixed.yaml','24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e'),
 'guitar':('lead-rhythm-guitar','model_mel_band_roformer_ep_72_sdr_3.2232.ckpt','config_mel_band_roformer_Lead_Rhythm_Guitar.yaml','b3c47bca33609ca1ba0bb2d2076410bfd1eb941b051b72afc1f3e24d12b17eef')}
def separation_home(project):return Path(project)/'.models'/'separation'     # shared runtime and libraries, plus one folder per model
def model_root(project,stage):return separation_home(project)/MODELS[stage][0]
def build_recipe(project):
    project=Path(project)
    result={'version':1,'decoder':{'sha256':file_hash(project/'tools/ffmpeg.exe'),'options':['-ar','44100','-ac','2','-c:a','pcm_f32le']},'batch_size':1,'overlap':.5,'shifts':0,'max_gpu_gib':4,'models':{},'adapter':{}}
    for stage,(name,weight,config,expected) in MODELS.items():
        root=model_root(project,stage)
        for required in (separation_home(project)/'runtime/python.exe',root/'weights'/weight,root/'evidence'/config):
            if not required.is_file():raise ValueError('Installed separation files are missing: '+name)
        actual=file_hash(root/'weights'/weight)
        if actual!=expected:raise ValueError('Installed checkpoint hash changed: '+name)
        # Pin all inference source files, not just a claimed commit marker.
        source_hashes={str(p.relative_to(root)):file_hash(p) for p in sorted((root/'source/models/bs_roformer').glob('*.py'))}
        result['models'][stage]={'name':name,'checkpoint':actual,'configuration':file_hash(root/'evidence'/config),'upstream':(root/'evidence/upstream-commit.txt').read_text().strip(),'source':source_hashes}
    for name in ('separation_worker.py','separation_recipe.py','separation_audio.py'):
        result['adapter'][name]=file_hash(project/'chordbuddy'/name)
    return result
def environment(project,work):
    project=Path(project).resolve();work=Path(work).resolve()
    if not work.is_relative_to(project):raise ValueError('Separation must stay inside the project')
    cache=work/'cache';cache.mkdir(exist_ok=True)
    env=os.environ.copy()
    for key in ('TMP','TEMP','TMPDIR'):env[key]=str(cache)
    for key in ('HF_HOME','TORCH_HOME','XDG_CACHE_HOME','CUDA_CACHE_PATH','NUMBA_CACHE_DIR','MPLCONFIGDIR','TORCHINDUCTOR_CACHE_DIR','TRITON_CACHE_DIR','LIBROSA_CACHE_DIR'):
        folder=cache/key.lower();folder.mkdir(exist_ok=True);env[key]=str(folder)
    env.update(PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',DO_NOT_TRACK='1',TORCH_FORCE_WEIGHTS_ONLY_LOAD='1')
    return env

