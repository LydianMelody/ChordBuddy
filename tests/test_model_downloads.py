import hashlib
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import pytest
from chordbuddy import model_downloads as md
from chordbuddy.separation_recipe import MODELS, model_root, separation_home

BIG = bytes(range(256)) * 4096            # 1 MiB
SMALL = b'model configuration\n'
sha = lambda data: hashlib.sha256(data).hexdigest()


class Server:
    """A tiny file server that can misbehave: missing files, wrong bytes, ignored Range headers, redirects, slow bodies."""
    def __init__(self):
        self.files = {}              # path -> bytes
        self.ignore_range = False
        self.redirects = {}          # path -> absolute url
        self.slow = False
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                outer.requests.append((self.path, self.headers.get('Range')))
                if self.path in outer.redirects:
                    self.send_response(302)
                    self.send_header('Location', outer.redirects[self.path])
                    self.end_headers()
                    return
                data = outer.files.get(self.path)
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                start = 0
                rng = self.headers.get('Range')
                if rng and not outer.ignore_range:
                    start = int(re.match(r'bytes=(\d+)-', rng).group(1))
                    self.send_response(206)
                else:
                    self.send_response(200)
                body = data[start:]
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                for i in range(0, len(body), 65536):
                    if outer.slow:
                        time.sleep(0.05)
                    try:
                        self.wfile.write(body[i:i + 65536])
                    except OSError:
                        return

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.httpd.server_port}'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def server():
    s = Server()
    yield s
    s.close()


def registry(server, sources_for_big=('/a', '/b')):
    def entry(title):
        return {'title': title, 'role': 'test', 'license': 'test', 'files': [
            {'path': 'weights/big.ckpt', 'size': len(BIG), 'sha256': sha(BIG), 'sources': [server.url + s for s in sources_for_big]},
            {'path': 'evidence/config.yaml', 'size': len(SMALL), 'sha256': sha(SMALL), 'sources': [server.url + '/config']},
            {'path': 'evidence/upstream-commit.txt', 'text': 'abc123'},
        ]}
    return {stage: entry(stage) for stage in MODELS}


def manager(tmp_path, server, **kw):
    home = separation_home(tmp_path)     # the engine's own interpreter and libraries are part of the install, not of the download
    (home / 'runtime').mkdir(parents=True)
    (home / 'runtime/python.exe').write_bytes(b'')
    (home / 'packages').mkdir()
    return md.ModelManager(tmp_path, registry=kw.pop('reg', None) or registry(server), hosts=('127.0.0.1',), secure=False, **kw)


def test_everything_is_downloaded_verified_and_then_left_alone(tmp_path, server):
    server.files.update({'/a': BIG, '/config': SMALL})
    m = manager(tmp_path, server)
    assert m.status()['ready'] is False and m.status()['bytes_missing'] == 2 * (len(BIG) + len(SMALL))
    m.start(); m.wait()
    status = m.status()
    assert status['ready'] and status['bytes_missing'] == 0 and not status['active']
    assert (model_root(tmp_path, 'base') / 'weights/big.ckpt').read_bytes() == BIG
    assert (model_root(tmp_path, 'guitar') / 'evidence/upstream-commit.txt').read_text().strip() == 'abc123'
    server.requests.clear()
    m.start(); m.wait()
    assert server.requests == []                                              # nothing to fetch the second time


def test_a_bad_or_missing_copy_falls_through_to_the_next_location(tmp_path, server):
    server.files.update({'/b': BIG[:-1] + b'X', '/c': BIG, '/config': SMALL})      # /a is a 404, /b has the right size but wrong bytes
    m = manager(tmp_path, server, reg=registry(server, ('/a', '/b', '/c')))
    m.start(); m.wait()
    assert m.status()['ready']
    assert (model_root(tmp_path, 'base') / 'weights/big.ckpt').read_bytes() == BIG
    assert not list(model_root(tmp_path, 'base').rglob('*.partial'))               # nothing half-written is left behind


def test_when_every_location_fails_the_reason_for_each_is_reported(tmp_path, server):
    server.files.update({'/b': b'wrong', '/config': SMALL})
    m = manager(tmp_path, server)
    m.start(); m.wait()
    status = m.status()
    assert not status['ready']
    error = next(x for x in status['models'] if x['id'] == 'base')['error']
    assert 'big.ckpt' in error and 'HTTP 404' in error and 'Incomplete download' in error
    assert not (model_root(tmp_path, 'base') / 'weights/big.ckpt').exists()


