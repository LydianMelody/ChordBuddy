"""Moving a song between libraries as a zip: everything arrives linked up, IDs already taken are renamed, nothing here is lost."""
import io
import json
import math
import os
import shutil
import threading
import zipfile
from pathlib import Path
from types import SimpleNamespace
import numpy
import pytest
from chordbuddy.library import Library
from chordbuddy.documents import DocumentStore
from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.analysis_contract import digest
from chordbuddy.separation_store import SeparationStore
from chordbuddy.separation_audio import index_wav, write_float
from chordbuddy.separation_contract import file_hash
from chordbuddy.song_transfer import SongTransfer, MANIFEST

SONG = 'a1b2c3d4e5f6'


def make_app(root):
    lib = Library(root)
    store = AnalysisStore(lib)
    app = SimpleNamespace(library=lib, documents=DocumentStore(lib), job_lock=threading.Lock(), _song_busy=lambda song_id: False,
                          separation_store=SeparationStore(lib), analysis=SimpleNamespace(store=store), playback=SimpleNamespace(light={}),
                          separation=SimpleNamespace(project=Path(__file__).resolve().parent.parent))
    app.transfer = SongTransfer(app)
    return app


def add_song(app):
    """A song analyzed once, with an edited chart, an analysis stage whose files name the song and run, and a finished job."""
    lib, store = app.library, app.analysis.store
    with lib.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (SONG, 'Koi no Highway', 'LydianMelody', 'Koi no Highway.mp3', 192.0, SONG, 'imported', None, None, 'then'))
        lib._add(db, 'default', SONG)
    folder = lib.root / SONG
    folder.mkdir()
    (folder / 'source.mp3').write_bytes(b'the recording')
    run = lib.create_run(SONG)
    (run / 'chord.lab').write_text('0.0 1.0 C\n')
    with lib.transaction() as db:
        db.execute('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)', ('d' * 32, SONG, run.name, 'Song chart', 'chart', f'{SONG}\\runs\\{run.name}\\chart.json', 1, 1))
        db.execute('INSERT INTO edits VALUES(?,?,?,?)', ('d' * 32, 0, json.dumps({'chords': ['C']}), 'Model'))
        db.execute('INSERT INTO edits VALUES(?,?,?,?)', ('d' * 32, 1, json.dumps({'chords': ['G']}), 'Edit chord'))
    lib.finish_run(SONG, run.name, 'completed', None)
    stage_dir = folder / 'analysis' / ('e' * 32)
    stage_dir.mkdir(parents=True)
    (stage_dir / 'notes.json').write_text(json.dumps({'song_id': SONG, 'run_id': run.name}))
    source_hash = file_hash(folder / 'source.mp3')
    ref = store.publish(SONG, 'transcription', {'source_sha256': source_hash},
                        {'run_id': run.name, 'assets': [{'path': f'{SONG}\\analysis\\{"e" * 32}\\notes.json', 'sha256': file_hash(stage_dir / 'notes.json')}]})
    store.save_job({'id': 'f' * 32, 'kind': 'analysis', 'song_id': SONG, 'status': 'completed', 'stems': False,
                    'stages': {'transcription': {'id': ref['id'], 'status': 'completed'}, 'separation': {'status': 'skipped'}}})
    store.invalidate(SONG, 'chart')
    return run.name


def export(app, song_id=SONG, stems=False):
    manifest, files, name = app.transfer.export_plan(song_id, stems)
    out = io.BytesIO()
    app.transfer.write_zip(manifest, files, out.write)
    return out.getvalue(), name


def bring_in(app, data, mode='new', **choices):
    summary = app.transfer.receive(io.BytesIO(data).read, len(data))
    return summary, app.transfer.apply(summary['token'], mode, **choices)


def chart(app, song_id):
    song = app.library.song(song_id)
    doc = app.library.db.execute("SELECT * FROM documents WHERE song_id=? AND run_id=? AND kind='chart'", (song_id, song['active_run'])).fetchone()
    return json.loads(app.library.db.execute('SELECT content FROM edits WHERE document_id=? AND position=?', (doc['id'], doc['cursor'])).fetchone()[0])


def stages_are_valid(app, song_id):
    for row in app.library.db.execute('SELECT * FROM analysis_stages WHERE song_id=?', (song_id,)):
        manifest, ref = json.loads(row['manifest']), json.loads(row['reference'])
        assert ref['id'] == row['id'] and ref['song_id'] == song_id and digest(manifest) == ref['manifest_sha256']
        app.analysis.store.validate(song_id, {'source_sha256': ref['source_sha256']}, manifest)


@pytest.fixture
def two(tmp_path):
    here, there = make_app(tmp_path / 'here'), make_app(tmp_path / 'there')
    yield here, there
    here.library.close()
    there.library.close()


