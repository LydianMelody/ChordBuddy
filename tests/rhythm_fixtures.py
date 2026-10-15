import copy
import numpy as np
from chordbuddy.separation_audio import write_float

def drum_fixture(path,offset=0.08,silent=False,offbeat=False):
    rate=44100;duration=12;audio=np.zeros((rate*duration,2),dtype=np.float32)
    truth=np.arange(.5,11.5,.5)
    for i,t in enumerate(truth+(.25 if offbeat else 0)):
        if not silent:
            start=round(t*rate);n=440
            audio[start:start+n]=np.random.default_rng(i).normal(0,.2,(n,1))*np.exp(-np.arange(n)[:,None]/80)
    write_float(path,audio.ravel())
    bars=[]
    for i in range(5):
        beats=[float(t+offset) for t in truth[i*4:i*4+4]]
        bars.append({'id':f'm{i}','number':i+1,'start':beats[0],'end':float(truth[(i+1)*4]+offset),
                     'beats':beats,'meter':[4,4],'beat_visible':[True]*4,'beat_inferred':[False]*4,'beat_confidence':[.3]*4,'warning':None})
    return {'bars':bars,'beats':[t for b in bars for t in b['beats']],'correspondence':{b['id']:b['id'] for b in bars}},truth