def test_an_interrupted_download_resumes_and_a_server_that_ignores_resume_restarts(tmp_path, server):
    server.files.update({'/a': BIG, '/config': SMALL})
    m = manager(tmp_path, server)
    partial = model_root(tmp_path, 'base') / 'weights/big.ckpt.partial'
    partial.parent.mkdir(parents=True, exist_ok=True)
    partial.write_bytes(BIG[:300000])
    m.start(); m.wait()
    assert m.status()['ready'] and ('/a', 'bytes=300000-') in server.requests
    for stage in MODELS:
        (model_root(tmp_path, stage) / 'weights/big.ckpt').unlink()
    server.ignore_range = True
    partial.write_bytes(BIG[:300000])
    m.start(); m.wait()
    assert m.status()['ready'] and (model_root(tmp_path, 'base') / 'weights/big.ckpt').read_bytes() == BIG


def test_a_redirect_to_an_unlisted_host_is_refused(tmp_path, server):
    server.redirects['/a'] = 'http://example.invalid/steal.ckpt'
    server.files.update({'/b': BIG, '/config': SMALL})
    m = manager(tmp_path, server)
    m.start(); m.wait()
    assert m.status()['ready']                                                    # /b worked after /a was refused
    assert md.host_allowed('https://huggingface.co/x') and md.host_allowed('https://cdn-lfs.hf.co/x')
    assert not md.host_allowed('http://huggingface.co/x') and not md.host_allowed('https://evilhuggingface.co/x')
    assert not md.host_allowed('https://huggingface.co.evil.example/x')


def test_stopping_keeps_the_partial_file_and_is_not_an_error(tmp_path, server):
    server.files.update({'/a': BIG * 4, '/config': SMALL})
    reg = registry(server)
    for entry in reg.values():
        entry['files'][0].update(size=len(BIG) * 4, sha256=sha(BIG * 4))
    server.slow = True
    m = manager(tmp_path, server, reg=reg)
    m.start()
    for _ in range(100):
        if m.status()['models'][0]['progress'] and m.status()['models'][0]['progress']['done'] > 0:
            break
        time.sleep(0.05)
    m.cancel(); m.wait()
    status = m.status()
    assert not status['ready'] and not status['active'] and all(x['error'] is None for x in status['models'])
    assert (model_root(tmp_path, 'base') / 'weights/big.ckpt.partial').exists()


def test_a_file_the_user_already_has_is_installed_only_if_it_is_exactly_right(tmp_path, server):
    m = manager(tmp_path, server)
    wrong = tmp_path / 'other.bin'
    wrong.write_bytes(b'x' * len(BIG))
    with pytest.raises(ValueError, match='not one of the models'):
        m.adopt('other.bin', wrong)
    right = tmp_path / 'mine.ckpt'
    right.write_bytes(BIG)
    first = m.adopt('mine.ckpt', right)
    assert first['path'] == 'weights/big.ckpt' and (model_root(tmp_path, first['model']) / first['path']).read_bytes() == BIG
    second = m.adopt('mine.ckpt', right)                                          # the other model's identical test file
    assert second['model'] != first['model']
    with pytest.raises(ValueError):
        m.adopt('mine.ckpt', right)                                               # nothing left that it could be


def test_the_engine_files_are_reported_when_missing(tmp_path, server):
    m = md.ModelManager(tmp_path, registry=registry(server), hosts=('127.0.0.1',), secure=False)
    assert all(not x['environment'] for x in m.status()['models'])


def test_the_real_list_is_well_formed_and_matches_the_files_the_app_was_tested_with():
    for stage, entry in md.REGISTRY.items():
        assert entry['license'] and entry['title']
        for spec in entry['files']:
            if 'text' in spec:
                continue
            assert re.fullmatch(r'[0-9a-f]{64}', spec['sha256']) and spec['size'] > 0
            assert 1 <= len(spec['sources']) <= 5, spec['path']
            assert all(md.host_allowed(url) for url in spec['sources'])
            assert len(set(spec['sources'])) == len(spec['sources'])
    project = Path(__file__).resolve().parent.parent
    for stage, entry in md.REGISTRY.items():          # on a machine that has the models, the list must describe them exactly
        for spec in entry['files']:
            path = model_root(project, stage) / spec['path']
            if path.is_file() and 'text' not in spec and spec['size'] < 10 ** 6:
                assert md.file_sha256(path) == spec['sha256'], path


def test_a_server_that_refuses_to_resume_gets_a_fresh_start(tmp_path, server, monkeypatch):
    server.files.update({'/a': BIG, '/config': SMALL})
    original = server.httpd.RequestHandlerClass.do_GET
    def refusing(self):
        if self.headers.get('Range'):
            self.send_response(503)
            self.end_headers()
            return
        original(self)
    monkeypatch.setattr(server.httpd.RequestHandlerClass, 'do_GET', refusing)
    m = manager(tmp_path, server)
    partial = model_root(tmp_path, 'base') / 'weights/big.ckpt.partial'
    partial.parent.mkdir(parents=True, exist_ok=True)
    partial.write_bytes(BIG[:1000])
    m.start(); m.wait()
    assert m.status()['ready'] and (model_root(tmp_path, 'base') / 'weights/big.ckpt').read_bytes() == BIG
