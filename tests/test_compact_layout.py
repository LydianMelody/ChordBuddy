import copy,json
from pathlib import Path
import pytest
from chordbuddy.compact_layout import validate_compact_layout,reconcile_compact_layout
F=json.loads((Path(__file__).parent/'fixtures/compact-chart.json').read_text())
def value():
 return {'version':1,'groups':[{'id':'g','section_id':'s','mode':'repeat','passes':[{'start':0,'end':8,'measure_ids':['m0','m1','m2','m3'],'chord_ids':['c0','c1','c2','c3']},{'start':8,'end':20,'measure_ids':['m4','m5','m6','m7'],'chord_ids':['c4','c5','c6','c7']}]}]}
def check(v):return validate_compact_layout(v,F['content']['sections'],F['content']['chords'],F['music']['measures'])
def test_valid_does_not_mutate():
 v=value();before=copy.deepcopy(v);assert check(v)==v;assert v==before
@pytest.mark.parametrize('mutate',[lambda v:v.update(version=2),lambda v:v.update(version=True),lambda v:v['groups'][0]['passes'][0].update(start=float('nan')),lambda v:v['groups'][0]['passes'][0].update(chord_ids=['missing']),lambda v:v['groups'][0]['passes'][1].update(start=7),lambda v:v['groups'][0].update(section_id='missing'),lambda v:v['groups'].append(copy.deepcopy(v['groups'][0]))])
def test_reject_invalid(mutate):
 v=value();mutate(v)
 with pytest.raises(ValueError):check(v)
def test_ambiguous_new_grid_drops_only_preference():
 c=copy.deepcopy(F['content']);c['layout']={'compact':value(),'lines':[]};before=copy.deepcopy(c)
 result,warnings=reconcile_compact_layout(c,F['music'],{'measures':[]})
 assert result['layout']['compact']['groups']==[];assert warnings;assert result['chords']==c['chords'];assert c==before
@pytest.mark.parametrize('mutate',[lambda v:v['groups'][0].update(section_id=[]),lambda v:v['groups'][0].update(passes=[None])])
def test_malformed_references_are_validation_errors(mutate):
 v=value();mutate(v)
 with pytest.raises(ValueError):check(v)
