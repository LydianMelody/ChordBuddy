"""First-run download of the stem separation models.

Chord Buddy does not ship these files. Each one is listed here with the exact fingerprint (SHA-256) and size it must have and up
to five public places to fetch it from. A download is only accepted when the fingerprint matches, so which copy it came from
does not matter. The files go into the same folders the separation code already reads, so nothing else changes.
"""
from __future__ import annotations
import hashlib
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .separation_recipe import MODELS, model_root, separation_home

# Hosts a download (and every redirect on the way) may touch.
ALLOWED_HOSTS = ('huggingface.co', 'hf.co', 'githubusercontent.com', 'github.com', 'cdn.jsdelivr.net')
CHUNK = 1 << 20
SLACK = 256 * 1024 ** 2          # free space to keep after a download

COMMIT = '84b1eac0887756b4f1a9d7a1ff49105939749ed2'
_GH = 'ZFTurbo/Music-Source-Separation-Training'
_SOURCE_FILES = [
    ('models/bs_roformer/__init__.py', 'fc236d3158ba954e77ec7f7d4cae8eec924bebc3150db4885ab946d693f1e862', 242),
    ('models/bs_roformer/bs_roformer.py', 'a6f670325cdb8a7a212914f62602119b23eb888df9bcfe4a85f9be74728b3ef4', 20494),
    ('models/bs_roformer/mel_band_roformer.py', '3b4a57ab268933900172e05fb76dd9e8acc1eb770c745d583a4e42b94b79ec15', 22532),
    ('models/bs_roformer/attend.py', 'c7abbc40a3fd20ff7f6001fa9f8ee9ad5df6452272712a5e719b8f8468bf2223', 4410),
    ('LICENSE', '3282dc057695ef5b9a64909a7092ca40b2c292c232580fc6ace6e5d665cc0207', 1081),
]


def _source_files():
    """The MIT-licensed model code, pinned to one commit and fetched from GitHub or its CDN mirror."""
    return [{'path': 'source/' + path, 'sha256': sha, 'size': size,
             'sources': [f'https://raw.githubusercontent.com/{_GH}/{COMMIT}/{path}', f'https://cdn.jsdelivr.net/gh/{_GH}@{COMMIT}/{path}']}
            for path, sha, size in _SOURCE_FILES]


def _hf(repo, path):
    return f'https://huggingface.co/{repo}/resolve/main/{path}'


