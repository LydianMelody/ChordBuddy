"""Moving one song between libraries (another computer, a USB stick): a zip with the song's folder and its database rows.

The zip holds chordbuddy-song.json (the song's rows from library.sqlite3, and how each file was stored) and song/... (its recording,
analysis, transcriptions and, when asked for, the stems). The float WAVs travel as 24-bit FLAC, about a third of their size, and come
back as float WAVs with their original headers; identical files (the decoded recording kept twice, the MP3 snapshots) travel once.
Importing unpacks into the song folder, renames anything whose ID is already taken here (another copy of the same song, say), fixes
the checksums that cover the files it rewrote or decoded, and adds the rows in one transaction.

Updating a song that is already here only adds: an overwritten analysis stays under Previous transcriptions. The one exception is
overwritten stems, which are retired by the same rule as splitting them again (stem_retention), since they can be split again.
"""
from __future__ import annotations

from datetime import datetime, timezone
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import threading
import zipfile

import numpy

from .analysis_contract import digest
from .filenames import safe_stem
from .path_policy import new_id, validate_paths, validate_song
from .separation_audio import index_wav
from .separation_contract import file_hash

FORMAT = 'chordbuddy-song'
VERSION = 2   # 2: chordbuddy-song.json lists every file (FLAC audio, files stored once); version 1 zips still import
MANIFEST = 'chordbuddy-song.json'
PARTS = ('runs', 'analysis', 'separation')
# Audio is stored as it is (deflate barely shrinks it and is slow); everything else is compressed.
STORED = {'.wav', '.mp3', '.flac', '.ogg', '.npy', '.npz'}
# Files that may name an ID, rewritten when one has to change.
TEXT = {'.json', '.txt', '.log', '.tsv', '.lab', '.abc'}
# Insert order respects every reference between the tables.
TABLES = ('song_metadata', 'runs', 'documents', 'edits', 'retained_documents', 'timing_versions', 'timing_bindings',
          'separation_runs', 'song_separations', 'analysis_stages', 'analysis_jobs', 'analysis_invalidations')
ANALYSIS_TABLES = {'song_metadata', 'runs', 'documents', 'edits', 'retained_documents', 'timing_versions', 'timing_bindings',
                   'analysis_jobs', 'analysis_invalidations'}
STEM_TABLES = {'separation_runs', 'song_separations'}
ID = re.compile(r'[0-9a-f]{12}|[0-9a-f]{32}')
HASH = re.compile(r'(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])')
MAX_MANIFEST = 512 * 1024 * 1024
MAX_UPLOAD = 32 * 1024 ** 3
PENDING_LIMIT = 4


def now():
    return datetime.now(timezone.utc).isoformat()


def _swap(value, mapping):
    """Replace whole IDs (never part of a longer hex string) everywhere in a JSON-able value."""
    if not mapping:
        return value
    pattern = re.compile('(?<![0-9a-f])(?:' + '|'.join(map(re.escape, sorted(mapping, key=len, reverse=True))) + ')(?![0-9a-f])')
    return json.loads(pattern.sub(lambda m: mapping[m.group(0)], json.dumps(value, ensure_ascii=False)))


def _stems_of(job):
    """A job that no longer names the stems it was analyzed with: playback then uses the song's active stems (see playback_ready)."""
    job = dict(job, stems=False)
    job['stages'] = dict(job.get('stages') or {}, separation={'status': 'skipped'})   # as analysis.py records skipped stems
    return job


def _song_files(folder, stems_id):
    """(name inside song/, path) for the recording, transcriptions, analysis and, with stems_id, those stems."""
    files = [('source.mp3', folder / 'source.mp3')]
    roots = [folder / 'runs', folder / 'analysis'] + ([folder / 'separation' / stems_id] if stems_id else [])
    for root in roots:
        if not root.is_dir() or root.is_symlink():
            continue
        for base, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not (Path(base) / d).is_symlink())
            for name in sorted(names):
                path = Path(base) / name
                if path.is_symlink() or not path.is_file():
                    continue
                if name == 'guitar.wav' and Path(base).parent.name == 'separation':
                    continue   # the splitter's intermediate: nothing plays it (newer splits no longer keep it)
                files.append((path.relative_to(folder).as_posix(), path))
    return files


def _unique(files):
    """The files with every identical copy left out (the decoded recording is kept twice, the MP3 snapshots three times)."""
    by_size = {}
    for name, path in files:
        by_size.setdefault(path.stat().st_size, []).append((name, path))
    unique = []
    for group in by_size.values():
        seen = set()
        for name, path in group:
            key = file_hash(path) if len(group) > 1 else name
            if key not in seen:
                seen.add(key)
                unique.append((name, path))
    return unique


