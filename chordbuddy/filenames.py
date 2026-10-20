"""Safe file names for things Chord Buddy saves or offers for download."""
import re

_DEVICES = re.compile(r'(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])')


def safe_stem(text, fallback='Chord Buddy', limit=120):
    """A name that is fine on Windows: no path characters, no trailing dots or spaces, and never a device name such as CON or NUL."""
    name = ' '.join(re.sub(r'[\/:*?"<>|\x00-\x1f]+', ' ', str(text or '')).split())[:limit].rstrip(' .')
    if not name:
        name = fallback
    if _DEVICES.fullmatch(name.split('.')[0].strip()):
        name = '_' + name
    return name


def unique(names):
    """The same names, with a number added to any that would clash (zip entries, case-insensitively)."""
    seen, result = set(), []
    for name in names:
        stem, dot, ext = name.rpartition('.')
        candidate, n = name, 1
        while candidate.lower() in seen:
            n += 1
            candidate = f'{stem} ({n}).{ext}' if dot else f'{name} ({n})'
        seen.add(candidate.lower())
        result.append(candidate)
    return result