REGISTRY = {
    'base': {
        'title': 'BS-RoFormer SW (six stems)',
        'role': 'Splits a song into bass, drums, vocals, guitar, piano and the rest.',
        'license': 'Trained by "jarredou". The original upload is gone and no license text came with the copies, so the terms are unconfirmed. '
                   'Several mirrors tag it MIT or non-commercial; none is authoritative. The model code is MIT.',
        'files': [
            {'path': 'weights/BS-Rofo-SW-Fixed.ckpt', 'size': 699412152,
             'sha256': '24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e',
             'sources': [_hf('enerjazzer/BS-ROFO-SW-Fixed', 'BS-Rofo-SW-Fixed.ckpt'),
                         _hf('FractalSurfer/BS-RoFormer-SW-6stem', 'BS-Rofo-SW-Fixed.ckpt'),
                         _hf('noblebarkrr/mvsepless_resources', 'bs_roformer/bs_6stem_fixed.ckpt'),
                         _hf('Politrees/UVR_resources', 'models/Roformer/BandSplit/model_BandSplit-Roformer_SW_by-jarredou.ckpt'),
                         _hf('lainlives/audio-separator-models', 'BS-Roformer-SW.ckpt')]},
            {'path': 'evidence/BS-Rofo-SW-Fixed.yaml', 'size': 4613,
             'sha256': 'f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b',
             'sources': [_hf('enerjazzer/BS-ROFO-SW-Fixed', 'BS-Rofo-SW-Fixed.yaml'),
                         _hf('FractalSurfer/BS-RoFormer-SW-6stem', 'BS-Rofo-SW-Fixed.yaml'),
                         _hf('Politrees/UVR_resources', 'models/Roformer/BandSplit/config_BandSplit-Roformer_SW_by-jarredou.yaml')]},
            {'path': 'evidence/upstream-commit.txt', 'text': COMMIT},
        ] + _source_files(),
    },
    'guitar': {
        'title': 'Lead guitar splitter (Mel-Band RoFormer)',
        'role': 'Separates the lead guitar from the rest of the guitar. Rhythm guitar is what is left over.',
        'license': 'Uploaded by "listra92" with an OpenRAIL++ tag but no model card or training details, so the terms are unconfirmed. '
                   'The model code is MIT.',
        'files': [
            {'path': 'weights/model_mel_band_roformer_ep_72_sdr_3.2232.ckpt', 'size': 337073664,
             'sha256': 'b3c47bca33609ca1ba0bb2d2076410bfd1eb941b051b72afc1f3e24d12b17eef',
             'sources': [_hf('listra92/MyModels', 'misc/model_mel_band_roformer_ep_72_sdr_3.2232.ckpt'),
                         _hf('noblebarkrr/mvsepless_resources', 'mel_band_roformer/mbr_lead_rhythm_guitar_listra92.ckpt'),
                         _hf('badrihf/mvsepless_resources', 'mel_band_roformer/mbr_lead_rhythm_guitar_listra92.ckpt')]},
            {'path': 'evidence/config_mel_band_roformer_Lead_Rhythm_Guitar.yaml', 'size': 2673,
             'sha256': 'fc47975bba58b7b4c6de363bfe158943092c77bfb0b9a41c0c741eafba330359',
             'sources': [_hf('listra92/MyModels', 'misc/config_mel_band_roformer_Lead_Rhythm_Guitar.yaml')]},
            {'path': 'evidence/upstream-commit.txt', 'text': COMMIT},
        ] + _source_files(),
    },
}
assert set(REGISTRY) == set(MODELS)


class DownloadError(Exception):
    pass


class Cancelled(Exception):
    pass


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        while True:
            block = stream.read(CHUNK)
            if not block:
                return digest.hexdigest()
            digest.update(block)


def host_allowed(url, hosts=ALLOWED_HOSTS, secure=True):
    parts = urlparse(url)
    if secure and parts.scheme != 'https':
        return False
    host = (parts.hostname or '').lower()
    return any(host == h or host.endswith('.' + h) for h in hosts)


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts, secure):
        self.hosts, self.secure = hosts, secure

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not host_allowed(newurl, self.hosts, self.secure):
            raise DownloadError('Redirected to a location that is not on the allowed list: ' + (urlparse(newurl).hostname or '?'))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def make_opener(hosts=ALLOWED_HOSTS, secure=True):
    return urllib.request.build_opener(_CheckedRedirects(hosts, secure))