def test_the_zip_is_named_after_the_song_and_holds_the_rows_and_files(two):
    here, _ = two
    add_song(here)
    data, name = export(here)
    assert name == 'Koi no Highway.zip'
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read(MANIFEST))
    assert names[-1] == MANIFEST and 'song/source.mp3' in names and any(n.startswith('song/runs/') for n in names)
    assert manifest['song']['id'] == SONG and len(manifest['tables']['edits']) == 2 and manifest['stems'] is False


def test_another_library_gets_the_song_with_its_edits_and_history(two):
    here, there = two
    run = add_song(here)
    summary, result = bring_in(there, export(here)[0])
    assert summary['matches'] == [] and summary['analyzed'] and not summary['stems']
    assert result == {'song_id': SONG, 'changed': True, 'warning': None}
    song = there.library.song(SONG)
    assert song['title'] == 'Koi no Highway' and song['active_run'] == run and song['created'] != 'then'
    assert chart(there, SONG) == {'chords': ['G']}
    assert there.library.setlist('default')['song_ids'] == [SONG]
    assert (there.library.root / SONG / 'runs' / run / 'chord.lab').read_text() == '0.0 1.0 C\n'
    stages_are_valid(there, SONG)
    assert there.library.db.execute('SELECT before_row FROM analysis_invalidations WHERE song_id=?', (SONG,)).fetchone()[0] >= 1


def test_importing_a_song_that_is_already_here_as_new_renames_every_id(two):
    here, _ = two
    run = add_song(here)
    summary, result = bring_in(here, export(here)[0])
    assert [m['id'] for m in summary['matches']] == [SONG] and summary['matches'][0]['analyzed']
    copy = result['song_id']
    assert copy != SONG and here.library.song(copy)['active_run'] not in (None, run)
    assert chart(here, copy) == chart(here, SONG) == {'chords': ['G']}
    stages_are_valid(here, copy)
    stages_are_valid(here, SONG)
    # The rewritten file names the copy, and its checksum was updated to match.
    notes = next((here.library.root / copy / 'analysis').glob('*/notes.json'))
    assert json.loads(notes.read_text())['song_id'] == copy
    job = next(json.loads(r[0]) for r in here.library.db.execute('SELECT snapshot FROM analysis_jobs') if json.loads(r[0])['song_id'] == copy)
    assert job['id'] != 'f' * 32 and here.library.db.execute('SELECT 1 FROM analysis_stages WHERE id=?', (job['stages']['transcription']['id'],)).fetchone()


def test_overwriting_the_analysis_keeps_the_old_one_in_previous_transcriptions(two):
    here, there = two
    add_song(here)
    bring_in(there, export(here)[0])
    # Edited on the other computer, then brought back.
    with there.library.transaction() as db:
        db.execute('INSERT INTO edits VALUES(?,?,?,?)', ('d' * 32, 2, json.dumps({'chords': ['Am']}), 'Edit chord'))
        db.execute('UPDATE documents SET cursor=2,revision=2 WHERE id=?', ('d' * 32,))
    data = export(there)[0]
    before = here.library.runs(SONG)
    summary, result = bring_in(here, data, 'update', analysis=True, target=SONG)
    assert summary['matches'] == [{'id': SONG, 'title': 'Koi no Highway', 'artist': 'LydianMelody', 'created': 'then', 'analyzed': True, 'stems': False, 'same_recording': True}]
    assert result['changed'] and chart(here, SONG) == {'chords': ['Am']}
    runs = here.library.runs(SONG)
    assert len(runs) == len(before) + 1 and {r['id'] for r in before} <= {r['id'] for r in runs}
    stages_are_valid(here, SONG)


def test_keeping_everything_changes_nothing(two):
    here, _ = two
    add_song(here)
    _, result = bring_in(here, export(here)[0], 'update', analysis=False, stems=False, target=SONG)
    assert result == {'song_id': SONG, 'changed': False}
    assert len(here.library.runs(SONG)) == 1


def test_files_that_are_not_song_exports_are_refused(two, tmp_path):
    here, _ = two
    for entries in ({'notes.txt': 'hello'}, {MANIFEST: '{"format":"chordbuddy-song"}', 'song/../../evil.txt': 'x'}, {MANIFEST: '{}', 'song/source.mp3': 'x'}):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as archive:
            for name, text in entries.items():
                archive.writestr(name, text)
        with pytest.raises(ValueError):
            here.transfer.receive(io.BytesIO(out.getvalue()).read, len(out.getvalue()))
    with pytest.raises(ValueError):
        here.transfer.receive(io.BytesIO(b'not a zip').read, 9)
    assert not list((here.library.root / '.imports').glob('*'))


