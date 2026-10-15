import importlib.util
import copy
import pytest
from rhythm_fixtures import drum_fixture

def analyze(tmp_path,**kwargs):
    assert importlib.util.find_spec('chordbuddy.rhythm'),'Drum evidence detector missing'
    from chordbuddy.rhythm import analyze_drum_rhythm
    path=tmp_path/'drums.wav';baseline,truth=drum_fixture(path,**kwargs)
    result=analyze_drum_rhythm(path,baseline,{'source_sha256':'source','transcription_id':'run','drums_ref':'drums'}, {},lambda:None,lambda x:None)
    return result,baseline,truth

def test_coherent_disagreement_can_win(tmp_path):
    result,baseline,truth=analyze(tmp_path)
    assert result['diagnostics']['status']=='accepted'
    assert abs(result['bars'][0]['start']-truth[0])<.02
    assert result['bars'][0]['meter']==[4,4]

@pytest.mark.parametrize('kwargs',[{'silent':True},{'offset':0,'offbeat':True}])
def test_ambiguous_evidence_abstains(tmp_path,kwargs):
    result,baseline,_=analyze(tmp_path,**kwargs)
    assert result['diagnostics']['status']=='unresolved'
    assert result['bars']==baseline['bars']

def test_deterministic_and_cancel(tmp_path):
    result,_,_=analyze(tmp_path)
    again,_,_=analyze(tmp_path)
    assert result==again
    from chordbuddy.rhythm import analyze_drum_rhythm
    def cancel():raise RuntimeError('cancelled')
    with pytest.raises(RuntimeError,match='cancelled'):analyze_drum_rhythm(tmp_path/'drums.wav',{}, {},{},cancel,lambda x:None)

@pytest.mark.parametrize('variant',['sparse','subdivision','tempo_change','meter_change','pickup','flams','bleed'])
def test_representative_rhythm_conditions(tmp_path,variant):
    import numpy as np
    from chordbuddy.rhythm import analyze_drum_rhythm
    from chordbuddy.separation_audio import write_float
    path=tmp_path/'representative.wav';baseline,truth=drum_fixture(path)
    audio=np.zeros((12*44100,2),dtype=np.float32)
    times=truth.copy()
    if variant=='sparse':times=truth[::4]
    if variant=='subdivision':times=np.sort(np.concatenate((truth,truth+.25)))
    if variant=='tempo_change':times=truth+np.sin(np.arange(len(truth))*.6)*.14
    if variant=='meter_change':
        for bar in baseline['bars'][2:]:bar['meter']=[6,8]
    if variant=='pickup':
        baseline['bars'][0]['warning']='Partial pickup before first downbeat'
    for i,t in enumerate(times):
        start=round(t*44100);n=440
        audio[start:start+n]+=np.random.default_rng(i+70).normal(0,.2,(n,1))*np.exp(-np.arange(n)[:,None]/80)
        if variant=='flams':audio[start+441:start+441+n]+=.15*audio[start:start+n]
    if variant=='bleed':audio+=.01*np.sin(np.arange(len(audio))[:,None]*2*np.pi*220/44100)
    write_float(path,audio.ravel())
    result=analyze_drum_rhythm(path,baseline,{'source_sha256':'source','transcription_id':'run','drums_ref':'drums'}, {},lambda:None,lambda x:None)
    if variant in ('sparse','subdivision','tempo_change'):assert result['diagnostics']['status']=='unresolved'
    if result['diagnostics']['status']=='accepted':assert abs(result['bars'][0]['start']-truth[0])<.025
    assert [b['meter'] for b in result['bars']]==[b['meter'] for b in baseline['bars']]

def test_cancellation_during_chunked_analysis(tmp_path):
    from chordbuddy.rhythm import analyze_drum_rhythm
    path=tmp_path/'drums.wav';baseline,_=drum_fixture(path);calls=[]
    def cancel():
        calls.append(1)
        if len(calls)==4:raise RuntimeError('cancelled during evidence')
    with pytest.raises(RuntimeError,match='during evidence'):analyze_drum_rhythm(path,baseline,{}, {},cancel,lambda x:None)

def test_local_passages_can_correct_different_offsets(tmp_path):
    import numpy as np
    from chordbuddy.rhythm import analyze_drum_rhythm
    path=tmp_path/'local.wav';base,truth=drum_fixture(path)
    # Duplicate a longer pulse track, with one grid region late and another early.
    from chordbuddy.separation_audio import write_float
    audio=np.zeros((22*44100,2),dtype=np.float32)
    for i,t in enumerate(np.arange(.5,21,.5)):
        start=round(t*44100);audio[start:start+440]=np.random.default_rng(i).normal(0,.2,(440,1))*np.exp(-np.arange(440)[:,None]/80)
    write_float(path,audio.ravel());bars=[]
    for i in range(10):
        offset=.08 if i<5 else -.08;points=[.5+i*2+j*.5+offset for j in range(4)]
        bars.append(dict(base['bars'][0],id=f'm{i}',start=points[0],end=.5+(i+1)*2+offset,beats=points))
    for i in range(9):bars[i]['end']=bars[i+1]['start']
    base['bars']=bars
    result=analyze_drum_rhythm(path,base,{}, {},lambda:None,lambda x:None)
    assert result['diagnostics']['status']=='accepted'
    assert abs(result['bars'][0]['start']-.5)<.025
    assert abs(result['bars'][6]['start']-12.5)<.025
