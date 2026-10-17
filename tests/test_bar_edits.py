import pytest
from chordbuddy.library import validate_song_metadata, clean_bar_edits
from chordbuddy.music import read_music
from test_timing_history import fixture

BEATS='0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n2 1 4 4\n2.5 2 4 4\n3 3 4 4\n3.5 4 4 4\n4 1 4 4\n4.5 2 4 4\n5 3 4 4\n5.5 4 4 4\n'

def music(tmp_path,edits=None,extra=None):
    (tmp_path/'beat.lab').write_text(BEATS);(tmp_path/'downbeat.lab').write_text('0\n2\n4\n')
    timing={'bar_edits':edits} if edits else None
    return read_music(tmp_path,6,timing)

def test_without_edits_nothing_changes(tmp_path):
    m=music(tmp_path)['measures']
    assert [x['start'] for x in m]==[0,2,4] and not any(x.get('user_edited') for x in m)

def test_adding_a_barline_splits_a_bar_and_marks_it_as_shaped_by_hand(tmp_path):
    m=music(tmp_path,{'add':[1.0]})['measures']
    assert [x['start'] for x in m]==[0,1,2,4]
    assert [len(x['beats']) for x in m]==[2,2,4,4]
    assert m[0]['user_edited'] and m[1]['user_edited'] and m[0]['warning'] is None
    assert not m[2].get('user_edited') and [x['id'] for x in m]==['m0','m1','m2','m3']

def test_removing_a_barline_joins_two_bars(tmp_path):
    m=music(tmp_path,{'remove':[2.0]})['measures']
    assert [x['start'] for x in m]==[0,4] and len(m[0]['beats'])==8 and m[0]['user_edited']

def test_moving_a_barline_is_a_remove_and_an_add(tmp_path):
    m=music(tmp_path,{'remove':[2.0],'add':[3.0]})['measures']
    assert [x['start'] for x in m]==[0,3,4] and [len(x['beats']) for x in m]==[6,2,4]

def test_the_first_barline_cannot_be_removed_and_a_duplicate_add_is_ignored(tmp_path):
    assert [x['start'] for x in music(tmp_path,{'remove':[0.0]})['measures']]==[0,2,4]
    assert [x['start'] for x in music(tmp_path,{'add':[2.01]})['measures']]==[0,2,4]

def test_edits_are_validated_and_normalised():
    assert clean_bar_edits(None)=={} and clean_bar_edits({'add':[],'remove':[]})=={}
    assert clean_bar_edits({'add':[3.00001,1,1]})=={'add':[1.0,3.0]}
    for bad in ({'add':[-1]},{'add':[float('nan')]},{'add':['x']},{'swap':[1]},{'add':list(range(401))},[1]):
        with pytest.raises(ValueError):clean_bar_edits(bad)
    cleaned=validate_song_metadata({'timing':{'constant_tempo':False,'bpm':None,'bar_edits':{'remove':[2]}},'chord_overrides':[]})
    assert cleaned['timing']['bar_edits']=={'remove':[2.0]}
    assert 'bar_edits' not in validate_song_metadata({'timing':{'constant_tempo':False}})['timing']

def test_a_chart_keeps_its_words_in_time_when_a_bar_is_split_and_undo_restores_the_grid(tmp_path):
    lib,docs,before=fixture(tmp_path)
    content=before['content']
    content['sections'][0]['lyrics']='one two three four'
    content['layout']={'bars_per_line':4,'breaks':[],'bar_overrides':[],'lines':[{'section_id':content['sections'][0]['id'],'line':0,'start_measure':'m0','end_measure':'m1','words':[{'offset':8,'measure_id':'m0','beat':2}]}]}
    saved=docs.save(before['id'],content,'Add lyrics',before['revision'])
    result=docs.set_chart_timing(before['id'],{'constant_tempo':False,'bpm':None,'bar_edits':{'add':[2.0]}},saved['revision'])
    ms=result['music']['measures']
    assert [m['start'] for m in ms][:3]==[0,2,4]
    pin=result['content']['layout']['lines'][0]['words'][0]
    bar=next(m for m in ms if m['id']==pin['measure_id'])
    points=bar['beats']+[bar['end']];i=int(pin['beat'])
    assert abs(points[i]+(pin['beat']-i)*(points[i+1]-points[i])-2.0)<1e-6       # "three" is still sung at 2.0 s
    undone=docs.history(before['id'],'undo',result['revision'])
    assert [m['start'] for m in undone['music']['measures']]==[0,4]
    lib.close()