def test_a_round_trip_adds_only_what_changed_not_the_whole_history_again(two):
    here, there = two
    add_song(here)
    bring_in(there, export(here)[0])
    before = here.library.runs(SONG)
    _, result = bring_in(here, export(there)[0], 'update', analysis=True, target=SONG)
    assert result['changed'] and here.library.runs(SONG) == before
    assert len(list((here.library.root / SONG / 'runs').iterdir())) == len(before)
    assert chart(here, SONG) == {'chords': ['G']}
    stages_are_valid(here, SONG)


def other_copy(app, title='KOI  no highway', recording=b'the recording'):
    """The same song imported separately here: its own IDs, maybe its own recording, a title written differently."""
    with app.library.transaction() as db:
        db.execute('INSERT INTO songs(id,title,artist,filename,duration,folder,status,error,active_run,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   ('b' * 12, title, '', 'old.mp3', 100.0, 'b' * 12, 'imported', None, None, 'then'))
    (app.library.root / ('b' * 12)).mkdir()
    (app.library.root / ('b' * 12) / 'source.mp3').write_bytes(recording)
    return 'b' * 12


def test_a_song_here_with_the_same_title_is_offered_whatever_its_ids(two):
    here, there = two
    add_song(here)
    mine = other_copy(there)
    summary, result = bring_in(there, export(here)[0], 'update', analysis=True, target=mine)
    assert summary['matches'] == [{'id': mine, 'title': 'KOI  no highway', 'artist': '', 'created': 'then', 'analyzed': False, 'stems': False, 'same_recording': True}]
    assert result['song_id'] == mine and chart(there, mine) == {'chords': ['G']}
    assert there.library.db.execute('SELECT COUNT(*) FROM songs').fetchone()[0] == 1
    stages_are_valid(there, mine)
    notes = next((there.library.root / mine / 'analysis').glob('*/notes.json'))
    assert json.loads(notes.read_text())['song_id'] == mine


def test_a_different_recording_is_replaced_and_the_old_one_kept_in_the_folder(two):
    here, there = two
    add_song(here)
    mine = other_copy(there, recording=b'another take')
    summary, result = bring_in(there, export(here)[0], 'update', analysis=True, target=mine)
    assert summary['matches'][0]['same_recording'] is False
    folder = there.library.root / mine
    assert (folder / 'source.mp3').read_bytes() == b'the recording'
    assert [p.read_bytes() for p in folder.glob('source-replaced-*.mp3')] == [b'another take']
    assert there.library.song(mine)['filename'] == 'Koi no Highway.mp3'
    stages_are_valid(there, mine)


def test_import_as_new_song_leaves_the_song_with_the_same_title_alone(two):
    here, there = two
    add_song(here)
    mine = other_copy(there)
    _, result = bring_in(there, export(here)[0], 'new')
    assert result['song_id'] == SONG and there.library.song(mine)['active_run'] is None


def test_float_audio_travels_as_flac_once_and_comes_back_with_its_own_header(two):
    here, there = two
    add_song(here)
    folder = here.library.root / SONG / 'analysis' / ('c' * 32)
    folder.mkdir()
    wav, copy = folder / 'original.wav', folder / 'again.wav'
    write_float(wav, [math.sin(i / 7) * .5 for i in range(44100 * 2)] + [1.6, -1.6])   # one peak above full scale
    shutil.copyfile(wav, copy)
    (folder / 'index.json').write_text(json.dumps({'sha256': file_hash(wav)}))
    assets = [{'path': str(Path(SONG, 'analysis', 'c' * 32, name)), 'sha256': file_hash(folder / name)} for name in ('original.wav', 'index.json')]
    here.analysis.store.publish(SONG, 'source', {'source_sha256': file_hash(here.library.source_path(SONG))}, {'assets': assets})
    data, _ = export(here)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        stored = [n for n in archive.namelist() if 'c' * 32 in n]
    assert sorted(stored) == [f'song/analysis/{"c" * 32}/again.wav.flac', f'song/analysis/{"c" * 32}/index.json']   # the copy travels once
    bring_in(there, data)
    back = there.library.root / SONG / 'analysis' / ('c' * 32)
    assert index_wav(back / 'original.wav') == index_wav(wav)
    assert os.path.samefile(back / 'original.wav', back / 'again.wav')
    info = index_wav(wav)
    before = numpy.fromfile(wav, dtype='<f4', offset=info['data_offset'])
    after = numpy.fromfile(back / 'original.wav', dtype='<f4', offset=info['data_offset'])
    assert numpy.abs(before - after).max() < 1e-6 and abs(after.max() - 1.6) < 1e-6
    assert json.loads((back / 'index.json').read_text())['sha256'] == file_hash(back / 'original.wav')
    stages_are_valid(there, SONG)