def fetch(url, partial, size, sha256, progress, cancelled, opener, hosts=ALLOWED_HOSTS, secure=True):
    """Download one URL into `partial` (resuming if possible) and return only when size and fingerprint are right."""
    if not host_allowed(url, hosts, secure):
        raise DownloadError('Not an allowed download location')
    partial.parent.mkdir(parents=True, exist_ok=True)
    have = partial.stat().st_size if partial.exists() else 0
    if have > size:
        partial.unlink()
        have = 0
    digest = hashlib.sha256()
    if have:
        with open(partial, 'rb') as stream:
            for block in iter(lambda: stream.read(CHUNK), b''):
                digest.update(block)
    def open_from(offset):
        headers = {'User-Agent': 'ChordBuddy-model-download'}
        if offset:
            headers['Range'] = f'bytes={offset}-'
        return opener.open(urllib.request.Request(url, headers=headers), timeout=30)
    try:
        try:
            response = open_from(have)
        except urllib.error.HTTPError as exc:
            if exc.code == 416 and have == size:       # already complete
                response = None
            elif have:                                 # some servers refuse to resume: start the file again instead
                partial.unlink(missing_ok=True)
                have = 0
                digest = hashlib.sha256()
                response = open_from(0)
            else:
                raise
    except urllib.error.HTTPError as exc:
        raise DownloadError(f'HTTP {exc.code}') from exc
    except (urllib.error.URLError, OSError) as exc:
        raise DownloadError(str(getattr(exc, 'reason', exc))) from exc
    if response is not None:
        with response:
            if have and response.status != 206:        # the server ignored the resume request: start over
                have = 0
                digest = hashlib.sha256()
            mode = 'ab' if have else 'wb'
            done = have
            try:
                with open(partial, mode) as out:
                    while True:
                        if cancelled():
                            raise Cancelled()
                        block = response.read(CHUNK)
                        if not block:
                            break
                        done += len(block)
                        if done > size:
                            raise DownloadError('The file is larger than expected')
                        out.write(block)
                        digest.update(block)
                        progress(done)
            except (OSError, urllib.error.URLError) as exc:
                if isinstance(exc, Cancelled):
                    raise
                raise DownloadError(str(exc)) from exc
    final = partial.stat().st_size
    if final != size:
        raise DownloadError(f'Incomplete download ({final} of {size} bytes)')
    if (digest.hexdigest() if response is not None else file_sha256(partial)) != sha256:
        partial.unlink(missing_ok=True)
        raise DownloadError('The file does not match its fingerprint')


