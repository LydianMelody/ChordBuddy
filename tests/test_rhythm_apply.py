import copy
import importlib.util
import pytest
from test_timing_history import fixture

def preview(doc,proposal,policy):
    assert importlib.util.find_spec('chordbuddy.rhythm_apply'),'Safe correction preview missing'
    from chordbuddy.rhythm_apply import build_rhythm_preview
    return build_rhythm_preview(doc,proposal,policy)

def proposal_for(docs,doc):
    proposal=docs.timing_version(doc)
    proposal['bars']=copy.deepcopy(proposal['bars']);proposal['bars'][0]['beats'][1]=1.1
    proposal['diagnostics']={'status':'accepted'}
    return proposal

def test_clear_is_rhythm_only(tmp_path):
    lib,docs,doc=fixture(tmp_path);doc['timing_binding']['overrides']={'constant_tempo':True,'bpm':60}
    doc['content']['sections'][0]['lyrics']='my words'
    result=preview(doc,proposal_for(docs,doc),'clear')
    assert result['has_manual_rhythm'] and not result['conflicts']
    assert result['change_details'][0]['maximum_beat_shift_seconds']==pytest.approx(.1)
    assert result['content']==doc['content']
    assert not result['binding']['overrides']
    lib.close()

def test_preserve_keeps_manual_constraints(tmp_path):
    lib,docs,doc=fixture(tmp_path);doc['timing_binding']['overrides']={'constant_tempo':True,'bpm':60}
    result=preview(doc,proposal_for(docs,doc),'preserve')
    assert result['conflicts'] and 'tempo' in result['conflicts'][0]['message'].lower()
    lib.close()

def test_nonrhythm_edits_do_not_trigger_warning(tmp_path):
    lib,docs,doc=fixture(tmp_path);doc['content']['sections'][0]['name']='New name'
    result=preview(doc,proposal_for(docs,doc),'clear')
    assert not result['has_manual_rhythm'];lib.close()

def test_conflicting_anchor_commits_nothing(tmp_path):
    lib,docs,doc=fixture(tmp_path);original=copy.deepcopy(doc)
    doc['content']['layout']={'bars_per_line':4,'breaks':['missing'],'bar_overrides':[],'lines':[]}
    result=preview(doc,proposal_for(docs,doc),'clear')
    assert result['conflicts']
    assert docs.get(doc['id'])['content']==original['content'];lib.close()
