"""Tidy songs made before jobs cleaned up after themselves. Runs when Chord Buddy starts, before any job can, and does nothing to a
song that is already tidy.

- A job's c folder (its temporary files and the caches the tools were given) is removed: nothing reads it once the job is over.
- A job's source.mp3 that is a separate copy of the song's recording becomes a hard link to it, so one copy on disk. One that
  differs (the song's recording was replaced since) is the recording that job worked from, and is kept as it is.
"""
import os
from .path_policy import drop_job_cache
from .recycle import checked_path
from .separation_contract import file_hash

JOB_KINDS = ('analysis', 'separation')


def _folders(library):
    for (name,) in library.db.execute('SELECT folder FROM songs ORDER BY folder').fetchall():   # trashed songs too
        try:
            yield library.contained(name)
        except ValueError:
            continue


def _jobs(song):
    for kind in JOB_KINDS:
        parent = song / kind
        if parent.is_dir() and not parent.is_symlink():
            for job in sorted(parent.iterdir()):
                if job.is_dir() and not job.is_symlink():
                    yield job


def _identity(info):
    return info.st_dev, info.st_ino


def tidy_library(project, library):
    """What was tidied: caches removed, copies of recordings linked, and the bytes that frees on disk."""
    report = {'caches': 0, 'cache_bytes': 0, 'linked': 0, 'freed': 0}
    copies = {}   # each copy's file on disk: (its names before, its size, how many of them were linked)
    for song in _folders(library):
        source, source_hash = song / 'source.mp3', None
        for job in _jobs(song):
            cache = job / 'c'
            if cache.is_dir():
                size = sum(p.stat().st_size for p in cache.rglob('*') if p.is_file() and not p.is_symlink())
                if drop_job_cache(project, job):
                    report['caches'] += 1
                    report['cache_bytes'] += size
            snapshot = job / 'source.mp3'
            temp = job / 'source.mp3.link'
            try:
                if not snapshot.is_file() or not source.is_file() or os.path.samefile(snapshot, source):
                    continue
                checked_path(snapshot, project)
                checked_path(source, project)
                info = snapshot.stat()
                if info.st_size != source.stat().st_size:
                    continue
                source_hash = source_hash or file_hash(source)
                if file_hash(snapshot) != source_hash:
                    continue
                os.link(source, temp)
                os.replace(temp, snapshot)
            except (OSError, ValueError):
                try:
                    temp.unlink(missing_ok=True)
                except OSError:
                    pass
                continue
            report['linked'] += 1
            names, size, linked = copies.get(_identity(info), (info.st_nlink, info.st_size, 0))
            copies[_identity(info)] = (names, size, linked + 1)
    report['freed'] = report['cache_bytes'] + sum(size for names, size, linked in copies.values() if linked == names)
    return report
