"""Bounded float WAV validation and frame-addressed multitrack reads."""
import array
import math
import struct
import sys
from pathlib import Path
from .separation_contract import TRACKS,SAMPLE_RATE,file_hash

def write_float(path,samples):
    data=array.array('f',samples)
    if sys.byteorder!='little':data.byteswap()
    payload=data.tobytes()
    with open(path,'wb') as out:
        out.write(struct.pack('<4sI4s4sIHHIIHH4sI',b'RIFF',36+len(payload),b'WAVE',b'fmt ',16,3,2,SAMPLE_RATE,SAMPLE_RATE*8,8,32,b'data',len(payload)))
        out.write(payload)

def index_wav(path,scan=False):
    size=Path(path).stat().st_size
    fmt=None;data=None
    with open(path,'rb') as stream:
        header=stream.read(12)
        if len(header)!=12 or header[:4]!=b'RIFF' or header[8:]!=b'WAVE':raise ValueError('Expected RIFF float WAV')
        if struct.unpack_from('<I',header,4)[0]+8>size:raise ValueError('Truncated WAV')
        while stream.tell()+8<=size:
            tag,length=struct.unpack('<4sI',stream.read(8));offset=stream.tell()
            if offset+length>size:raise ValueError('Truncated WAV chunk')
            if tag==b'fmt ':
                if length<16 or length>1024:raise ValueError('Invalid WAV format')
                raw=stream.read(length);code,ch,rate,_,align,bits=struct.unpack_from('<HHIIHH',raw)
                if code==65534 and length>=40:code=struct.unpack_from('<H',raw,24)[0]
                fmt=(code,ch,rate,align,bits)
            elif tag==b'data':
                if data is not None:raise ValueError('Duplicate WAV data')
                data=(offset,length)
            stream.seek(offset+length+(length%2))
    if fmt!=(3,2,SAMPLE_RATE,8,32) or data is None or data[1]%8:raise ValueError('Expected stereo 44100 Hz float32 PCM')
    info={'data_offset':data[0],'frames':data[1]//8,'sample_rate':SAMPLE_RATE,'channels':2,'format':'float32le'}
    if info['frames']<=0:raise ValueError('Empty audio')
    if scan:
        for start in range(0,info['frames'],SAMPLE_RATE):
            if not all(math.isfinite(x) for x in read_frames(path,info,start,min(SAMPLE_RATE,info['frames']-start))):raise ValueError('Nonfinite audio')
    return info

def read_frames(path,info,start,count):
    if type(start)!=int or type(count)!=int or start<0 or not 1<=count<=SAMPLE_RATE or start>=info['frames']:raise ValueError('Invalid PCM frame bounds')
    count=min(count,info['frames']-start)
    with open(path,'rb') as stream:
        stream.seek(info['data_offset']+start*8);raw=stream.read(count*8)
    if len(raw)!=count*8:raise ValueError('Truncated audio')
    result=array.array('f');result.frombytes(raw)
    if sys.byteorder!='little':result.byteswap()
    return result

def validate_mix(root,check_cancel=lambda:None):
    root=Path(root);infos={r:index_wav(root/(r+'.wav')) for r in TRACKS+('guitar',)}
    frames=infos['original']['frames']
    if any(i['frames']!=frames for i in infos.values()):raise ValueError('Output frame count mismatch')
    peak=0.
    for start in range(0,frames,SAMPLE_RATE):
        check_cancel();count=min(SAMPLE_RATE,frames-start)
        values={r:read_frames(root/(r+'.wav'),i,start,count) for r,i in infos.items()}
        if any(not math.isfinite(x) for v in values.values() for x in v):raise ValueError('Nonfinite audio')
        for i in range(count*2):
            guitar=values['guitar'][i];combined=values['lead'][i]+values['rhythm'][i]
            if abs(combined-guitar)>1e-6+1e-6*abs(guitar):raise ValueError('Lead and Rhythm do not reconstruct Guitar')
            peak=max(peak,abs(values['original'][i]),sum(abs(values[r][i]) for r in TRACKS[1:]))
    assets=[dict(infos[r],role=r,relative_path=r+'.wav',file_sha256=file_hash(root/(r+'.wav'))) for r in TRACKS]
    return {'sample_rate':SAMPLE_RATE,'channels':2,'frames':frames,'common_gain':min(1.,.95/peak) if peak else 1.,'assets':assets,'intermediate':dict(infos['guitar'],relative_path='guitar.wav',file_sha256=file_hash(root/'guitar.wav'))}

def wire_chunk(root,manifest,start,count):
    if type(count)!=int or not 1<=count<=SAMPLE_RATE or type(start)!=int or not 0<=start<manifest['frames']:raise ValueError('Invalid PCM frame bounds')
    actual=min(count,manifest['frames']-start);payload=[]
    by_role={a['role']:a for a in manifest['assets']}
    if set(by_role)!=set(TRACKS):raise ValueError('Invalid playback roles')
    for role in TRACKS:
        a=by_role[role];values=read_frames(Path(root)/a['relative_path'],a,start,actual)
        if sys.byteorder!='little':values.byteswap()
        payload.append(values.tobytes())
    return b''.join(payload),actual



def waveform_peaks(info,read_block,bins=1024):
    """Bounded read-only stereo peak envelope on the recorded frame axis."""
    frames=info.get('frames');rate=info.get('sample_rate')
    if type(frames)!=int or frames<=0 or rate!=SAMPLE_RATE or info.get('channels')!=2 or type(bins)!=int or not 1<=bins<=2048:
        raise ValueError('Invalid waveform bounds')
    count=min(bins,frames);peaks=[0.]*count
    for start in range(0,frames,SAMPLE_RATE):
        size=min(SAMPLE_RATE,frames-start);values=read_block(start,size)
        if len(values)!=size*2:raise ValueError('Truncated waveform samples')
        for i in range(size):
            a,b=values[i*2:i*2+2]
            if not math.isfinite(a) or not math.isfinite(b):raise ValueError('Nonfinite waveform samples')
            bucket=(start+i)*count//frames;peaks[bucket]=max(peaks[bucket],abs(a),abs(b))
    return {'frames':frames,'sample_rate':rate,'duration':frames/rate,'peaks':peaks}
