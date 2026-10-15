"""Deterministic drum evidence. Conservative engineering scores, not probabilities."""
import copy
import numpy as np
from scipy.signal import find_peaks
from .separation_audio import index_wav,read_frames

DEFAULTS={'window':1024,'hop':220,'support_tolerance':.035,'minimum_coverage':.8,'minimum_margin':.12,'minimum_beats':12,'no_op_seconds':.002}

def analyze_drum_rhythm(drums,baseline,provenance,settings,check_cancel,progress):
    check_cancel();settings={**DEFAULTS,**settings};info=index_wav(drums)
    rate=info['sample_rate'];window=settings['window'];hop=settings['hop']
    if not isinstance(window,int) or not isinstance(hop,int) or not 128<=window<=8192 or not 1<=hop<=window:raise ValueError('Invalid analysis window')
    bars=copy.deepcopy(baseline.get('bars',[]));beats=np.array([t for b in bars for t in b['beats']],dtype=float)
    result={**provenance,'algorithm':'drum-grid-v1','settings':settings,'bars':bars,'baseline_bars':copy.deepcopy(bars),'beats':beats.tolist(),
            'correspondence':{b['id']:b['id'] for b in bars},'diagnostics':{'status':'unresolved','reason':'Insufficient consistent drum evidence','sample_rate':rate,'window':window,'hop':hop,'latency_seconds':0}}
    if len(beats)<settings['minimum_beats'] or not all(b.get('meter') for b in bars):return result
    flux=[];times=[];carry=np.zeros(0);previous=None;cursor=0
    weights=np.hanning(window);freq=np.fft.rfftfreq(window,1/rate)
    bands=[(freq>=lo)&(freq<hi) for lo,hi in [(40,180),(180,2000),(2000,16000)]]
    for start in range(0,info['frames'],rate):
        check_cancel();samples=np.asarray(read_frames(drums,info,start,min(rate,info['frames']-start))).reshape(-1,2)
        if not np.isfinite(samples).all():raise ValueError('Nonfinite drum audio')
        data=np.concatenate((carry,np.mean(samples,axis=1)));origin=start-len(carry);offset=0
        while offset+window<=len(data):
            spectrum=np.abs(np.fft.rfft(data[offset:offset+window]*weights))
            strength=0 if previous is None else sum(float(np.maximum(spectrum[band]-previous[band],0).mean()) for band in bands)
            flux.append(strength);times.append((origin+offset+window/2)/rate);previous=spectrum;offset+=hop
        carry=data[offset:];progress({'completed':min(start+rate,info['frames']),'total':info['frames'],'unit':'frames'})
    values=np.array(flux)
    if not len(values) or values.max()<1e-8:return result
    peaks,_=find_peaks(values,height=max(np.quantile(values,.8),values.max()*.08),distance=max(1,round(.07*rate/hop)),prominence=values.max()*.04)
    onsets=np.array(times)[peaks]
    result['diagnostics']['onset_count']=len(onsets)
    if len(onsets)<settings['minimum_beats']:return result
    interval=float(np.median(np.diff(beats)))
    if not .12<=interval<=3:return result
    # Compare whole-grid and independently supported five-bar passages.
    def choose(points,scales=(.98,1.,1.02)):
        candidates=[];tolerance=settings['support_tolerance']
        for scale in scales:
            for shift in np.arange(-interval/2,interval/2+.001,.005):
                shifted=points[0]+(points-points[0])*scale+shift
                indices=np.searchsorted(onsets,shifted)
                distances=np.minimum(abs(shifted-onsets[np.clip(indices,0,len(onsets)-1)]),abs(shifted-onsets[np.clip(indices-1,0,len(onsets)-1)]))
                support=float(np.mean(np.maximum(0,1-distances/tolerance)))
                candidates.append((support,float(np.mean(distances<tolerance)),float(shift),scale))
        candidates.sort(reverse=True);best=candidates[0]
        competitors=[c for c in candidates if abs(c[2]-best[2])>=interval*.15 or abs(c[3]-best[3])>=.019]
        margin=best[0]-(max(c[0] for c in competitors) if competitors else 0)
        return best,margin,candidates[:5]
    best,margin,candidates=choose(beats)
    diagnostics=result['diagnostics'];diagnostics.update(support=best[0],coverage=best[1],margin=margin,shift_seconds=best[2],scale=best[3],candidates=[list(c) for c in candidates])
    if best[1]<settings['minimum_coverage'] or margin<settings['minimum_margin']:
        passages=[];accepted=False;supported=[False]*len(bars)
        for start in range(0,len(bars),5):
            check_cancel();part=bars[start:start+5];points=np.array([t for b in part for t in b['beats']])
            if len(points)<settings['minimum_beats']:
                passages.append({'first':part[0]['id'],'last':part[-1]['id'],'status':'unresolved','reason':'Too few beats'});continue
            candidate,local_margin,_=choose(points,scales=(1.,))
            good=candidate[1]>=settings['minimum_coverage'] and local_margin>=settings['minimum_margin'] and abs(candidate[2])<interval*.45 and points[0]+candidate[2]>=0
            if not good:passages.append({'first':part[0]['id'],'last':part[-1]['id'],'status':'unresolved','shift_seconds':candidate[2],'support':candidate[0],'coverage':candidate[1],'margin':local_margin,'reason':'Competing hypotheses or sparse support'})
            if good:
                shift=0 if abs(candidate[2])<settings['no_op_seconds'] else candidate[2]
                for index,bar in enumerate(part,start):
                    shifted=np.array(bar['beats'])+shift;positions=np.searchsorted(onsets,shifted)
                    distances=np.minimum(abs(shifted-onsets[np.clip(positions,0,len(onsets)-1)]),abs(shifted-onsets[np.clip(positions-1,0,len(onsets)-1)]))
                    coverage=float(np.mean(distances<settings['support_tolerance']));local_good=coverage>=settings['minimum_coverage']
                    supported[index]=local_good
                    passages.append({'first':bar['id'],'last':bar['id'],'status':'accepted' if local_good else 'unresolved','coverage':coverage,'reason':'Local support' if local_good else 'Insufficient drum evidence in this bar'})
                    if local_good:
                        accepted=True;bar['start']+=shift;bar['beats']=[t+shift for t in bar['beats']]
        for index,bar in enumerate(bars[:-1]):
            if supported[index]:bar['end']=bars[index+1]['start']
        valid=all(bar['start']>=0 and bar['beats'][-1]<bar['end'] and (not i or bar['start']>=bars[i-1]['end']) for i,bar in enumerate(bars))
        diagnostics['passages']=passages
        if accepted and valid:
            result['beats']=[t for b in bars for t in b['beats']]
            diagnostics.update(status='accepted',reason='Supported local passages; unresolved passages retain display coordinates')
        else:
            result['bars']=copy.deepcopy(baseline['bars']);diagnostics['reason']='Competing rhythm hypotheses or sparse support'
        return result
    if abs(best[2])>=interval*.45:
        diagnostics['reason']='Half-pulse phase is ambiguous; drum hits do not identify downbeats';return result
    if len({tuple(b['meter']) for b in bars})>1 and best[3]!=1:
        diagnostics['reason']='Spacing change across meter boundary is unresolved';return result
    def mapped(time):
        if best[3]==1 and abs(best[2])<settings['no_op_seconds']:return time
        return float(beats[0]+(time-beats[0])*best[3]+best[2])
    if mapped(bars[0]['start'])<0:
        diagnostics['reason']='Correction would move pickup before the recording';return result
    duration=info['frames']/rate
    passages=[];supported=[]
    for bar in bars:
        points=np.array([mapped(t) for t in bar['beats']])
        indices=np.searchsorted(onsets,points)
        distances=np.minimum(abs(points-onsets[np.clip(indices,0,len(onsets)-1)]),abs(points-onsets[np.clip(indices-1,0,len(onsets)-1)]))
        coverage=float(np.mean(distances<settings['support_tolerance']))
        good=coverage>=settings['minimum_coverage'];supported.append(good)
        passages.append({'first':bar['id'],'last':bar['id'],'status':'accepted' if good else 'unresolved','coverage':coverage,'reason':'Local support for global hypothesis' if good else 'Insufficient drum evidence in this bar'})
    diagnostics['passages']=passages
    for index,bar in enumerate(bars):
        if supported[index]:
            bar['start']=mapped(bar['start']);bar['beats']=[mapped(t) for t in bar['beats']]
        if supported[index] and index<len(bars)-1:
            bar['end']=mapped(bars[index+1]['start']) if supported[index+1] else bars[index+1]['start']
        elif supported[index]:bar['end']=max(bar['beats'][-1]+1/rate,min(duration,bar['end']))
        if bar['beats'][-1]>=bar['end'] or bar['end']>duration+1e-6 or (index and bar['start']<bars[index-1]['end']):
            result['bars']=copy.deepcopy(baseline['bars']);diagnostics['reason']='Final partial bar correspondence is unresolved';return result
    result['beats']=[t for b in bars for t in b['beats']]
    diagnostics.update(status='accepted' if any(supported) else 'unresolved',reason='Locally supported global hypothesis; unsupported bars retain their coordinates')
    return result
