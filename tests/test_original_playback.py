"""A song analyzed without splitting its stems still plays: the recording streams in the stems' wire format."""
import array
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from chordbuddy.library import Library
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.separation_audio import write_float
from chordbuddy.separation_contract import file_hash, SAMPLE_RATE, TRACKS
from chordbuddy.playback_ready import PlaybackReadiness
from chordbuddy import original_playback
from test_analysis_jobs import coordinator

FRAMES = SAMPLE_RATE // 2


@pytest.fixture
def setup(tmp_path):
    lib = Library(tmp_path)
    with lib.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   ('s', 'Song', '', 'source.mp3', 1, 's', 'imported', None, None, 'now'))
    folder = tmp_path / 's'
    folder.mkdir()
    (folder / 'source.mp3').write_bytes(b'source')
    samples = [((i % 200) - 100) / 400 for i in range(FRAMES * 2)]
    write_float(folder / 'prepared.wav', samples)
    store = AnalysisStore(lib)
    source_hash = file_hash(folder / 'source.mp3')
    split = {'active': None}
    manifest = {'run_id': 'sep', 'song_id': 's', 'source_sha256': source_hash, 'recipe_sha256': 'recipe', 'frames': FRAMES, 'common_gain': 1}
    sep = SimpleNamespace(get_published_run=lambda ident: (folder, dict(manifest, run_id=ident)), recipe_provider=lambda: 'recipe',
                          public_manifest=lambda m: m, get_song_state=lambda sid: {'active': split['active']})
    reader = PlaybackReadiness(store, sep)

    def analyzed_without_stems(ident='ok'):
        stages = {'separation': {'status': 'skipped'}}
        for kind in ('source', 'transcription', 'chart'):
            asset = folder / (ident + '-' + kind) if kind != 'source' else folder / 'prepared.wav'
            if kind != 'source':
                asset.write_text(kind)
            ref = store.publish('s', kind, {'source_sha256': source_hash}, {'run_id': 'run', 'assets': [{'path': str(asset.relative_to(tmp_path)), 'sha256': file_hash(asset)}]})
            stages[kind] = {'id': ref['id'], 'status': 'completed'}
        job = {'id': ident, 'kind': 'analysis', 'song_id': 's', 'status': 'completed', 'stages': stages, 'stems': False}
        store.save_job(job)
        return job
    yield SimpleNamespace(lib=lib, store=store, reader=reader, analyzed=analyzed_without_stems, folder=folder, split=split, samples=samples)
    lib.close()


def test_without_stems_the_recording_is_what_plays(setup):
    setup.analyzed()
    state = setup.reader.state('s')
    assert state['ready'] and state['stems'] is False
    assert state['active']['run_id'] == original_playback.run_id('s')
    assert state['active']['frames'] == FRAMES and state['active']['stems'] is False
    assert 'stems' in state['reason'].lower()


def test_the_wire_chunk_has_the_recording_first_and_silent_stems(setup):
    setup.analyzed()
    setup.reader.state('s')
    description = setup.reader.original_run('s')
    payload, actual = original_playback.wire_chunk(description, 10, 100)
    assert actual == 100 and len(payload) == actual * 8 * len(TRACKS)
    recording = array.array('f')
    recording.frombytes(payload[:actual * 8])
    assert list(recording) == pytest.approx(setup.samples[20:220])
    assert set(payload[actual * 8:]) == {0}
    with pytest.raises(ValueError):
        original_playback.wire_chunk(description, FRAMES, 10)
    with pytest.raises(ValueError):
        original_playback.wire_chunk(description, 0, SAMPLE_RATE + 1)


def test_stems_split_afterwards_take_over_from_the_recording(setup):
    setup.analyzed()
    assert setup.reader.state('s')['active']['run_id'] == original_playback.run_id('s')
    setup.split['active'] = {'run_id': 'sep'}
    state = setup.reader.state('s')
    assert state['ready'] and state['active']['run_id'] == 'sep' and state.get('stems') is not False
    setup.split['active'] = None
    assert setup.reader.state('s')['active']['run_id'] == original_playback.run_id('s')


def test_splitting_the_stems_does_not_stop_the_recording_but_a_full_analysis_does(setup):
    setup.analyzed()
    splitting={'kind':'separation','song_id':'s','status':'separating'}
    state=setup.reader.state('s',splitting)
    assert state['ready'] and state['active']['run_id']==original_playback.run_id('s')
    assert not setup.reader.state('s',{'kind':'analysis','song_id':'s','status':'running'})['ready']


