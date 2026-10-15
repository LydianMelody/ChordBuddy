"""Per-song retirement of superseded generated stems after valid publication.

Only seven named stem WAVs and the generated guitar intermediate are removed.
Source MP3, decoded original WAV, manifests, logs, caches and all history remain.
Interrupted purges resume only after another successful, validated publication.
"""
import json
import sqlite3
import os
import threading
import time
from pathlib import Path
from .recycle import checked_path, checked_tree
from .analysis_store import AnalysisStore
from .playback_ready import PlaybackReadiness, ACTIVE
from .separation_contract import STEMS, TRACKS, file_hash

_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
ENABLED = True  # User-approved permanent generated-stem policy; independently reviewed.


def _song_lock(library, song_id):
    key = (str(library.root.resolve()), song_id)
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def _record(path, value, project):
    checked_path(path, project)
    partial = checked_path(path.with_name(path.name + '.partial'), project)
    with partial.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    for attempt in range(6):
        try:
            os.replace(partial, path)
            break
        except PermissionError as exc:
            if getattr(exc, 'winerror', None) not in (5, 32, 33) or attempt == 5:
                raise
            time.sleep(.025 * 2**attempt)


def _target(project, library, row):
    folder = Path(row['folder'])
    target = checked_path(folder if folder.is_absolute() else library.root / folder, project)
    song_folder = Path(library.song(row['song_id'])['folder'])
    if song_folder.is_absolute() or '..' in song_folder.parts:
        raise ValueError('Invalid song folder')
    expected = checked_path(library.root / song_folder / 'separation' / row['id'], project)
    if target != expected:
        raise ValueError('Unexpected separation folder')
    return target


def _source(project, library, song_id):
    folder = Path(library.song(song_id)['folder'])
    if folder.is_absolute() or '..' in folder.parts:
        raise ValueError('Invalid source folder')
    source = checked_path(library.root / folder / 'source.mp3', project)
    if not source.is_file() or source.stat().st_size == 0:
        raise ValueError('Original source audio is unavailable; stems retained')
    return source


def _assets(root, row, source_hash, project):
    manifest_path = checked_path(root / 'manifest.json', project)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if (manifest.get('run_id') != row['id'] or manifest.get('song_id') != row['song_id']
            or manifest.get('source_sha256') != source_hash):
        raise ValueError('Obsolete stem provenance does not match retained source')
    if [a.get('role') for a in manifest['assets']] != list(TRACKS):
        raise ValueError('Invalid obsolete stem manifest')
    assets = [a for a in manifest['assets'] if a['role'] in STEMS]
    assets.append(manifest['intermediate'])
    names = [r + '.wav' for r in STEMS] + ['guitar.wav']
    if [a['relative_path'] for a in assets] != names:
        raise ValueError('Unexpected generated stem filename')
    return [{'name':a['relative_path'], 'sha256':a['file_sha256']} for a in assets], file_hash(manifest_path)


def _unlink(path):
    path.unlink()  # Exact validated generated WAV only; never a directory tree.


def _purge_reserved(project, separation, row, replacement, source_hash):
    library = separation.library
    root = _target(project, library, row)
    checked_tree(root, project)
    assets, manifest_hash = _assets(root, row, source_hash, project)
    folder = checked_path(library.root / 'retention', project)
    folder.mkdir(exist_ok=True)
    ledger = checked_path(folder / ('stem-purge-' + row['id'] + '.json'), project)
    if ledger.exists():
        entry = json.loads(ledger.read_text(encoding='utf-8'))
        if (entry.get('version') != 2 or entry.get('id') != row['id'] or entry.get('song_id') != row['song_id']
                or entry.get('path') != str(root) or entry.get('source_sha256') != source_hash
                or entry.get('assets') != assets or entry.get('manifest_sha256') != manifest_hash):
            raise ValueError('Purge journal identity changed; manual review required')
    else:
        if row['status'] != 'completed':
            raise ValueError('Interrupted purge has no durable journal')
        # Verify the complete plan before removing even its first file.
        for asset in assets:
            path = checked_path(root / asset['name'], project)
            if file_hash(path) != asset['sha256']:
                raise ValueError('Obsolete generated stem changed; retained')
        entry = {'version':2, 'id':row['id'], 'song_id':row['song_id'], 'path':str(root),
                 'source_sha256':source_hash, 'manifest_sha256':manifest_hash, 'assets':assets,
                 'replacement':replacement, 'phase':'prepared', 'removed':[]}
        _record(ledger, entry, project)
    # Missing files are accepted ONLY with the already-durable exact purge plan.
    entry['replacement'] = replacement
    with library.transaction() as db:
        db.execute("UPDATE separation_runs SET status='purging',stage='purging',error=? WHERE id=?",
                   ('Superseded generated audio; journal: ' + str(ledger), row['id']))
    removed_bytes = 0
    for asset in assets:
        path = checked_path(root / asset['name'], project)
        source = _source(project, library, row['song_id'])
        if file_hash(source) != source_hash:
            raise ValueError('Source changed during cleanup; remaining stems retained')
        active = library.db.execute('SELECT active_id FROM song_separations WHERE song_id=?', (row['song_id'],)).fetchone()
        if not active or active['active_id'] != replacement or row['id'] == replacement:
            raise ValueError('Active separation changed; cleanup stopped')
        if path.exists():
            if path.stat().st_nlink != 1 or file_hash(path) != asset['sha256']:
                raise ValueError('Generated stem changed or is hard-linked; cleanup stopped')
            size = path.stat().st_size
            _unlink(path)
            removed_bytes += size
        if asset['name'] not in entry['removed']:
            entry['removed'].append(asset['name'])
        entry['phase'] = 'purging'
        _record(ledger, entry, project)
    entry['phase'] = 'audio_removed'
    _record(ledger, entry, project)
    with library.transaction() as db:
        db.execute("UPDATE separation_runs SET status='purged',stage='purged',error=? WHERE id=?",
                   ('Superseded generated stems permanently removed; source and metadata retained. Journal: ' + str(ledger), row['id']))
    return {'id':row['id'], 'replacement':replacement, 'files':entry['removed'],
            'bytes_removed_this_attempt':removed_bytes, 'ledger':str(ledger)}