class ModelManager:
    def __init__(self, project, registry=REGISTRY, opener=None, hosts=ALLOWED_HOSTS, secure=True):
        self.project = Path(project)
        self.registry = registry
        self.hosts, self.secure = hosts, secure
        self.opener = opener or make_opener(hosts, secure)
        self.lock = threading.RLock()
        self.cancel_flag = threading.Event()
        self.thread = None
        self.progress = {}         # {'stage','path','done','size','source'}
        self.errors = {}           # stage -> message
        self._verified = {}        # (path, size, mtime_ns) -> True

    # ----- what is installed -----
    def _target(self, stage, spec):
        return model_root(self.project, stage) / spec['path']

    def _installed(self, stage, spec):
        path = self._target(stage, spec)
        try:
            info = path.stat()
        except OSError:
            return False
        if 'text' in spec:
            return path.read_text(encoding='utf-8').strip() == spec['text']
        if info.st_size != spec['size']:
            return False
        key = (str(path), info.st_size, info.st_mtime_ns)
        if key in self._verified:
            return True
        if file_sha256(path) != spec['sha256']:
            return False
        self._verified[key] = True
        return True

    def _stage_files(self, stage):
        return self.registry[stage]['files']

    def environment_ok(self, stage):
        """The separation engine's own interpreter and libraries (not downloadable; part of the install)."""
        home = separation_home(self.project)
        return (home / 'runtime/python.exe').is_file() and (home / 'packages').is_dir()

    def status(self):
        with self.lock:
            active = bool(self.thread and self.thread.is_alive())
            models = []
            for stage, entry in self.registry.items():
                files = self._stage_files(stage)
                missing = [f for f in files if not self._installed(stage, f)]
                total = sum(f.get('size', 0) for f in files if f in missing)
                progress = self.progress if self.progress.get('stage') == stage else None
                done = sum(f.get('size', 0) for f in files if f not in missing)
                models.append({
                    'id': stage, 'title': entry['title'], 'role': entry['role'], 'license': entry['license'],
                    'ready': not missing, 'bytes_missing': total, 'environment': self.environment_ok(stage),
                    'error': self.errors.get(stage), 'downloading': bool(active and progress),
                    'progress': dict(progress) if progress else None, 'bytes_present': done,
                })
            return {'ready': all(m['ready'] for m in models), 'active': active, 'models': models,
                    'bytes_missing': sum(m['bytes_missing'] for m in models)}

    def ready(self):
        return self.status()['ready']

    # ----- downloading -----
    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return self.status()
            self.cancel_flag.clear()
            self.errors.clear()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        return self.status()

    def cancel(self):
        self.cancel_flag.set()
        return self.status()

    def wait(self):
        thread = self.thread
        if thread:
            thread.join()

    def _run(self):
        try:
            for stage in self.registry:
                for spec in self._stage_files(stage):
                    if self.cancel_flag.is_set():
                        return
                    if self._installed(stage, spec):
                        continue
                    try:
                        self._install(stage, spec)
                    except Cancelled:
                        return
                    except DownloadError as exc:
                        with self.lock:
                            self.errors[stage] = f'{Path(spec["path"]).name}: {exc}'
                        break           # the rest of this model is useless without this file
        finally:
            with self.lock:
                self.progress = {}

    def _install(self, stage, spec):
        target = self._target(stage, spec)
        target.parent.mkdir(parents=True, exist_ok=True)
        if 'text' in spec:
            target.write_text(spec['text'] + '\n', encoding='utf-8')
            return
        partial = target.with_name(target.name + '.partial')
        needed = spec['size'] - (partial.stat().st_size if partial.exists() else 0)
        if shutil.disk_usage(target.parent).free < needed + SLACK:
            raise DownloadError('Not enough free disk space')
        failures = []
        for url in spec['sources']:
            host = urlparse(url).hostname or '?'
            with self.lock:
                self.progress = {'stage': stage, 'path': spec['path'], 'done': 0, 'size': spec['size'], 'source': host}

            def update(done):
                with self.lock:
                    self.progress['done'] = done
            try:
                fetch(url, partial, spec['size'], spec['sha256'], update, self.cancel_flag.is_set, self.opener, self.hosts, self.secure)
            except DownloadError as exc:
                failures.append(f'{host}: {exc}')
                continue
            os.replace(partial, target)
            return
        raise DownloadError('could not be downloaded (' + '; '.join(failures) + ')')

    # ----- a file the user already has -----
    def adopt(self, name, path, move=False):
        """Install a file the user supplied if (and only if) it is exactly one of the files we are missing."""
        path = Path(path)
        size = path.stat().st_size
        digest = None
        for stage in self.registry:
            for spec in self._stage_files(stage):
                if 'text' in spec or spec['size'] != size or self._installed(stage, spec):
                    continue
                digest = digest or file_sha256(path)
                if digest != spec['sha256']:
                    continue
                target = self._target(stage, spec)
                target.parent.mkdir(parents=True, exist_ok=True)
                partial = target.with_name(target.name + '.partial')
                if move:
                    os.replace(path, partial)
                else:
                    shutil.copyfile(path, partial)
                os.replace(partial, target)
                return {'model': stage, 'path': spec['path']}
        raise ValueError('That file is not one of the models Chord Buddy needs (its fingerprint does not match).')


def main(argv=None):
    """Command line: `runtime\python.exe -m chordbuddy.model_downloads [--project FOLDER]` downloads whatever is missing."""
    import argparse
    parser = argparse.ArgumentParser(description='Download and verify the stem separation models.')
    parser.add_argument('--project', default='.', help='the Chord Buddy folder (default: this folder)')
    args = parser.parse_args(argv)
    manager = ModelManager(Path(args.project).resolve())
    before = manager.status()
    if before['ready']:
        print('All stem separation models are already present and verified.')
        return 0
    print(f"Downloading {before['bytes_missing'] / 1024 ** 2:.0f} MB of stem separation models (each file is checked against its fingerprint)…", flush=True)
    manager.start()
    last = ''
    while manager.thread and manager.thread.is_alive():
        time.sleep(2)
        with manager.lock:
            p = dict(manager.progress)
        line = f"  {p['path'].split('/')[-1]}: {p['done'] / 1024 ** 2:.0f} of {p['size'] / 1024 ** 2:.0f} MB from {p['source']}" if p else ''
        if line and line != last:
            print(line, flush=True)
            last = line
    after = manager.status()
    for model in after['models']:
        print(f"  {model['title']}: " + ('ready' if model['ready'] else 'FAILED ' + str(model['error'])))
    return 0 if after['ready'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
