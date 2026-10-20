"""'Open in another editor': the lead sheet is saved as MusicXML beside the song and handed to the computer's own program for it."""
from pathlib import Path
import os
import pytest
from chordbuddy.server import Application
from test_reprocess import seed

XML = ('<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Vocal</part-name></score-part></part-list>'
       '<part id="P1"><measure number="1"><note><rest/><duration>96</duration></note></measure></part></score-partwise>')


@pytest.fixture
def app(tmp_path):
    application = Application(tmp_path, Path.cwd())
    seed(application.library)
    yield application
    application.close()


def test_the_score_is_saved_next_to_the_song_and_opened(app, monkeypatch):
    opened = []
    monkeypatch.setattr(os, 'startfile', lambda path: opened.append(path), raising=False)
    monkeypatch.setattr('chordbuddy.server.os.name', 'nt')
    result = app.open_external_score('song', 'My: song?.musicxml', XML)
    saved = Path(result['path'])
    assert saved.read_text(encoding='utf-8') == XML
    assert saved.parent == app.library.folder('song') / 'external' and saved.name == 'My song.musicxml'
    assert opened == [str(saved)] and result['opened'] and 'not read back' in result['message']


def test_a_computer_with_no_program_for_it_still_gets_the_file(app, monkeypatch):
    def refuse(path):
        raise OSError('no association')
    monkeypatch.setattr(os, 'startfile', refuse, raising=False)
    monkeypatch.setattr('chordbuddy.server.os.name', 'nt')
    result = app.open_external_score('song', 'Song', XML)
    assert Path(result['path']).name == 'Song.musicxml' and Path(result['path']).exists()
    assert result['opened'] is False and 'saved here' in result['message']


@pytest.mark.parametrize('given,expected', [('CON', '_CON.musicxml'), ('nul.musicxml', '_nul.musicxml'), ('com1', '_com1.musicxml'), ('Song. . ', 'Song.musicxml'), ('...', 'Lead sheet.musicxml'), ('console', 'console.musicxml')])
def test_names_windows_would_treat_as_devices_or_trim_are_made_safe(app, monkeypatch, given, expected):
    monkeypatch.setattr(os, 'startfile', lambda path: None, raising=False)
    monkeypatch.setattr('chordbuddy.server.os.name', 'nt')
    assert Path(app.open_external_score('song', given, XML)['path']).name == expected


@pytest.mark.parametrize('bad', [None, '', '   ', '<not xml', '<other-root/>', '<!DOCTYPE x [<!ENTITY a "b">]><score-partwise/>'])
def test_anything_that_is_not_a_score_is_refused(app, bad):
    with pytest.raises(ValueError):
        app.open_external_score('song', 'x', bad)
    assert not (app.library.folder('song') / 'external').exists() or not list((app.library.folder('song') / 'external').iterdir())


def test_an_unknown_song_is_refused(app):
    with pytest.raises(Exception):
        app.open_external_score('nope', 'x', XML)


def test_lead_sheet_engraving_accepts_automatic_lines():
    from chordbuddy.documents import validate_engraving
    base = {'bars_per_line': 0, 'show_instrumental': False, 'breaks': [], 'lyrics_text': '', 'anchors': []}
    assert validate_engraving(dict(base))['bars_per_line'] == 0
    with pytest.raises(ValueError):
        validate_engraving(dict(base, bars_per_line=5))


def test_lead_sheet_music_size_is_one_of_three():
    from chordbuddy.documents import validate_engraving
    base = {'bars_per_line': 0, 'show_instrumental': False, 'breaks': [], 'lyrics_text': '', 'anchors': []}
    for size in ('large', 'medium', 'small'):
        assert validate_engraving(dict(base, music_size=size))['music_size'] == size
    assert 'music_size' not in validate_engraving(dict(base))
    with pytest.raises(ValueError):
        validate_engraving(dict(base, music_size='huge'))
