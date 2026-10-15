"""Fast whole-block checks on separated audio (numpy). Same rules and the same results as the plain-Python versions in
separation_audio.py, which stays untouched because the separation recipe pins its exact contents."""
import numpy as np
from .separation_audio import index_wav,read_frames
from .separation_contract import TRACKS,SAMPLE_RATE,file_hash
from pathlib import Path

def validate_mix(root,check_cancel=lambda:None):
    root=Path(root);infos={r:index_wav(root/(r+'.wav')) for r in TRACKS+('guitar',)}
    frames=infos['original']['frames']
    if any(i['frames']!=frames for i in infos.values()):raise ValueError('Output frame count mismatch')
    peak=0.
    for start in range(0,frames,SAMPLE_RATE):
        check_cancel();count=min(SAMPLE_RATE,frames-start)
        # whole-second blocks as numpy arrays (double precision, summed in the same order as before, so results are identical)
        values={r:np.frombuffer(read_frames(root/(r+'.wav'),i,start,count),dtype=np.float32).astype(np.float64) for r,i in infos.items()}
        if not all(np.isfinite(v).all() for v in values.values()):raise ValueError('Nonfinite audio')
        guitar=values['guitar'];combined=values['lead']+values['rhythm']
        if (np.abs(combined-guitar)>1e-6+1e-6*np.abs(guitar)).any():raise ValueError('Lead and Rhythm do not reconstruct Guitar')
        stems=np.abs(values[TRACKS[1]]).copy()
        for r in TRACKS[2:]:stems+=np.abs(values[r])
        peak=max(peak,float(np.abs(values['original']).max()),float(stems.max()))
    assets=[dict(infos[r],role=r,relative_path=r+'.wav',file_sha256=file_hash(root/(r+'.wav'))) for r in TRACKS]
    return {'sample_rate':SAMPLE_RATE,'channels':2,'frames':frames,'common_gain':min(1.,.95/peak) if peak else 1.,'assets':assets,'intermediate':dict(infos['guitar'],relative_path='guitar.wav',file_sha256=file_hash(root/'guitar.wav'))}

def waveform_peaks(info,read_block,bins=1024):
    """Bounded read-only stereo peak envelope on the recorded frame axis."""
    frames=info.get('frames');rate=info.get('sample_rate')
    if type(frames)!=int or frames<=0 or rate!=SAMPLE_RATE or info.get('channels')!=2 or type(bins)!=int or not 1<=bins<=2048:
        raise ValueError('Invalid waveform bounds')
    count=min(bins,frames);peaks=np.zeros(count)
    for start in range(0,frames,SAMPLE_RATE):
        size=min(SAMPLE_RATE,frames-start);values=read_block(start,size)
        if len(values)!=size*2:raise ValueError('Truncated waveform samples')
        pair=np.asarray(values,dtype=np.float64).reshape(size,2)
        if not np.isfinite(pair).all():raise ValueError('Nonfinite waveform samples')
        loudest=np.abs(pair).max(axis=1)
        buckets=(start+np.arange(size,dtype=np.int64))*count//frames
        firsts=np.concatenate(([0],np.flatnonzero(np.diff(buckets))+1))
        np.maximum.at(peaks,buckets[firsts],np.maximum.reduceat(loudest,firsts))
    peaks=[float(x) for x in peaks]
    return {'frames':frames,'sample_rate':rate,'duration':frames/rate,'peaks':peaks}
