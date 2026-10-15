"""Lexical path safety; production recycling remains disabled."""
import os
from pathlib import Path


def checked_path(path, project):
    # Inspect original components before resolve() can erase junction identities.
    project = Path(os.path.abspath(project))
    path = Path(path)
    if '..' in path.parts:
        raise ValueError('Parent traversal is not allowed')
    path = Path(os.path.abspath(path))
    if path == project or not path.is_relative_to(project):
        raise ValueError('Recycle target must be a child of this project')
    current = project
    for part in path.relative_to(project).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue  # Needed to inspect interrupted operations with absent targets.
        if current.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Recycle target contains a link or reparse point')
    resolved = path.resolve()
    if not resolved.is_relative_to(project.resolve()):
        raise ValueError('Recycle target escapes project')
    return path


def checked_tree(path, project):
    path = checked_path(path, project)
    if path.is_dir():
        for base, dirs, files in os.walk(path, followlinks=False):
            for name in dirs + files:
                checked_path(Path(base) / name, project)
    return path


def recycle_project_path(path, project):
    checked_tree(path, project)
    raise OSError('Automatic recycling is disabled pending review and approval. Old stems are retained.')
