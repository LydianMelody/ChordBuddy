"""Is there a newer Chord Buddy? Only ever asked when someone chooses Check for updates. It reads one short file from the project's public page and
compares version numbers. It sends nothing about this computer or its songs, and never downloads or installs anything: it only says what it found.
"""
from __future__ import annotations
from pathlib import Path
import re
import urllib.error
import urllib.request

LATEST_URL='https://raw.githubusercontent.com/LydianMelody/ChordBuddy/main/VERSION'
PAGE_URL='https://github.com/LydianMelody/ChordBuddy'
VERSION_FILE=Path(__file__).resolve().parent.parent/'VERSION'
MAX_BYTES=64
TIMEOUT=8
VERSION=re.compile(r'\d{1,6}(?:\.\d{1,6}){0,3}')


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None                                     # the address is fixed: being sent somewhere else is a failure, not a place to go


def _fetch(url):
    opener=urllib.request.build_opener(_NoRedirects)
    request=urllib.request.Request(url,headers={'User-Agent':'ChordBuddy-update-check'})
    with opener.open(request,timeout=TIMEOUT) as response:
        return response.read(MAX_BYTES+1)


def parse(text):
    """A version as numbers to compare, or None for anything else."""
    text=str(text).strip()
    if not VERSION.fullmatch(text):return None
    numbers=[int(part) for part in text.split('.')]
    return tuple(numbers+[0]*(4-len(numbers)))


def current_version(path=VERSION_FILE):
    try:
        text=Path(path).read_text('utf-8').strip()
    except OSError:
        return None
    return text if parse(text) else None


def check(fetch=_fetch,current=None):
    """{state: 'newer'|'current'|'none'|'unknown', current, latest, page, reason}. Never raises: not being able to check is an answer."""
    here=current if current is not None else current_version()
    result={'state':'unknown','current':here,'latest':None,'page':PAGE_URL,'reason':None}
    try:
        data=fetch(LATEST_URL)
    except urllib.error.HTTPError as exc:
        if exc.code==404:
            result.update(state='none',reason='No version has been published yet.')
        else:
            result['reason']='The update page didn’t answer properly.'
        return result
    except (OSError,ValueError):
        result['reason']='Couldn’t reach the update page. Check your internet connection.'
        return result
    if not isinstance(data,bytes) or len(data)>MAX_BYTES:
        result['reason']='The update page sent something unexpected.'
        return result
    try:
        latest=data.decode('ascii').strip()
    except UnicodeDecodeError:
        latest=''
    theirs,mine=parse(latest),parse(here) if here else None
    if theirs is None:
        result['reason']='The update page sent something unexpected.'
        return result
    result['latest']=latest
    if mine is None:
        result['state']='newer'
        result['reason']='This copy doesn’t say which version it is.'
    else:
        result['state']='newer' if theirs>mine else 'current'
    return result