def _float_wav(path):
    """How a float WAV is rebuilt from FLAC: its header and trailer bytes, its frames and the scale that keeps it inside full scale.
    None for anything that is not a stereo float WAV (stored as it is)."""
    try:
        info = index_wav(path)
    except (OSError, ValueError):
        return None
    end = info['data_offset'] + info['frames'] * 8
    with open(path, 'rb') as stream:
        header = stream.read(info['data_offset'])
        stream.seek(end)
        trailer = stream.read()
    samples = numpy.memmap(path, dtype='<f4', mode='r', offset=info['data_offset'], shape=(info['frames'] * 2,))
    peak = float(numpy.abs(samples).max()) if len(samples) else 0.0
    del samples
    return {'header': base64.b64encode(header).decode(), 'trailer': base64.b64encode(trailer).decode(),
            'frames': info['frames'], 'scale': peak if peak > 1 else 1.0}


class SongTransfer:
    def __init__(self, app):
        self.app = app
        self.library = app.library
        self.lock = threading.Lock()
        self.pending = {}
        self.staging = self.library.root / '.imports'
        # Leftovers of an import that was interrupted (the app closed mid-way): nothing in them is referenced.
        shutil.rmtree(self.staging, ignore_errors=True)

    # ---------------------------------------------------------------- export
    def _active_stems(self, song_id):
        row = self.library.db.execute(
            "SELECT r.* FROM song_separations s JOIN separation_runs r ON r.id=s.active_id WHERE s.song_id=? AND r.song_id=? AND r.status='completed'",
            (song_id, song_id)).fetchone()
        return dict(row) if row else None

    def sizes(self, song_id):
        """Bytes in the zip without stems, and what the stems add (0 when the song has none)."""
        with self.library.lock:
            song = self.library.song(song_id)
            if song['deleted']:
                raise ValueError('Restore this song from the Trash before exporting it.')
            stems = self._active_stems(song_id)
            folder = self.library.folder(song_id)
        # About: float WAVs shrink to roughly 25-45% as FLAC; 40% keeps the estimate on the safe side.
        size = lambda files: sum(p.stat().st_size * (.4 if p.suffix.lower() == '.wav' else 1) for _, p in _unique(files))
        everything = size(_song_files(folder, stems['id'] if stems else None))
        without = size(_song_files(folder, None))
        return {'bytes': round(without), 'stems_bytes': round(everything - without), 'title': song['title']}

    def export_plan(self, song_id, stems):
        """The manifest, the files to add and the zip's file name. Taken under the library lock, so the rows are one consistent moment."""
        with self.library.lock:
            db = self.library.db
            song = self.library.song(song_id)
            if song['deleted']:
                raise ValueError('Restore this song from the Trash before exporting it.')
            rows = lambda sql: [dict(r) for r in db.execute(sql, (song_id,))]
            active = self._active_stems(song_id) if stems else None
            stages = rows('SELECT rowid AS _row,* FROM analysis_stages WHERE song_id=? ORDER BY rowid')
            stages = [s for s in stages if s['kind'] != 'separation' or (active and json.loads(s['manifest']).get('run_id') == active['id'])]
            kept = {s['id'] for s in stages}
            jobs = []
            for row in db.execute('SELECT snapshot FROM analysis_jobs ORDER BY rowid'):
                job = json.loads(row[0])
                if job.get('song_id') != song_id:
                    continue
                separation = (job.get('stages') or {}).get('separation')
                if job.get('kind') == 'analysis' and job.get('stems', True) and (separation or {}).get('id') not in kept:
                    job = _stems_of(job)
                jobs.append(job)
            invalidations = [{'song_id': r['song_id'], 'kind': r['kind'], 'before_index': sum(1 for s in stages if s['_row'] <= r['before_row'])}
                             for r in rows('SELECT * FROM analysis_invalidations WHERE song_id=?')]
            for stage in stages:
                del stage['_row']
            tables = {
                'song_metadata': rows('SELECT * FROM song_metadata WHERE song_id=?'),
                'runs': rows('SELECT * FROM runs WHERE song_id=? ORDER BY rowid'),
                'documents': rows('SELECT * FROM documents WHERE song_id=? ORDER BY rowid'),
                'edits': rows('SELECT e.* FROM edits e JOIN documents d ON d.id=e.document_id WHERE d.song_id=? ORDER BY e.document_id,e.position'),
                'retained_documents': rows('SELECT r.* FROM retained_documents r JOIN runs u ON u.id=r.run_id WHERE u.song_id=?'),
                'timing_bindings': rows('SELECT b.* FROM timing_bindings b JOIN documents d ON d.id=b.document_id WHERE d.song_id=?'),
                'separation_runs': [active] if active else [],
                'song_separations': [{'song_id': song_id, 'active_id': active['id']}] if active else [],
                'analysis_stages': stages,
                'analysis_jobs': [{'id': job['id'], 'snapshot': json.dumps(job, allow_nan=False)} for job in jobs],
                'analysis_invalidations': invalidations,
            }
            # Timing versions are shared by content; take the ones this song's rows name.
            named = set(HASH.findall(json.dumps(tables)))
            tables['timing_versions'] = [dict(r) for r in db.execute('SELECT * FROM timing_versions') if r['id'] in named]
            folder = self.library.folder(song_id)
            source_hash = file_hash(self.library.source_path(song_id))
        song.pop('deleted', None)
        manifest = {'format': FORMAT, 'version': VERSION, 'exported': now(), 'source_sha256': source_hash,
                    'stems': bool(active), 'song': song, 'tables': tables}
        return manifest, _song_files(folder, active['id'] if active else None), safe_stem(song['title'], 'Song') + '.zip'

    def _ffmpeg(self):
        bundled = self.app.separation.project / 'tools' / 'ffmpeg.exe'
        return str(bundled) if bundled.is_file() else (shutil.which('ffmpeg') or 'ffmpeg')

    def _run_ffmpeg(self, *args):
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        done = subprocess.run([self._ffmpeg(), '-nostdin', '-v', 'error', '-y', *args], capture_output=True, creationflags=flags)
        if done.returncode:
            raise ValueError('Could not convert the audio: ' + done.stderr.decode('utf-8', 'replace').strip()[-300:])

    def write_zip(self, manifest, files, write):
        """Stream the zip to `write` (an HTTP response) as it is made: every file, then the rows and how each file was stored."""
        class Sink:
            def write(self, data):
                write(data)
                return len(data)

            def flush(self):
                pass
        self.staging.mkdir(exist_ok=True)
        work = self.staging / ('export-' + secrets.token_hex(6))
        work.mkdir()
        entries, stored = [], {}
        try:
            with zipfile.ZipFile(Sink(), 'w', allowZip64=True) as archive:
                for name, path in files:
                    sha = file_hash(path)
                    if sha in stored:
                        entries.append({'path': name, 'sha256': sha, 'same': stored[sha]})
                        continue
                    stored[sha] = name
                    entry = {'path': name, 'sha256': sha}
                    flac = _float_wav(path) if path.suffix.lower() == '.wav' else None
                    if flac:
                        temp = work / 'audio.flac'
                        level = ['-af', f'volume={1 / flac["scale"]!r}'] if flac['scale'] > 1 else []
                        self._run_ffmpeg('-i', str(path), *level, '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24',
                                         '-compression_level', '5', str(temp))
                        entry.update(zip='song/' + name + '.flac', flac=flac)
                        archive.write(temp, entry['zip'], compress_type=zipfile.ZIP_STORED)
                        temp.unlink()
                    else:
                        entry['zip'] = 'song/' + name
                        archive.write(path, entry['zip'], compress_type=zipfile.ZIP_STORED if path.suffix.lower() in STORED else zipfile.ZIP_DEFLATED)
                    entries.append(entry)
                archive.writestr(MANIFEST, json.dumps(dict(manifest, files=entries), ensure_ascii=False, allow_nan=False),
                                 compress_type=zipfile.ZIP_DEFLATED)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    # ---------------------------------------------------------------- import
    def receive(self, read, size):
        """Save an uploaded zip, read what is in it, and say how it relates to this library. Returns the summary with a token for apply()."""
        if not 0 < size <= MAX_UPLOAD:
            raise ValueError('Choose a song zip exported from Chord Buddy.')
        self.staging.mkdir(exist_ok=True)
        token = secrets.token_hex(8)
        path = self.staging / (token + '.zip')
        try:
            left = size
            with open(path, 'wb') as out:
                while left:
                    block = read(min(1 << 20, left))
                    if not block:
                        raise ValueError('The upload was interrupted')
                    out.write(block)
                    left -= len(block)
            manifest = self._read(path)
            summary = self.describe(manifest)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        with self.lock:
            while len(self.pending) >= PENDING_LIMIT:
                self.cancel(next(iter(self.pending)))
            self.pending[token] = (path, manifest)
        return dict(summary, token=token)

    def cancel(self, token):
        entry = self.pending.pop(token, None)
        if entry:
            entry[0].unlink(missing_ok=True)
        return {'cancelled': bool(entry)}

    @staticmethod
    def _read(path):
        try:
            archive = zipfile.ZipFile(path)
        except zipfile.BadZipFile as exc:
            raise ValueError('This file is not a song exported from Chord Buddy.') from exc
        with archive:
            names = set()
            for info in archive.infolist():
                name = info.filename
                parts = PurePosixPath(name).parts
                if (not name or name.startswith('/') or '\\' in name or ':' in name or '..' in parts or name in names
                        or not (name == MANIFEST or (len(parts) > 1 and parts[0] == 'song'))):
                    raise ValueError('This zip contains a file Chord Buddy will not unpack: ' + name[:120])
                names.add(name)
            if MANIFEST not in names:
                raise ValueError('This file is not a song exported from Chord Buddy.')
            if archive.getinfo(MANIFEST).file_size > MAX_MANIFEST:
                raise ValueError('This song zip is damaged.')
            try:
                manifest = json.loads(archive.read(MANIFEST).decode('utf-8'))
            except (ValueError, UnicodeDecodeError) as exc:
                raise ValueError('This song zip is damaged.') from exc
        if not isinstance(manifest, dict) or manifest.get('format') != FORMAT:
            raise ValueError('This file is not a song exported from Chord Buddy.')
        if not isinstance(manifest.get('version'), int) or manifest['version'] > VERSION:
            raise ValueError('This song was exported by a newer Chord Buddy. Update Chord Buddy on this computer, then import it again.')
        song, tables = manifest.get('song'), manifest.get('tables')
        if (not isinstance(song, dict) or not isinstance(tables, dict) or set(tables) - set(TABLES)
                or any(not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows) for rows in tables.values())
                or not isinstance(song.get('id'), str) or not ID.fullmatch(song['id']) or song.get('folder') != song['id']
                or not isinstance(song.get('title'), str) or not isinstance(manifest.get('source_sha256'), str)):
            raise ValueError('This song zip is damaged.')
        for table in TABLES:
            tables.setdefault(table, [])
        if manifest['version'] < 2:   # version 1 stored every file as it is, under its own name
            manifest['files'] = [{'path': n[5:], 'zip': n} for n in sorted(names) if n.startswith('song/') and not n.endswith('/')]
        files = manifest.get('files')
        if not isinstance(files, list) or any(not isinstance(f, dict) for f in files):
            raise ValueError('This song zip is damaged.')
        paths = set()
        for entry in files:
            path = entry.get('path')
            parts = PurePosixPath(path).parts if isinstance(path, str) else ()
            if (not parts or path.startswith('/') or '\\' in path or ':' in path or '..' in parts or path in paths
                    or (entry.get('zip') is None) == (entry.get('same') is None)
                    or (entry.get('zip') is not None and entry['zip'] not in names)
                    or (entry.get('sha256') is not None and not (isinstance(entry['sha256'], str) and HASH.fullmatch(entry['sha256'])))):
                raise ValueError('This song zip is damaged.')
            flac = entry.get('flac')
            if flac is not None and (not isinstance(flac, dict) or not isinstance(flac.get('header'), str) or not isinstance(flac.get('trailer'), str)
                                     or type(flac.get('frames')) is not int or flac['frames'] <= 0 or type(flac.get('scale')) not in (int, float)
                                     or not 1 <= flac['scale'] < 1e6 or entry.get('sha256') is None):
                raise ValueError('This song zip is damaged.')
            paths.add(path)
        origins = {f['path'] for f in files if f.get('zip')}
        if any(f.get('same') is not None and f['same'] not in origins for f in files):
            raise ValueError('This song zip is damaged.')
        if 'source.mp3' not in paths:
            raise ValueError('This song zip has no recording in it.')
        return manifest

    def _matches(self, manifest):
        """The songs here with the same title (ignoring capitals and spacing), whatever recording or IDs they have."""
        title = _title_key(manifest['song']['title'])
        found = []
        for row in self.library.db.execute('SELECT * FROM songs WHERE deleted IS NULL ORDER BY created'):
            if _title_key(row['title']) != title:
                continue
            try:
                same = file_hash(self.library.source_path(row['id'])) == manifest['source_sha256']
            except OSError:
                same = False
            found.append({'id': row['id'], 'title': row['title'], 'artist': row['artist'], 'created': row['created'], 'analyzed': bool(row['active_run']),
                          'stems': bool(self._active_stems(row['id'])), 'same_recording': same})
        return found

    def describe(self, manifest):
        song = manifest['song']
        with self.library.lock:
            matches = self._matches(manifest)
        return {'title': song['title'], 'artist': song.get('artist') or '', 'analyzed': bool(song.get('active_run')),
                'stems': bool(manifest['tables']['song_separations']), 'matches': matches}

    def apply(self, token, mode, analysis=False, stems=False, setlist='default', target=None):
        """mode 'new' adds the song (under new IDs where they are taken); 'update' overwrites the analysis and/or the stems of `target`,
        a song here with the same title."""
        if mode not in ('new', 'update') or type(analysis) is not bool or type(stems) is not bool:
            raise ValueError('Choose how to import this song')
        setlist = setlist or 'default'
        with self.lock:
            entry = self.pending.pop(token, None)
        if not entry:
            raise ValueError('This import has expired. Choose the zip again.')
        path, manifest = entry
        try:
            return self._apply(path, manifest, mode, analysis, stems, setlist, target)
        finally:
            path.unlink(missing_ok=True)

    def _apply(self, path, manifest, mode, analysis, stems, setlist, target):
        library, app = self.library, self.app
        song, tables = manifest['song'], manifest['tables']
        has_stems = bool(tables['song_separations'])
        with app.job_lock:
            with library.lock:
                local = next((m for m in self._matches(manifest) if m['id'] == target), None) if mode == 'update' else None
                if mode == 'update':
                    if not local:
                        raise ValueError('That song is no longer in your library. Import this one as a new song.')
                    if app._song_busy(local['id']):
                        raise ValueError('This song is being analyzed. Wait for it to finish, then import again.')
                    take_analysis = analysis and bool(song.get('active_run'))
                    take_stems = stems and has_stems
                    if not take_analysis and not take_stems:
                        return {'song_id': local['id'], 'changed': False}
                else:
                    library.setlist(setlist)
                    take_analysis, take_stems = True, has_stems
                plan = self._plan(manifest, local, take_analysis, take_stems)
            # Unpacked straight into place (renaming a fresh folder fails while Dropbox or a virus scanner is still reading it).
            # Every folder made here has a name nothing else uses, so a failure removes exactly what was added.
            created, swapped = [], None
            try:
                self._unpack(path, plan, created)
                with library.lock:
                    if plan['replace_recording']:
                        # What was brought in belongs to the zip's recording, so it replaces the one here. The old one stays in the
                        # song folder under a dated name, never deleted.
                        source = library.source_path(plan['song_id'])
                        swapped = (source, source.with_name(datetime.now().strftime('source-replaced-%Y%m%d-%H%M%S.mp3')))
                        os.replace(source, swapped[1])
                        os.replace(plan['new_source'], source)
                    self._commit(plan, setlist)
            except BaseException:
                if swapped and swapped[1].exists():
                    os.replace(swapped[1], swapped[0])
                for made in reversed(created):
                    if made.is_dir():
                        shutil.rmtree(made, ignore_errors=True)
                    else:
                        made.unlink(missing_ok=True)
                raise
            song_id = plan['song_id']
            result = {'song_id': song_id, 'changed': True, 'warning': None}
            if take_stems and local and local['stems']:
                # The stems that were here are now superseded: retire them as a fresh split would.
                from .stem_retention import prune_stem_history
                retention = prune_stem_history(app.separation.project, app.separation_store, app.analysis.store, song_id=song_id,
                                               readiness=app.playback.state)
                if retention.get('warning'):
                    result['warning'] = ('The song was updated, but its old stems could not be deleted yet. They do no harm, '
                                         'and are cleaned up the next time this song’s stems are split.')
            app.playback.light.pop(song_id, None)
            return result

    def _plan(self, manifest, local, take_analysis, take_stems):
        """Which rows and files to bring in, and the new name for every ID that is already taken here."""
        library, db = self.library, self.library.db
        song, tables = manifest['song'], manifest['tables']
        rows = {t: [dict(r) for r in tables[t]] for t in TABLES if (t in ANALYSIS_TABLES and take_analysis) or (t in STEM_TABLES and take_stems)}
        rows['analysis_stages'] = [dict(s) for s in tables['analysis_stages'] if (take_stems if s.get('kind') == 'separation' else take_analysis)]
        # A transcription, stage or job this copy already has unchanged (a round trip brings back all the history) is not added again;
        # one edited on both computers is kept twice, the imported one under new IDs.
        same_runs, same_docs, folder = set(), set(), library.folder(local['id']) if local else None
        if local and 'runs' in rows:
            for run in rows['runs']:
                if db.execute('SELECT 1 FROM runs WHERE id=? AND song_id=?', (run.get('id'), local['id'])).fetchone():
                    theirs = [d for d in rows['documents'] if d.get('run_id') == run['id']]
                    mine = [dict(r) for r in db.execute('SELECT * FROM documents WHERE run_id=?', (run['id'],))]
                    mine_edits = [dict(r) for r in db.execute('SELECT e.* FROM edits e JOIN documents d ON d.id=e.document_id WHERE d.run_id=?', (run['id'],))]
                    mine_timing = [dict(r) for r in db.execute('SELECT b.* FROM timing_bindings b JOIN documents d ON d.id=b.document_id WHERE d.run_id=?', (run['id'],))]
                    if _signature(theirs, rows['edits'], rows['timing_bindings']) == _signature(mine, mine_edits, mine_timing):
                        same_runs.add(run['id'])
                        same_docs |= {d['id'] for d in theirs}
            rows['runs'] = [r for r in rows['runs'] if r['id'] not in same_runs]
            rows['documents'] = [d for d in rows['documents'] if d['id'] not in same_docs]
            for table in ('edits', 'timing_bindings'):
                rows[table] = [r for r in rows[table] if r.get('document_id') not in same_docs]
            rows['retained_documents'] = [r for r in rows['retained_documents'] if r.get('run_id') not in same_runs]
        if local:
            for table in ('analysis_stages', 'analysis_jobs'):
                if table in rows:
                    rows[table] = [r for r in rows[table] if not db.execute(f'SELECT 1 FROM {table} WHERE id=?', (r.get('id'),)).fetchone()]
        # Only rows that belong to this song: history and timing must name this song's own documents and transcriptions.
        documents = {d.get('id') for d in rows.get('documents', [])} | same_docs
        runs = {r.get('id') for r in rows.get('runs', [])} | same_runs
        for table, key, allowed in (('edits', 'document_id', documents), ('timing_bindings', 'document_id', documents),
                                    ('retained_documents', 'document_id', documents), ('retained_documents', 'run_id', runs),
                                    ('documents', 'run_id', runs | {None})):
            if table in rows:
                rows[table] = [r for r in rows[table] if r.get(key) in allowed]
        rows['analysis_jobs'] = [j for j in rows.get('analysis_jobs', []) if isinstance(j.get('snapshot'), str)
                                 and json.loads(j['snapshot']).get('song_id') == song['id']]
        if not take_analysis:
            del rows['analysis_jobs']
        if local and not (take_analysis and take_stems) and 'analysis_jobs' in rows:
            rows['analysis_jobs'] = [dict(j, snapshot=json.dumps(_stems_of(json.loads(j['snapshot'])))) for j in rows['analysis_jobs']]
        parts = {p for p, wanted in (('runs', take_analysis), ('analysis', take_analysis), ('separation', take_stems)) if wanted}
        replace_recording = bool(local) and not local['same_recording'] and (take_analysis or take_stems)
        files = [f for f in manifest['files'] if (f['path'] == 'source.mp3' and (not local or replace_recording))
                 or (len(f['path'].split('/')) > 1 and f['path'].split('/')[0] in parts)]
        if local:
            # Unchanged transcriptions are already here, and an analysis folder is never changed once written: keep the copy here.
            files = [f for f in files if not (f['path'].split('/')[0] == 'runs' and f['path'].split('/')[1] in same_runs)
                     and not (f['path'].split('/')[0] == 'analysis' and len(f['path'].split('/')) > 2
                              and (folder / 'analysis' / f['path'].split('/')[1]).is_dir())]
        names = ['song/' + f['path'] for f in files]

        def taken(table, ident):
            return db.execute(f'SELECT 1 FROM {table} WHERE id=?', (ident,)).fetchone() is not None

        candidates = {}
        if not local:
            candidates[song['id']] = lambda i: taken('songs', i) or (library.root / i).exists() or db.execute('SELECT 1 FROM songs WHERE folder=?', (i,)).fetchone()
        for table, part in (('runs', 'runs'), ('documents', None), ('analysis_stages', None), ('analysis_jobs', None), ('separation_runs', 'separation')):
            for row in rows.get(table, []):
                ident = row.get('id')
                if not isinstance(ident, str) or not ID.fullmatch(ident):
                    raise ValueError('This song zip is damaged.')
                candidates[ident] = (lambda t, p: lambda i: taken(t, i) or bool(folder and p and (folder / p / i).exists()))(table, part)
        for name in names:
            bits = name.split('/')
            if bits[1] == 'analysis' and len(bits) > 3 and ID.fullmatch(bits[2]):
                candidates.setdefault(bits[2], lambda i: bool(folder and (folder / 'analysis' / i).exists()))
        # Into a song here with other IDs (the same MP3 imported on both computers, say): everything takes this song's ID and folder.
        mapping, fresh = ({song['id']: local['id']} if local and local['id'] != song['id'] else {}), set()
        if local:
            candidates.pop(song['id'], None)
        for ident, used in candidates.items():
            if used(ident):
                while True:
                    replacement = new_id(len(ident))
                    if replacement not in fresh and replacement not in candidates and not used(replacement):
                        break
                mapping[ident] = replacement
                fresh.add(replacement)
        song_id = local['id'] if local else mapping.get(song['id'], song['id'])
        return {'manifest': manifest, 'local': local, 'rows': rows, 'files': files, 'mapping': mapping, 'song_id': song_id,
                'take_analysis': take_analysis, 'take_stems': take_stems, 'replace_recording': replace_recording}

    def _unpack(self, path, plan, created):
        """Extract the wanted files into the song folder, renamed and rewritten where an ID changed, float WAVs rebuilt from FLAC.
        Records the checksums that change, and in `created` each new folder or file it made."""
        mapping, rename = plan['mapping'], plan['mapping'].get
        plan['hashes'] = {}
        by_path = {f['path']: f for f in plan['manifest']['files']}
        target_root = self.library.root / plan['song_id']
        validate_song(self.library.root, target_root)
        files = [(entry, Path(*[rename(part, part) for part in entry['path'].split('/')])) for entry in plan['files']]
        validate_paths([target_root / relative for _, relative in files])
        if not plan['local']:
            target_root.mkdir()   # FileExistsError if the name was taken meanwhile: nothing is overwritten
            created.append(target_root)
        written, texts = {}, []
        with zipfile.ZipFile(path) as archive:
            for entry, relative in files:
                out = target_root / relative
                if plan['local'] and relative == Path('source.mp3'):
                    out = plan['new_source'] = target_root / ('source-import-' + secrets.token_hex(4) + '.mp3')
                    created.append(out)
                elif plan['local']:
                    top = target_root / relative.parts[0] / relative.parts[1]
                    if top not in created:
                        top.parent.mkdir(parents=True, exist_ok=True)
                        top.mkdir()
                        created.append(top)
                out.parent.mkdir(parents=True, exist_ok=True)
                origin = by_path[entry['same']] if entry.get('same') else entry
                text = out.suffix.lower() in TEXT
                if origin['path'] in written and not text:
                    # The same file again: one copy on disk under both names, as the splitter keeps it.
                    try:
                        os.link(written[origin['path']], out)
                    except OSError:
                        shutil.copyfile(written[origin['path']], out)
                else:
                    self._extract(archive, origin, out)
                    written.setdefault(origin['path'], out)
                if origin.get('flac') and origin['path'] == entry['path']:
                    plan['hashes'][origin['sha256']] = file_hash(out)   # rebuilt from 24-bit: the samples differ inaudibly
                if text:
                    texts.append(out)
        # Text files name IDs and the checksums of the audio (the stems' manifest.json): rewritten once all of those are known.
        for out in texts:
            swap = {**mapping, **plan['hashes']}
            data = out.read_bytes()
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                continue
            changed = _swap_text(text, swap) if swap else text
            if changed != text:
                out.write_bytes(changed.encode('utf-8'))
                plan['hashes'][file_hash_bytes(data)] = file_hash(out)

    def _extract(self, archive, entry, out):
        flac = entry.get('flac')
        if not flac:
            with archive.open(entry['zip']) as src, open(out, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            return
        packed, raw = out.with_name(out.name + '.flac-part'), out.with_name(out.name + '.raw-part')
        try:
            with archive.open(entry['zip']) as src, open(packed, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            self._run_ffmpeg('-i', str(packed), '-f', 'f32le', '-c:a', 'pcm_f32le', '-ac', '2', '-ar', '44100', str(raw))
            if raw.stat().st_size != flac['frames'] * 8:
                raise ValueError('The audio in this song zip is damaged.')
            with open(out, 'wb') as dst:
                dst.write(base64.b64decode(flac['header']))
                if flac['scale'] == 1:
                    with open(raw, 'rb') as src:
                        shutil.copyfileobj(src, dst, 1 << 20)
                else:
                    (numpy.fromfile(raw, dtype='<f4') * numpy.float32(flac['scale'])).astype('<f4').tofile(dst)
                dst.write(base64.b64decode(flac['trailer']))
        finally:
            packed.unlink(missing_ok=True)
            raw.unlink(missing_ok=True)

    def _commit(self, plan, setlist):
        library, db = self.library, self.library.db
        manifest, local, song_id = plan['manifest'], plan['local'], plan['song_id']
        rows = _swap(plan['rows'], {**plan['mapping'], **plan['hashes']})
        # Rewritten files and renamed IDs change the fingerprints that cover them; work them out again until nothing moves.
        for _ in range(8):
            changed = {}
            for stage in rows.get('analysis_stages', []):
                reference = json.loads(stage['reference'])
                fresh = digest(json.loads(stage['manifest']))
                if reference.get('manifest_sha256') != fresh:
                    changed[reference['manifest_sha256']] = fresh
            for version in rows.get('timing_versions', []):
                fresh = digest(json.loads(version['value']))
                if version['id'] != fresh:
                    changed[version['id']] = fresh
            if not changed:
                break
            rows = _swap(rows, changed)
        song = _swap(dict(manifest['song']), plan['mapping'])
        with library.transaction() as tx:
            columns = {t: [r[1] for r in tx.execute(f'PRAGMA table_info({t})')] for t in TABLES + ('songs',)}

            def insert(table, row, verb='INSERT'):
                if 'song_id' in columns[table]:
                    row = dict(row, song_id=song_id)
                keys = [k for k in row if k in columns[table]]
                tx.execute(f'{verb} INTO {table}({",".join(keys)}) VALUES({",".join("?" * len(keys))})', [row[k] for k in keys])
                return tx.execute('SELECT last_insert_rowid()').fetchone()[0]

            before = tx.execute('SELECT COALESCE(MAX(rowid),0) FROM analysis_stages').fetchone()[0]
            stage_rows = []
            if local:
                if plan['replace_recording']:
                    tx.execute('UPDATE songs SET filename=?,duration=? WHERE id=?', (song['filename'], song['duration'], song_id))
                if plan['take_analysis']:
                    self.app.documents.freeze_active_timing(song_id)
                    tx.execute('UPDATE songs SET title=?,artist=?,status=?,error=?,active_run=? WHERE id=?',
                               (song['title'], song.get('artist') or '', song['status'], song.get('error'), song.get('active_run'), song_id))
            else:
                insert('songs', dict(song, id=song_id, folder=song_id, created=now(), deleted=None))
                for sid in dict.fromkeys(['default', setlist]):
                    library._add(tx, sid, song_id)
            for table in TABLES:
                for row in rows.get(table, []):
                    row = dict(row)
                    if table == 'song_metadata':
                        current = tx.execute('SELECT metadata_revision FROM song_metadata WHERE song_id=?', (song_id,)).fetchone()
                        row.update(song_id=song_id, metadata_revision=(current[0] + 1) if current else row.get('metadata_revision', 0))
                        insert(table, row, 'INSERT OR REPLACE')
                    elif table == 'analysis_stages':
                        stage_rows.append(insert(table, row))
                    elif table == 'analysis_invalidations':
                        # Stages before this one in the export were stale there, so they are here too.
                        index = row.pop('before_index', 0)
                        row['before_row'] = stage_rows[index - 1] if type(index) is int and 0 < index <= len(stage_rows) else before
                        insert(table, row, 'INSERT OR REPLACE')
                    elif table == 'timing_versions':
                        insert(table, row, 'INSERT OR IGNORE')
                    elif table == 'song_separations':
                        insert(table, row, 'INSERT OR REPLACE')
                    else:
                        insert(table, row)
            if local and not (plan['take_analysis'] and plan['take_stems']):
                # The analysis and the stems now come from different places: every analysis plays whichever stems are active.
                for row in tx.execute('SELECT id,snapshot FROM analysis_jobs').fetchall():
                    job = json.loads(row['snapshot'])
                    if job.get('song_id') == song_id and job.get('kind') == 'analysis' and job.get('stems', True):
                        tx.execute('UPDATE analysis_jobs SET snapshot=? WHERE id=?', (json.dumps(_stems_of(job)), row['id']))


def _title_key(title):
    return ' '.join(str(title or '').casefold().split())


def _signature(documents, edits, bindings=()):
    """What a transcription holds: its documents, every edit in their history and the timing grid each step of it is bound to (a
    timing correction is not an edit to the document), independent of row order."""
    ids = {d['id'] for d in documents}
    history, timing = {}, {}
    for e in edits:
        if e.get('document_id') in ids:
            history.setdefault(e['document_id'], []).append([e.get('position'), e.get('content'), e.get('label')])
    for b in bindings:
        if b.get('document_id') in ids:
            try:
                binding = json.dumps(json.loads(b.get('binding') or 'null'), sort_keys=True)
            except ValueError:
                binding = str(b.get('binding'))
            timing.setdefault(b['document_id'], []).append([b.get('position'), binding])
    return sorted(json.dumps([d.get('name'), d.get('kind'), d.get('cursor'), sorted(history.get(d['id'], [])), sorted(timing.get(d['id'], []))])
                  for d in documents)


def _swap_text(text, mapping):
    pattern = re.compile('(?<![0-9a-f])(?:' + '|'.join(map(re.escape, sorted(mapping, key=len, reverse=True))) + ')(?![0-9a-f])')
    return pattern.sub(lambda m: mapping[m.group(0)], text)


def file_hash_bytes(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()
