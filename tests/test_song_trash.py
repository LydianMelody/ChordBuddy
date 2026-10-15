import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from chordbuddy.analysis_store import AnalysisStore
from chordbuddy.library import Library
from chordbuddy.separation_store import SeparationStore
from chordbuddy.server import make_server
from chordbuddy.timing_store import TimingStore


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path)
    AnalysisStore(lib)
    SeparationStore(lib)
    TimingStore(lib)
    yield lib
    lib.close()


def add_history(lib, song_id, tag):
    """One row in every table that can mention a song, so a purge has to clean them all."""
    with lib.transaction() as db:
        db.execute("INSERT INTO runs(id,song_id,created,status) VALUES(?,?,?,?)", (f'run-{tag}', song_id, 'now', 'completed'))
        db.execute("INSERT INTO documents(id,song_id,run_id,name,kind,original_path) VALUES(?,?,?,?,?,?)", (f'doc-{tag}', song_id, f'run-{tag}', 'Song chart', 'chart', 'x'))
        db.execute("INSERT INTO edits VALUES(?,?,?,?)", (f'doc-{tag}', 0, '{}', 'Edit'))
        db.execute("INSERT INTO retained_documents VALUES(?,?)", (f'run-{tag}', f'doc-{tag}'))
        db.execute("INSERT INTO timing_bindings VALUES(?,?,?)", (f'doc-{tag}', 0, '{}'))
        db.execute("INSERT INTO analysis_stages VALUES(?,?,?,?,?,?)", (f'stage-{tag}', song_id, 'source', '{}', '{}', '{}'))
        db.execute("INSERT INTO analysis_jobs VALUES(?,?)", (f'job-{tag}', json.dumps({'song_id': song_id})))
        db.execute("INSERT INTO analysis_invalidations VALUES(?,?,?)", (song_id, 'chart', 1))
        db.execute("INSERT INTO separation_runs VALUES(?,?,?,?,?,?,?,?,?,?)", (f'sep-{tag}', song_id, 'completed', 'done', None, None, 'r', 's', 'x', 'now'))
        db.execute("INSERT INTO song_separations VALUES(?,?)", (song_id, f'sep-{tag}'))


def counts(lib, song_id):
    tables = {
        'runs': 'song_id', 'documents': 'song_id', 'analysis_stages': 'song_id', 'analysis_invalidations': 'song_id',
        'separation_runs': 'song_id', 'song_separations': 'song_id', 'song_metadata': 'song_id', 'memberships': 'song_id', 'songs': 'id',
    }
    result = {name: lib.db.execute(f'SELECT COUNT(*) FROM {name} WHERE {column}=?', (song_id,)).fetchone()[0] for name, column in tables.items()}
    result['edits'] = lib.db.execute('SELECT COUNT(*) FROM edits WHERE document_id IN (SELECT id FROM documents WHERE song_id=?)', (song_id,)).fetchone()[0]
    result['jobs'] = lib.db.execute("SELECT COUNT(*) FROM analysis_jobs WHERE json_extract(snapshot,'$.song_id')=?", (song_id,)).fetchone()[0]
    return result


def two_songs(lib, mp3_bytes):
    first = lib.import_audio('one.mp3', mp3_bytes)
    second = lib.import_audio('two.mp3', mp3_bytes)
    return first, second


def test_a_trashed_song_disappears_from_the_library_and_every_set_list_but_nothing_is_deleted(library, mp3_bytes):
    first, second = two_songs(library, mp3_bytes)
    library.create_setlist('Gig')
    gig = next(s['id'] for s in library.state()['setlists'] if s['name'] == 'Gig')
    library.add_to_setlist(gig, first['id'])
    library.add_to_setlist(gig, second['id'])
    folder = library.folder(first['id'])
    library.trash_song(first['id'])
    state = library.state()
    assert [s['id'] for s in state['songs']] == [second['id']]
    assert all(first['id'] not in s['song_ids'] for s in state['setlists'])
    assert [t['id'] for t in state['trash']] == [first['id']]
    assert (folder / 'source.mp3').is_file()                 # the recording is still there


def test_trashing_twice_is_harmless_and_unknown_songs_are_reported(library, mp3_bytes):
    first, _ = two_songs(library, mp3_bytes)
    library.trash_song(first['id'])
    stamp = library.song(first['id'])['deleted']
    library.trash_song(first['id'])
    assert library.song(first['id'])['deleted'] == stamp
    with pytest.raises(KeyError):
        library.trash_song('nope')
    with pytest.raises(KeyError):
        library.restore_song('nope')


def test_restoring_puts_the_song_back_in_its_place_in_every_set_list(library, mp3_bytes):
    first, second = two_songs(library, mp3_bytes)
    third = library.import_audio('three.mp3', mp3_bytes)
    default = lambda: library.state()['setlists'][0]['song_ids']
    assert default() == [first['id'], second['id'], third['id']]
    library.trash_song(second['id'])
    assert default() == [first['id'], third['id']]
    library.restore_song(second['id'])
    assert default() == [first['id'], second['id'], third['id']]
    assert library.state()['trash'] == []