def committed_publication(library, song_id, expected_run_id):
    """Read publication through a separate connection; never commit caller work.

    The caller rejects pre-existing transactions before taking its retirement
    writer reservation. This reader observes only committed publication.
    """
    db = sqlite3.connect((library.root / 'library.sqlite3').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        row = db.execute(
            "SELECT r.* FROM song_separations s JOIN separation_runs r ON r.id=s.active_id "
            "WHERE s.song_id=? AND r.song_id=? AND r.id=? AND r.status='completed'",
            (song_id, song_id, expected_run_id)).fetchone()
        return dict(row) if row else None
    finally:
        db.close()


def _purge(project, separation, row, replacement, source_hash, readiness):
    library = separation.library
    # Python locks do not exclude a second SQLite connection/process. Reserve
    # the database writer before the final validation and hold it through every
    # unlink and status change. A durable exact-file journal survives rollback.
    with library.transaction(immediate=True):
        committed = committed_publication(library, row['song_id'], replacement)
        if not committed or committed['source_sha256'] != source_hash or row['id'] == replacement:
            raise ValueError('Committed publication changed before retirement')
        separation._verified.pop(replacement, None)
        state = separation.get_song_state(row['song_id'])
        playable = readiness(row['song_id'])
        if (not state.get('active') or state['active']['run_id'] != replacement
                or not playable.get('ready') or playable.get('active', {}).get('run_id') != replacement):
            raise ValueError('Replacement readiness changed before retirement')
        outcome = _purge_reserved(project, separation, row, replacement, source_hash)
    # Mark the journal committed only after the owning database commit succeeds.
    ledger = Path(outcome['ledger'])
    entry = json.loads(ledger.read_text(encoding='utf-8'))
    entry['phase'] = 'committed'
    _record(ledger, entry, project)
    separation._verified.pop(row['id'], None)
    return outcome


def prune_stem_history(project, separation, analysis=None, *, song_id=None, readiness=None):
    result = {'purged':[], 'kept':[], 'warning':None}
    if not ENABLED:
        return result
    if not song_id:
        raise ValueError('Retention requires one explicit song')
    library = separation.library
    project = Path(os.path.abspath(project))
    try:
        checked_path(library.root / 'retention', project)
        # Same lock order as playback; publication cannot change the active DB
        # pointer while this bounded file plan is being applied.
        with _song_lock(library, song_id), separation._verify_lock, library.lock:
            if library.db.in_transaction:
                result['warning'] = 'Stem cleanup deferred until the publication transaction commits.'
                return result
            rows = [dict(r) for r in library.db.execute(
                "SELECT * FROM separation_runs WHERE song_id=? AND status IN ('completed','purging','purged') ORDER BY rowid", (song_id,))]
            if len(rows) < 2:
                return result  # No journal or other writes for a sole live set.
            analysis = analysis or AnalysisStore(library)
            jobs = [json.loads(r[0]) for r in library.db.execute('SELECT snapshot FROM analysis_jobs')]
            if any(j.get('song_id') == song_id and j.get('kind') == 'analysis' and j.get('status') in ACTIVE for j in jobs):
                return result
            source_hash = file_hash(_source(project, library, song_id))
            active = library.db.execute('SELECT active_id FROM song_separations WHERE song_id=?', (song_id,)).fetchone()
            if not active:
                return result
            replacement = active['active_id']
            fresh = separation._run(replacement)
            if fresh['song_id'] != song_id or fresh['status'] != 'completed':
                raise ValueError('Replacement is not published')
            checked_tree(_target(project, library, fresh), project)
            separation._verified.pop(replacement, None)
            state = separation.get_song_state(song_id)
            playable = (readiness or PlaybackReadiness(analysis, separation).state)(song_id)
            if (not state.get('active') or not playable.get('ready')
                    or playable.get('active', {}).get('run_id') != replacement):
                result['kept'] = [r['id'] for r in rows]
                return result  # Partial replacement still needs old playback stems.
            committed = committed_publication(library, song_id, replacement)
            if (not committed or any(committed[key] != fresh[key]
                                     for key in ('folder', 'source_sha256', 'recipe_sha256'))
                    or committed['source_sha256'] != source_hash):
                result['kept'] = [r['id'] for r in rows]
                result['warning'] = 'Stem cleanup deferred: committed publication changed.'
                return result
            result['kept'] = [replacement]
            for row in rows:
                if row['id'] == replacement:
                    continue
                if row['status'] == 'purged':
                    # Complete a journal interrupted after DB commit, no deletion.
                    ledger = checked_path(library.root / 'retention' / ('stem-purge-' + row['id'] + '.json'), project)
                    if ledger.exists():
                        entry = json.loads(ledger.read_text(encoding='utf-8'))
                        if entry.get('phase') == 'committed':
                            continue
                    else:
                        raise ValueError('Purged row is missing its journal')
                result['purged'].append(_purge(project, separation, row, replacement, source_hash,
                    readiness or PlaybackReadiness(analysis, separation).state))
    except Exception as exc:
        result['warning'] = 'Stem cleanup stopped; source and active stems retained: ' + str(exc)
    return result
