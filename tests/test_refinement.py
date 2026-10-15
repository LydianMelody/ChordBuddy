import json
import pytest

from chordbuddy.library import Library, now
from chordbuddy.documents import DocumentStore, apply_chord_overrides
from chordbuddy.music import read_music
from chordbuddy.timing_layout import remap_layout


def test_timing_change_preserves_manual_lyric_recording_time(tmp_path):
    (tmp_path/'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n2 1 4 4\n2.5 1 4 4\n3 2 4 4\n3.5 3 4 4\n4 4 4 4\n4.5 1 4 4\n')
    old=read_music(tmp_path,6)
    new=read_music(tmp_path,6,{'constant_tempo':True,'bpm':120})
    content={'sections':[{'id':'s0','start':0,'end':6,'lyrics':'Hello'}],
             'layout':{'bars_per_line':4,'breaks':[],'bar_overrides':[],
                       'lines':[{'section_id':'s0','line':0,'start_measure':'m2','end_measure':'m2',
                                 'words':[{'offset':0,'measure_id':'m2','beat':1.5}]}]}}
    result=remap_layout(content,old,new)
    word=result['layout']['lines'][0]['words'][0]
    assert word=={'offset':0,'measure_id':'m1','beat':2.5}  # 3.25 seconds in both grids
    assert content['layout']['lines'][0]['words'][0]['measure_id']=='m2'


def test_setting_save_changes_existing_document_without_reprocessing(tmp_path):
    library=Library(tmp_path)
    with library.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   ('song','Test','','test.mp3',4,'Test','imported',None,None,now()))
    library.folder('song').mkdir()
    store=DocumentStore(library)
    run=library.create_run('song')
    (run/'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n2 1 4 4\n2.5 1 4 4\n3 2 4 4\n3.5 3 4 4\n')
    (run/'confidence.json').write_text(json.dumps({'schema_version':1,'metric':'grammar_token_probability','beats':[{'time':.5,'score':0}]}))
    (run/'score.abc').write_text('X:1\nK:C\n"C"C4|"G"G4|')
    store.ingest('song',run,'completed',None)
    doc=next(d for d in store.for_song('song') if d['kind']=='chart')
    library.settings({'beat_remove_threshold':20})
    assert store.get(doc['id'])['music']['measures'][0]['beat_visible'][1] is False
    library.settings({'beat_remove_threshold':0})
    assert store.get(doc['id'])['music']['measures'][0]['beat_visible'][1] is True
    before=library.song_metadata('song')
    store.apply_song_metadata('song',{'chord_overrides':[],'timing':{'constant_tempo':True,'bpm':120}},before['revision'])
    assert [m['start'] for m in store.get(doc['id'])['music']['measures']]==[0,2]
    assert library.song('song')['active_run']==run.name
    with pytest.raises(ValueError):
        store.apply_song_metadata('song',before,before['revision'])
    assert library.song_metadata('song')['timing']['constant_tempo'] is True


def test_missing_beats_between_downbeats_are_implied(tmp_path):
    (tmp_path/'beat.lab').write_text('0 1 4 4\n2 1 4 4\n2.5 2 4 4\n3 3 4 4\n3.5 4 4 4\n')
    music=read_music(tmp_path,4)
    assert music['measures'][0]['beats']==[0,.5,1,1.5]
    assert music['measures'][0]['beat_inferred']==[False,True,True,True]
    assert music['measures'][0]['beat_confidence']==[None]*4
    assert music['measures'][0]['warning'] is None


def test_steady_tempo_ignores_premature_downbeat_and_spans_silence(tmp_path):
    (tmp_path/'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n2 1 4 4\n2.5 1 4 4\n3 2 4 4\n')
    original=read_music(tmp_path,8)
    assert original['measures'][1]['warning']
    music=read_music(tmp_path,8,{'constant_tempo':True})
    assert [m['start'] for m in music['measures']]==[0,2,4,6]
    assert all(len(m['beats'])==4 and m['warning'] is None for m in music['measures'])


def test_implied_beats_preserve_compound_meter_and_detected_offsets(tmp_path):
    (tmp_path/'beat.lab').write_text('0 1 6 8\n1.02 3 6 8\n1.5 1 6 8\n2 2 6 8\n2.5 3 6 8\n')
    music=read_music(tmp_path,3)
    assert music['measures'][0]['beats']==[0,.51,1.02]
    assert music['measures'][0]['meter']==[6,8]


def test_removal_does_not_turn_filtered_beats_into_inferred_beats(tmp_path):
    (tmp_path/'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n2 1 4 4\n2.5 2 4 4\n3 3 4 4\n3.5 4 4 4\n')
    (tmp_path/'confidence.json').write_text(json.dumps({'schema_version':1,'metric':'grammar_token_probability','beats':[{'time':.5,'score':0}]}))
    removed=read_music(tmp_path,4,beat_remove_threshold=20)['measures'][0]
    restored=read_music(tmp_path,4,beat_remove_threshold=0)['measures'][0]
    assert removed['beats']==restored['beats']==[0,.5,1,1.5]
    assert removed['beat_visible']==[True,False,True,True]
    assert restored['beat_visible']==[True]*4