def test_deleting_forever_requires_the_trash_first(library, mp3_bytes):
    first, _ = two_songs(library, mp3_bytes)
    with pytest.raises(ValueError, match='Trash'):
        library.purge_song(first['id'])
    assert library.song(first['id'])['deleted'] is None


def test_deleting_forever_removes_every_trace_of_that_song_and_only_that_song(library, mp3_bytes):
    first, second = two_songs(library, mp3_bytes)
    add_history(library, first['id'], 'a')
    add_history(library, second['id'], 'b')
    keep = counts(library, second['id'])
    folder, other_folder = library.folder(first['id']), library.folder(second['id'])
    assert all(v >= 1 for k, v in counts(library, first['id']).items() if k not in ('song_metadata', 'memberships'))
    library.trash_song(first['id'])
    result = library.purge_song(first['id'])
    assert result['purged'] is True and result['warning'] is None
    assert all(v == 0 for v in counts(library, first['id']).values()), counts(library, first['id'])
    assert not folder.exists()
    assert counts(library, second['id']) == keep           # the other song is untouched
    assert other_folder.is_dir() and (other_folder / 'source.mp3').is_file()
    assert [s['id'] for s in library.state()['songs']] == [second['id']] and library.state()['trash'] == []


def test_deleting_forever_survives_reopening_the_library(tmp_path, mp3_bytes):
    lib = Library(tmp_path)
    song = lib.import_audio('one.mp3', mp3_bytes)
    lib.trash_song(song['id'])
    lib.purge_song(song['id'])
    lib.close()
    again = Library(tmp_path)
    assert again.state()['songs'] == [] and again.state()['trash'] == []
    again.close()


def test_an_existing_library_gains_the_trash_column_without_losing_songs(tmp_path, mp3_bytes):
    lib = Library(tmp_path)
    song = lib.import_audio('old.mp3', mp3_bytes)
    with lib.transaction() as db:
        db.execute('ALTER TABLE songs DROP COLUMN deleted')    # a library created before the Trash existed
    lib.close()
    reopened = Library(tmp_path)
    assert [s['id'] for s in reopened.state()['songs']] == [song['id']]
    reopened.trash_song(song['id'])
    assert reopened.state()['songs'] == []
    reopened.close()


# ---------------- through the API ----------------
@pytest.fixture
def service(tmp_path):
    server = make_server(tmp_path, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join()


def post(server, path, body):
    request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}{path}', data=json.dumps(body).encode(),
                                     headers={'X-ChordBuddy-Token': server.app.token, 'Content-Type': 'application/json'}, method='POST')
    return json.load(urllib.request.urlopen(request))


def get(server, path):
    request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}{path}', headers={'X-ChordBuddy-Token': server.app.token})
    return json.load(urllib.request.urlopen(request))


def test_api_trash_restore_and_purge_round_trip(service, mp3_bytes):
    song = service.app.library.import_audio('api.mp3', mp3_bytes)
    assert post(service, '/api/song/trash', {'id': song['id']})['deleted']
    state = get(service, '/api/state')
    assert state['songs'] == [] and [t['id'] for t in state['trash']] == [song['id']]
    post(service, '/api/song/restore', {'id': song['id']})
    assert [s['id'] for s in get(service, '/api/state')['songs']] == [song['id']]
    with pytest.raises(urllib.error.HTTPError) as error:
        post(service, '/api/song/purge', {'id': song['id']})          # not trashed yet
    assert error.value.code == 400
    post(service, '/api/song/trash', {'id': song['id']})
    assert post(service, '/api/song/purge', {'id': song['id']})['purged'] is True
    assert get(service, '/api/state')['trash'] == []


def test_api_refuses_to_delete_a_song_that_is_being_analyzed(service, mp3_bytes, monkeypatch):
    song = service.app.library.import_audio('busy.mp3', mp3_bytes)
    monkeypatch.setattr(service.app.analysis, 'snapshot', lambda: {'song_id': song['id'], 'status': 'running'})
    for path in ('/api/song/trash',):
        with pytest.raises(urllib.error.HTTPError) as error:
            post(service, path, {'id': song['id']})
        assert error.value.code == 409
    assert service.app.library.song(song['id'])['deleted'] is None
    service.app.library.trash_song(song['id'])
    with pytest.raises(urllib.error.HTTPError) as error:
        post(service, '/api/song/purge', {'id': song['id']})
    assert error.value.code == 409
    assert Path(service.app.library.folder(song['id'])).exists()


def test_api_needs_the_token_to_delete(service, mp3_bytes):
    song = service.app.library.import_audio('t.mp3', mp3_bytes)
    request = urllib.request.Request(f'http://127.0.0.1:{service.server_port}/api/song/trash', data=json.dumps({'id': song['id']}).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request)
    assert error.value.code in (401, 403)
    assert service.app.library.song(song['id'])['deleted'] is None
