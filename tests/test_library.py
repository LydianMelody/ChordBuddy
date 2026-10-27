import io
from pathlib import Path

import pytest
from mutagen.id3 import ID3, TIT2

from chordbuddy.library import Library


def test_metadata_title_wins_and_duplicate_imports_have_distinct_folders(tmp_path, mp3_bytes):
    audio = io.BytesIO(mp3_bytes)
    tags = ID3()
    tags.add(TIT2(encoding=3, text='Blue / Moon'))
    tags.save(audio)
    library = Library(tmp_path)
    a = library.import_audio('demo.mp3', audio.getvalue())
    b = library.import_audio('demo.mp3', audio.getvalue())
    assert a['title'] == 'Blue / Moon'
    assert a['id'] != b['id']
    assert library.source_path(a['id']) != library.source_path(b['id'])
    assert library.source_path(a['id']).read_bytes() == audio.getvalue()
    assert library.state()['setlists'][0]['song_ids'] == [a['id'], b['id']]


def test_default_title_order_and_membership_survive_reopen(tmp_path, mp3_bytes):
    library = Library(tmp_path)
    playlist = library.create_setlist('Rehearsal')
    a = library.import_audio('First.mp3', mp3_bytes, playlist['id'])
    b = library.import_audio('Second.mp3', mp3_bytes, playlist['id'])
    assert a['title'] == 'First'
    library.reorder_setlist(playlist['id'], [b['id'], a['id']])
    reopened = Library(tmp_path)
    lists = {s['name']:s['song_ids'] for s in reopened.state()['setlists']}
    assert lists == {'Default':[a['id'], b['id']], 'Rehearsal':[b['id'], a['id']]}
    with pytest.raises(ValueError):
        reopened.reorder_setlist(playlist['id'], [a['id'], a['id']])


def test_bad_audio_and_traversal_do_not_create_songs(tmp_path, mp3_bytes):
    library = Library(tmp_path)
    for name, data in [('broken.mp3', b'not audio'), ('../escape.mp3', mp3_bytes), ('C:\\escape.mp3', mp3_bytes)]:
        with pytest.raises(ValueError):
            library.import_audio(name, data)
    assert library.state()['songs'] == []


def test_failed_import_into_missing_playlist_is_atomic(tmp_path, mp3_bytes):
    library = Library(tmp_path)
    with pytest.raises(KeyError):
        library.import_audio('song.mp3', mp3_bytes, 'missing')
    assert library.state()['songs'] == []
    assert list(tmp_path.glob('*/source.mp3')) == []


def test_first_nonblank_metadata_title_is_used(tmp_path, mp3_bytes):
    audio = io.BytesIO(mp3_bytes)
    tags = ID3()
    tags.add(TIT2(encoding=3, text=['   ', 'Actual Title', 'Other Title']))
    tags.save(audio)
    song = Library(tmp_path).import_audio('fallback.mp3', audio.getvalue())
    assert song['title'] == 'Actual Title'


def test_malformed_reorder_is_a_validation_error_and_keeps_order(tmp_path, mp3_bytes):
    library = Library(tmp_path)
    song = library.import_audio('song.mp3', mp3_bytes)
    with pytest.raises(ValueError):
        library.reorder_setlist('default', [[song['id']]])
    assert library.setlist('default')['song_ids'] == [song['id']]


def test_a_song_leaves_a_set_list_but_never_the_library(tmp_path, mp3_bytes):
    library = Library(tmp_path)
    gig = library.create_setlist('Gig')
    a = library.import_audio('First.mp3', mp3_bytes, gig['id'])
    b = library.import_audio('Second.mp3', mp3_bytes, gig['id'])
    assert library.remove_from_setlist(gig['id'], a['id'])['song_ids'] == [b['id']]
    library.reorder_setlist(gig['id'], [b['id']])
    library.add_to_setlist(gig['id'], a['id'])
    assert library.setlist(gig['id'])['song_ids'] == [b['id'], a['id']]
    assert library.setlist('default')['song_ids'] == [a['id'], b['id']]
    with pytest.raises(ValueError):
        library.remove_from_setlist('default', a['id'])
    with pytest.raises(KeyError):
        library.remove_from_setlist('nope', a['id'])