def test_beat_tolerance_is_reversible_without_changing_anchor_indices(tmp_path):
    (tmp_path / 'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n')
    (tmp_path / 'downbeat.lab').write_text('0\n')
    (tmp_path / 'confidence.json').write_text(json.dumps({
        'schema_version': 1, 'metric': 'grammar_token_probability',
        'beats': [{'time': .5, 'score': .1}], 'chords': []
    }))
    removed = read_music(tmp_path, 2, beat_remove_threshold=20)['measures'][0]
    restored = read_music(tmp_path, 2, beat_remove_threshold=5)['measures'][0]
    assert removed['beats'] == restored['beats'] == [0, .5, 1, 1.5]
    assert removed['beat_visible'] == [True, False, True, True]
    assert restored['beat_visible'] == [True, True, True, True]


def test_confirmed_chord_is_saved_in_song_metadata_and_materialized(tmp_path):
    library = Library(tmp_path)
    with library.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   ('song', 'Test', '', 'test.mp3', 4, 'Test', 'imported', None, None, now()))
    library.folder('song').mkdir()
    library.source_path('song').write_bytes(b'audio')
    store = DocumentStore(library)
    run = library.create_run('song')
    (run / 'events.json').write_text(json.dumps({'events': [
        {'time': 0, 'values': {'chord': 'C'}},
        {'time': 2, 'values': {'chord': 'G'}},
    ]}))
    (run / 'score.abc').write_text('X:1\nK:C\n"C"C4|"G"G4|')
    (run / 'run-options.json').write_text(json.dumps({'edit_policy': 'keep', 'confidence': {}}))
    store.ingest('song', run, 'completed', None)
    detail = store.song_detail('song')
    chord = detail['chords'][0]
    store.apply_song_metadata('song', {
        'timing': {'constant_tempo': False, 'bpm': None},
        'chord_overrides': [{'id': chord['id'], 'start': chord['start'], 'end': chord['end'], 'label': 'Dm', 'confirmed': True}],
    }, detail['metadata']['revision'])
    updated = store.song_detail('song')
    assert updated['metadata']['chord_overrides'][0]['label'] == 'Dm'
    chart = next(d for d in updated['documents'] if d['kind'] == 'chart')
    chart_content = store.get(chart['id'])['content']
    assert chart_content['chords'][0]['label'] == 'Dm'
    assert chart_content['chords'][0]['confirmed'] is True


def test_one_confirmed_override_merges_an_initial_no_chord_span_without_losing_anchors():
    source = [
        {'id': 'n', 'label': 'N', 'start': 0, 'end': 1.5, 'line': None, 'offset': None},
        {'id': 'am', 'label': 'A:min', 'start': 1.5, 'end': 2, 'line': None, 'offset': None},
        {'id': 'g', 'label': 'G', 'start': 2, 'end': 4, 'line': None, 'offset': None},
    ]
    override = [{'id': 'am', 'label': 'A:min', 'start': 0, 'end': 2, 'confirmed': True}]
    corrected = apply_chord_overrides(source, override)
    assert [(chord['id'], chord['label'], chord['start'], chord['end']) for chord in corrected] == [
        ('am', 'A:min', 0, 2), ('g', 'G', 2, 4)
    ]
    assert apply_chord_overrides(corrected, override) == corrected
    anchored = [dict(source[0]), dict(source[1], line=0, offset=0), source[2]]
    assert len(apply_chord_overrides(anchored, override)) == 3


def test_start_chord_at_measure_rejects_another_harmony_and_persists_through_keep(tmp_path):
    library = Library(tmp_path)
    with library.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   ('song', 'Test', '', 'test.mp3', 4, 'Test', 'imported', None, None, now()))
    library.folder('song').mkdir()
    store = DocumentStore(library)
    run = library.create_run('song')
    (run / 'beat.lab').write_text('0 1 4 4\n.5 2 4 4\n1 3 4 4\n1.5 4 4 4\n2 1 4 4\n2.5 2 4 4\n3 3 4 4\n3.5 4 4 4\n')
    (run / 'events.json').write_text(json.dumps({'events': [
        {'time': 0, 'values': {'chord': 'N'}},
        {'time': 1.5, 'values': {'chord': 'A:min'}},
        {'time': 2, 'values': {'chord': 'G'}},
        {'time': 2.5, 'values': {'chord': 'C'}},
    ]}))
    (run / 'score.abc').write_text('X:1\nK:C\n"Am"C4|"G"G4|')
    (run / 'run-options.json').write_text(json.dumps({'edit_policy': 'keep'}))
    store.ingest('song', run, 'completed', None)
    detail = store.song_detail('song')
    store.start_chord_at_measure('song', 'c1', 'm0', detail['metadata']['revision'])
    chart = next(d for d in store.for_song('song') if d['kind'] == 'chart')
    assert [(c['id'], c['label'], c['start'], c['end']) for c in store.get(chart['id'])['content']['chords']] == [
        ('c1', 'Am', 0, 2), ('c2', 'G', 2, 2.5), ('c3', 'C', 2.5, 4)
    ]
    metadata = library.song_metadata('song')
    with pytest.raises(ValueError, match='Another chord'):
        store.start_chord_at_measure('song', 'c3', 'm1', metadata['revision'])
    next_run = library.create_run('song')
    (next_run / 'run-options.json').write_text(json.dumps({'previous_run': run.name, 'edit_policy': 'keep'}))
    (next_run / 'score.abc').write_text('X:1\nK:C\n"C"C4|')
    store.ingest('song', next_run, 'completed', None)
    assert any(d['kept'] and d['id'] == chart['id'] for d in store.for_song('song'))