def test_a_changed_recording_is_no_longer_ready_and_cannot_be_streamed(setup):
    setup.analyzed()
    assert setup.reader.state('s')['ready']
    (setup.folder / 'source.mp3').write_bytes(b'another recording')
    assert not setup.reader.state('s')['ready']


def test_there_is_nothing_to_stream_before_the_analysis(setup):
    with pytest.raises(KeyError):
        setup.reader.original_run('s')
    assert original_playback.song_of('orig-abc') == 'abc' and original_playback.song_of('abc') is None and original_playback.song_of('orig-') is None


def test_the_analysis_can_skip_the_stems(tmp_path):
    calls = []

    def runner(kind, *args):
        calls.append(kind)
        return {'id': kind}
    lib, job = coordinator(tmp_path, runner)
    job.start('song', (), False)
    job.wait()
    assert calls == ['source', 'transcription', 'chart']
    snap = job.snapshot()
    assert snap['status'] == 'completed' and snap['stems'] is False and snap['stages']['separation'] == {'status': 'skipped'}
    lib.close()


def test_the_analysis_still_splits_stems_by_default(tmp_path):
    calls = []
    lib, job = coordinator(tmp_path, lambda kind, *a: calls.append(kind) or {'id': kind})
    job.start('song')
    job.wait()
    assert calls == ['source', 'separation', 'transcription', 'chart'] and job.snapshot()['stems'] is True
    with pytest.raises(ValueError):
        job.start('song', (), 'yes')
    lib.close()


def test_only_splitting_the_stems_needs_the_separation_models(tmp_path):
    from chordbuddy.server import Application
    from test_reprocess import seed
    app = Application(tmp_path, Path.cwd())
    seed(app.library)
    try:
        app.models.ready = lambda: False
        app.analysis.start = Mock(return_value={'ok': True})
        with pytest.raises(ValueError):
            app.analyze('song')
        assert app.analysis.start.call_count == 0
        app.analyze('song', [], False)
        app.analysis.start.assert_called_once_with('song', [], False, 'keep')
        with pytest.raises(ValueError):
            app.analyze('song', [], 'no')
    finally:
        app.close()


def test_a_song_can_be_renamed_and_given_an_artist(tmp_path):
    from test_reprocess import seed
    lib = Library(tmp_path)
    seed(lib)
    before = lib.song('song')
    changed = lib.rename_song('song', '  New title ')
    assert changed['title'] == 'New title' and changed['artist'] == before['artist']
    changed = lib.rename_song('song', 'New title', '  Some   Band ')
    assert changed['artist'] == 'Some Band'
    assert lib.rename_song('song', 'New title', '')['artist'] == ''
    with pytest.raises(ValueError):
        lib.rename_song('song', 'New title', 7)
    lib.close()


def test_the_recording_is_only_hashed_again_when_the_file_changes(tmp_path, monkeypatch):
    from chordbuddy import playback_ready
    calls = []
    monkeypatch.setattr(playback_ready, 'file_hash', lambda path: calls.append(path) or 'h%d' % len(calls))
    readiness = playback_ready.PlaybackReadiness.__new__(playback_ready.PlaybackReadiness)
    readiness._hashes = {}
    audio = tmp_path / 'song.mp3'
    audio.write_bytes(b'one')
    assert readiness._source_hash(audio) == readiness._source_hash(audio) == 'h1' and len(calls) == 1
    audio.write_bytes(b'longer now')
    assert readiness._source_hash(audio) == 'h2' and len(calls) == 2


def test_analyze_again_carries_the_choice_about_edits(tmp_path):
    lib, job = coordinator(tmp_path, lambda kind, *a: {'id': kind})
    job.start('song', ('transcription',), True, 'replace')
    job.wait()
    assert job.edit_policy == 'replace'
    job.start('song')
    job.wait()
    assert job.edit_policy == 'keep', 'keeping the edits is the default'
    with pytest.raises(ValueError):
        job.start('song', (), True, 'throw away')
    lib.close()


def test_the_visualizer_measures_the_recording_when_there_are_no_stems(setup):
    from chordbuddy import visual_features
    setup.analyzed()
    setup.reader.state('s')
    description = setup.reader.original_run('s')
    features = visual_features.load_or_compute(description['root'], description['manifest'])
    assert list(features['tracks']) == ['original'] and features['run_id'] == original_playback.run_id('s')
    assert features['frames'] == FRAMES * visual_features.FPS // SAMPLE_RATE
    assert visual_features.load_or_compute(description['root'], description['manifest']) == features   # saved beside the recording
    with pytest.raises(ValueError):
        visual_features.load_or_compute(description['root'], dict(description['manifest'], assets=[dict(description['asset'], role='vocals')]))
