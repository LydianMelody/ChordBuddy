import copy
import pytest
from chordbuddy.music import read_music
from test_chart import prepare_chart, chart_document


def test_real_beats_and_short_measure(tmp_path):
    (tmp_path/'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n2 1 4 4\n2.5 2 4 4\n3 1 4 4\n3.5 2 4 4\n4 3 4 4\n4.5 4 4 4\n')
    (tmp_path/'downbeat.lab').write_text('0\n2\n3\n')
    music=read_music(tmp_path,5)
    assert [m['start'] for m in music['measures']]==[0,2,3]
    assert music['measures'][0]['beats']==[0,.5,1,1.5]
    assert music['measures'][1]['warning']
    assert music['measures'][0]['meter']==[4,4]


def test_missing_rhythm(tmp_path):
    assert read_music(tmp_path,10)['measures']==[]


def test_layout_history_and_validation(tmp_path,mp3_bytes):
    library,store,song,run=prepare_chart(tmp_path,mp3_bytes)
    (run/'beat.lab').write_text('0 1 4 4\n.1 2 4 4\n.2 3 4 4\n.3 4 4 4\n')
    chart=chart_document(store,song['id'])
    original=copy.deepcopy(chart['content'])
    assert 'layout' not in original
    assert chart['music']['measures'][0]['id']=='m0'
    content=copy.deepcopy(original)
    content['sections'][0]['lyrics']='Hello world'
    content['layout']={'bars_per_line':4,'breaks':[],'lines':[{'section_id':'s0','line':0,'start_measure':'m0','end_measure':'m0','words':[{'offset':0,'measure_id':'m0','beat':0}]}],'bar_overrides':[]}
    saved=store.save(chart['id'],content,'Place words',chart['revision'])
    assert saved['content']==content
    assert store.history(chart['id'],'undo',saved['revision'])['content']==original
    redone=store.history(chart['id'],'redo',saved['revision']+1)
    bad=copy.deepcopy(content); bad['layout']['lines'][0]['words'][0]['measure_id']='m999'
    with pytest.raises(ValueError): store.save(chart['id'],bad,'Invalid',redone['revision'])
    bad=copy.deepcopy(content); bad['layout']['bar_overrides']=[{'id':'m0','start':float('nan')}]
    with pytest.raises(ValueError): store.save(chart['id'],bad,'Invalid',redone['revision'])


def test_engraving_preserved_and_stale_anchors_cleared(tmp_path,mp3_bytes):
    _,store,song,run=prepare_chart(tmp_path,mp3_bytes)
    score=store.get(next(d['id'] for d in store.for_song(song['id']) if d['kind']=='abc'))
    content=copy.deepcopy(score['content'])
    content['engraving']={'bars_per_line':4,'breaks':[],'show_instrumental':False,'lyrics_text':'Hello','anchors':[{'index':0,'text':'Hel-'}]}
    saved=store.save(score['id'],content,'Place syllable',score['revision'])
    edited=store.save(score['id'],{'abc':content['abc'].replace('"C"','"Cm"')},'Chord',saved['revision'])
    assert edited['content']['engraving']==content['engraving']
    edited=store.save(score['id'],dict(edited['content'],abc=edited['content']['abc'].replace('G4','A4')),'Note',edited['revision'])
    assert edited['content']['engraving']['anchors']==[]
    assert edited['engraving_warning']


def test_events_fallback_meter_sections_and_cache_invalidation(tmp_path):
    import json
    path=tmp_path/'events.json'
    path.write_text(json.dumps({'events':[{'time':i*.5,'values':{'rhythm':dict(eighth_position=(i%3)*2,**({'meter':[6,8]} if i==0 else {})),**({'structure':'verse'} if i==0 else {})}} for i in range(6)]}))
    music=read_music(tmp_path,3)
    assert [m['start'] for m in music['measures']]==[0,1.5]
    assert music['measures'][0]['meter']==[6,8]
    assert music['measures'][0]['warning'] is None
    assert music['sections'][0]['name']=='Verse'
    path.write_text('[]')
    assert read_music(tmp_path,3)['measures']==[]


