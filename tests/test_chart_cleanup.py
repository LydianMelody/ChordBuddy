import copy
import importlib.util
import pytest

def data():
    chart={'version':1,'duration':379.248,'sections':[{'id':'s9','name':'Outro','start':325.5350833333333,'end':379.20508333333333,'lyrics':'Keep words'},
        {'id':'s10','name':'Instrumental','start':379.20508333333333,'end':379.248,'lyrics':''}],'chords':[{'id':'c132','label':'Cm','start':355.74508333333335,'end':379.248,'section_id':'s9','line':None,'offset':None}]}
    evidence={'source_sha256':'same','canonical_source_sha256':'same','canonical_frames':16722945,'canonical_rate':44100,'model_rate':24000,'generated_gap_id':'s10','structure_end':379.20508333333333}
    return chart,evidence

def patch_for(chart,baseline,evidence):
    assert importlib.util.find_spec('chordbuddy.chart_cleanup'),'Provenance-bound EOF cleanup missing'
    from chordbuddy.chart_cleanup import terminal_artifact_patch
    return terminal_artifact_patch(chart,baseline,evidence)

def test_enjoy_the_silence_tail():
    chart,evidence=data();baseline=copy.deepcopy(chart)
    patch=patch_for(chart,baseline,evidence)
    assert patch['content']['sections']==[dict(chart['sections'][0],end=379.248)]
    assert patch['content']['chords']==chart['chords'] and chart==baseline
    assert patch_for(patch['content'],baseline,evidence) is None

@pytest.mark.parametrize('change',['name','lyrics','bounds','chord','source','provenance','interior','cap'])
def test_preserve_real_or_modified_tail(change):
    chart,evidence=data();baseline=copy.deepcopy(chart)
    if change=='name':chart['sections'][-1]['name']='Intentional'
    if change=='lyrics':chart['sections'][-1]['lyrics']='hello'
    if change=='bounds':chart['sections'][-1]['start']-=.01
    if change=='chord':chart['chords']=[{'section_id':'s10','start':379.22,'end':379.23,'label':'C'}]
    if change=='source':evidence['source_sha256']='different'
    if change=='provenance':evidence.pop('generated_gap_id')
    if change=='interior':chart['sections'].append(dict(chart['sections'][-1],id='s11'))
    if change=='cap':chart['sections'][-1]['end']+=.1
    assert patch_for(chart,baseline,evidence) is None
