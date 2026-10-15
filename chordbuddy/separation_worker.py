"""Stage worker using installed modules, with structured progress and no downloads."""
import argparse
import sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import json
import types
from chordbuddy.separation_recipe import MODELS,model_root
from chordbuddy.separation_contract import file_hash
PREFIX='CHORDBUDDY_SEPARATION '
def emit(**value):print(PREFIX+json.dumps(value),flush=True)
def main():
    p=argparse.ArgumentParser();p.add_argument('--project',type=Path,required=True);p.add_argument('--run',type=Path,required=True);p.add_argument('--stage',choices=MODELS,required=True);p.add_argument('--device',choices=['auto','cpu','cuda'],required=True)
    args=p.parse_args();project=args.project.resolve();run=args.run.resolve()
    if not run.is_relative_to(project):raise ValueError('Run outside project')
    import torch,numpy as np,soundfile as sf,yaml
    torch.set_num_threads(8);torch.manual_seed(0)
    root=model_root(project,args.stage);name,weight,config,expected=MODELS[args.stage]
    if file_hash(root/'weights'/weight)!=expected:raise ValueError('Checkpoint hash mismatch')
    class Safe(yaml.SafeLoader):pass
    Safe.add_constructor('tag:yaml.org,2002:python/tuple',lambda loader,node:tuple(loader.construct_sequence(node)))
    cfg=yaml.load((root/'evidence'/config).read_text(),Loader=Safe)
    for key,path in [('models',root/'source/models'),('models.bs_roformer',root/'source/models/bs_roformer')]:
        module=types.ModuleType(key);module.__path__=[str(path)];sys.modules[key]=module
    if args.stage=='base':
        from models.bs_roformer.bs_roformer import BSRoformer as Model
        stems=cfg['training']['instruments']
    else:
        from models.bs_roformer.mel_band_roformer import MelBandRoformer as Model
        stems=['lead']
    device='cuda' if args.device=='auto' and torch.cuda.is_available() else 'cpu' if args.device=='auto' else args.device
    if device=='cuda':
        if not torch.cuda.is_available():raise RuntimeError('CUDA is unavailable')
        free,total=torch.cuda.mem_get_info()
        if free<5*1024**3:raise RuntimeError('Insufficient free GPU memory; no automatic retry')
        torch.cuda.set_per_process_memory_fraction(min(1.,4*1024**3/total))
    kwargs=cfg['model'].copy()
    if args.stage=='guitar':kwargs['match_input_audio_length']=True
    model=Model(**kwargs)
    model.load_state_dict(torch.load(root/'weights'/weight,map_location='cpu',weights_only=True),strict=True)
    model.eval().to(device)
    input_path=run/('original.wav' if args.stage=='base' else 'guitar.wav')
    input_hash=file_hash(input_path)
    audio,rate=sf.read(input_path,dtype='float32',always_2d=True)
    if rate!=44100 or audio.shape[1]!=2 or not np.isfinite(audio).all():raise ValueError('Invalid stage input')
    mix=torch.from_numpy(audio.T.copy());normalize=cfg.get('inference',{}).get('normalize',False)
    mean=mix.mean();std=mix.mean(0).std()
    if normalize and float(std)<1e-8:raise ValueError('Cannot normalize silent input')
    work=(mix-mean)/std if normalize else mix
    length=work.shape[-1];chunk=cfg['audio']['chunk_size'];step=chunk//2
    result=torch.zeros(len(stems),2,length);total=torch.zeros(length)
    for offset in range(0,length,step):
        if device=='cuda' and torch.cuda.mem_get_info()[0]<1024**3:raise RuntimeError('GPU memory reserve exhausted')
        n=min(chunk,length-offset);part=torch.nn.functional.pad(work[:,offset:offset+n],(0,chunk-n))
        with torch.inference_mode():out=model(part[None].to(device)).float().cpu()
        if out.ndim==3:out=out[:,None]
        out=out[0,...,:n]
        if list(out.shape)!=[len(stems),2,n] or not torch.isfinite(out).all():raise ValueError('Invalid model output')
        ramp=torch.arange(1,chunk+1,dtype=torch.float32);window=torch.minimum(ramp,ramp.flip(0));window/=window.max();window=window[:n]
        result[...,offset:offset+n]+=out*window;total[offset:offset+n]+=window
        emit(completed=min(offset+n,length),total=length,unit='frames')
        if offset+n>=length:break
    result/=total
    if normalize:result=result*std+mean
    if not torch.isfinite(result).all():raise ValueError('Nonfinite result')
    for stem,data in zip(stems,result):sf.write(run/(stem.lower()+'.wav'),data.numpy().T,44100,subtype='FLOAT')
    if args.stage=='guitar':sf.write(run/'rhythm.wav',(mix-result[0]).numpy().T,44100,subtype='FLOAT')
    (run/(args.stage+'-stage.json')).write_text(json.dumps({'input_sha256':input_hash,'frames':length,'device':device,'checkpoint_sha256':expected}),encoding='utf-8')
if __name__=='__main__':main()