def test_pickup_is_preserved(tmp_path):
    (tmp_path/'beat.lab').write_text('0 4 4 4\n.5 1 4 4\n1 2 4 4\n')
    measures=read_music(tmp_path,1.5)['measures']
    assert measures[0]['start']==0
    assert measures[0]['end']==.5
    assert 'pickup' in measures[0]['warning']


def test_corrected_boundaries_share_all_source_beats_and_validate_final_order():
    from chordbuddy.chart import validate_layout
    music={'measures':[{'id':f'm{i}','start':i*2,'end':(i+1)*2,'beats':[i*2+j*.5 for j in range(4)]} for i in range(3)]}
    sections=[{'id':'s0','start':0,'end':6,'lyrics':'hello world'}]
    layout={'bars_per_line':4,'breaks':[],'bar_overrides':[{'id':'m1','start':1.25}], 'lines':[{'section_id':'s0','line':0,'start_measure':'m1','end_measure':'m1','words':[{'offset':0,'measure_id':'m1','beat':5}]}]}
    assert validate_layout(layout,sections,music)==layout
    layout['lines']=[]
    layout['bar_overrides']=[{'id':'m1','start':4.5},{'id':'m2','start':5}]
    assert validate_layout(layout,sections,music)==layout
    layout['bar_overrides']=[{'id':'m0','start':.1}]
    with pytest.raises(ValueError): validate_layout(layout,sections,music)
    layout['bar_overrides']=[]
    layout['lines']=[{'section_id':'s0','line':0,'start_measure':'m0','end_measure':'m0','words':[{'offset':0,'measure_id':'m0','beat':0},{'offset':6,'measure_id':'m0','beat':0}]}]
    with pytest.raises(ValueError): validate_layout(layout,sections,music)

def test_quarter_projection_preserves_half_positions_and_inferred_labels(tmp_path):
    import json
    events=[{'time':i*.25,'values':{'rhythm':{'meter':[6,8],'eighth_position':i%6}}} for i in range(12)]
    (tmp_path/'events.json').write_text(json.dumps(events))
    music=read_music(tmp_path,3)
    assert music['measures'][0]['quarter_positions']==[0,.5,1,1.5,2,2.5,3]
    assert music['measures'][0]['beats']==[0,.25,.5,.75,1,1.25]
    (tmp_path/'beat.lab').write_text('0 1 4 4\n1 3 4 4\n2 1 4 4\n')
    music=read_music(tmp_path,4)
    assert music['measures'][0]['quarter_positions']==[0,1,2,3,4]

def test_quarter_projection_unknowns_pickup_and_corrected_versions(tmp_path):
    from chordbuddy.music import project_timing
    (tmp_path/'beat.lab').write_text('0 4 4 4\n.5 1 4 4\n1 2 4 4\n')
    music=read_music(tmp_path,1.5)
    assert music['measures'][0]['quarter_positions']==[3,4]
    raw={'measures':[{'id':'m','start':0,'end':2,'beats':[0,1],'quarter_positions':[0,1,2]}]}
    before=copy.deepcopy(raw)
    unknown=project_timing(raw,{'bars':[{'id':'m','start':.1,'end':2,'beats':[.1,1.1]}]}, {})
    assert unknown['measures'][0]['quarter_positions']==[None,None,None]
    identical=project_timing(raw,{'bars':[{k:v for k,v in raw['measures'][0].items() if k!='quarter_positions'}]}, {})
    assert identical['measures'][0]['quarter_positions']==[0,1,2]
    assert raw==before

def test_partial_bar_section_validation_uses_anchor_time():
    from chordbuddy.chart import validate_layout
    music={'measures':[{'id':'m','start':0,'end':2,'beats':[0,.5,1,1.5]}]}
    sections=[{'id':'s','start':.75,'end':1.75,'lyrics':'Hello'}]
    layout={'bars_per_line':4,'breaks':[],'bar_overrides':[], 'lines':[{'section_id':'s','line':0,'start_measure':'m','end_measure':'m','words':[{'offset':0,'measure_id':'m','beat':2.5}]}]}
    assert validate_layout(layout,sections,music)==layout
    for beat in [1,3.5]:
        bad=copy.deepcopy(layout);bad['lines'][0]['words'][0]['beat']=beat
        with pytest.raises(ValueError,match='inside its section'):validate_layout(bad,sections,music)
