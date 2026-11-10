"""What goes with a song in its zip besides the recording and analysis: its own MIDI files, its own visual connections, its look and
other per-song preferences, and its saved arrangements. Shows, and the usual connections shared by every song, travel in a show's file.

Bringing these in only adds, like the rest of a song import: what is here already is never overwritten, and a bad item is left out, not fatal.
A failure here never undoes the song itself, which is already in. Everything is data; nothing in a zip is ever run.
"""
from __future__ import annotations
import json
import re

from .performance_store import PerformanceStore
from .visual_patches import VisualPatches

MAX_ARRANGEMENTS=200
MAX_REVISIONS=500
MIDI_INDEX='my-midi/index.json'
CUE_INDEX='my-cues/index.json'


class SongExtras:
    def __init__(self,app):
        self.library=app.library
        self.patches=getattr(app,'visual_patches',None) or VisualPatches(app.library)
        self.performances=getattr(app,'performances',None) or PerformanceStore(app.library)
        self.user_midi=getattr(app,'user_midi',None)
        self.cue_tracks=getattr(app,'cue_tracks',None)

    def _prefs(self,song_id):
        tail=':'+song_id
        return {k:v for k,v in self.library.read_prefs().items() if k.endswith(tail)}

    def gather(self,song_id):
        """For the manifest of a song zip. MIDI files go in the zip's file list instead (song_transfer.py)."""
        arrangements=[]
        for item in self.performances.performances_for_song(song_id):
            record=self.performances.performance(item['id'])
            revisions=[{'revision':n,'body':self.performances.performance(item['id'],n)['body']} for n in range(1,record['head']+1)]
            arrangements.append({'id':item['id'],'name':item['name'],'revisions':revisions,'draft':record['draft']})
        return {'patches':self.patches.read(song_id)['song'],'prefs':self._prefs(song_id),'arrangements':arrangements}

    def describe(self,extras,midi_files):
        extras=extras if isinstance(extras,dict) else {}
        count=lambda key:len(extras.get(key) or ())
        return {'midi':midi_files,'patches':count('patches'),'arrangements':count('arrangements')}

    def restore(self,song_id,extras,midi_items,old_id=None,cue=None):
        """Adds what isn't here yet. midi_items: [(index item, file bytes)]; cue: (index item, file bytes) or None. Returns how many of each came in, and how many were left out."""
        extras=extras if isinstance(extras,dict) else {}
        done={'midi':0,'patches':0,'prefs':0,'arrangements':0,'skipped':0}
        self._restore_midi(song_id,midi_items,done)
        if cue and self.cue_tracks is not None:
            added,skipped=self.cue_tracks.merge(song_id,*cue)
            done['cues']=added;done['skipped']+=skipped
        self._restore_patches(song_id,extras.get('patches'),done)
        self._restore_prefs(song_id,extras.get('prefs'),old_id,done)
        self._restore_arrangements(song_id,extras.get('arrangements'),done)
        return done

    def _restore_midi(self,song_id,items,done):
        if not items:return
        if self.user_midi is None:
            from .user_midi import UserMidi
            self.user_midi=UserMidi(self.library)
        added,skipped=self.user_midi.merge(song_id,items)
        done['midi']+=added;done['skipped']+=skipped

    def _restore_patches(self,song_id,patches,done):
        if not isinstance(patches,dict):return
        mine=self.patches.read(song_id)['song']
        for visual,patch in patches.items():
            if visual in mine:continue
            try:
                self.patches.save(visual,patch,song_id);done['patches']+=1
            except (ValueError,TypeError):
                done['skipped']+=1

    def _restore_prefs(self,song_id,prefs,old_id,done):
        if not isinstance(prefs,dict):return
        here=self.library.read_prefs();wanted={}
        for key,value in list(prefs.items())[:40]:
            if not isinstance(key,str) or ':' not in key:done['skipped']+=1;continue
            name=key.rsplit(':',1)[0]+':'+song_id          # always this song's key, whatever the file says
            if name not in here:wanted[name]=value
        if not wanted:return
        try:
            self.library.write_prefs(wanted);done['prefs']+=len(wanted)
        except ValueError:
            done['skipped']+=len(wanted)

    def _restore_arrangements(self,song_id,arrangements,done):
        if not isinstance(arrangements,list):return
        store=self.performances
        here={item['id']:item for item in store.performances_for_song(song_id)}
        for arrangement in arrangements[:MAX_ARRANGEMENTS]:
            try:
                revisions=arrangement['revisions']
                if not isinstance(revisions,list) or not revisions or len(revisions)>MAX_REVISIONS:raise ValueError('bad arrangement')
                ident=arrangement['id']
                last=revisions[-1]['body']
                content=lambda body:{k:v for k,v in body.items() if k not in ('id','name','songId')}
                if any(content(store.performance(i)['body'])==content(last) for i in here):continue   # already here, under any name: nothing to add
                if ident in here:
                    ident=store.new_id()                                                           # edited on both computers: keep both
                    suffix=' (imported)'
                else:
                    taken=self.library.db.execute('SELECT 1 FROM performances WHERE id=?',(ident,)).fetchone()
                    if taken:ident=store.new_id()
                    suffix=''
                with self.library.transaction(immediate=True):
                    for base,revision in enumerate(revisions):
                        body=dict(revision['body'],id=ident,songId=song_id)
                        if suffix:body['name']=str(body.get('name') or 'Arrangement')[:180]+suffix
                        store.save_performance(body,base)
                    draft=arrangement.get('draft')
                    if isinstance(draft,dict):store.save_performance_draft(dict(draft,id=ident,songId=song_id),len(revisions))
                done['arrangements']+=1
            except (KeyError,TypeError,ValueError,AttributeError):
                done['skipped']+=1


def cue_item_from(archive,manifest):
    """The song's cue track inside an open zip: (index item, bytes), or None."""
    by_path={f['path']:f for f in manifest.get('files',[])}
    index=by_path.get(CUE_INDEX)
    if not index or not index.get('zip'):return None
    try:
        item=json.loads(archive.read(index['zip']).decode('utf-8'))
        entry=by_path.get('my-cues/'+str(item.get('file') or ''))
        origin=by_path.get(entry['same']) if entry and entry.get('same') else entry
        if not origin or not origin.get('zip') or archive.getinfo(origin['zip']).file_size>250*1024*1024:return None
        return item,archive.read(origin['zip'])
    except (ValueError,KeyError,AttributeError,UnicodeDecodeError):
        return None


def midi_items_from(archive,manifest):
    """The song's MIDI files inside an open zip: [(index item, bytes)]. Anything the index doesn't name stays behind."""
    by_path={f['path']:f for f in manifest.get('files',[])}
    index=by_path.get(MIDI_INDEX)
    if not index or not index.get('zip'):return []
    try:
        listed=json.loads(archive.read(index['zip']).decode('utf-8')).get('files',[])
    except (ValueError,KeyError,AttributeError,UnicodeDecodeError):
        return []
    out=[]
    for item in listed if isinstance(listed,list) else []:
        if not isinstance(item,dict) or not re.fullmatch(r'[0-9a-f]{12}',str(item.get('id',''))):continue
        name=str(item.get('file') or '')
        entry=by_path.get('my-midi/'+name) or by_path.get('my-midi/'+item['id']+'.mid')
        if not entry:continue
        origin=by_path.get(entry['same']) if entry.get('same') else entry
        if not origin or not origin.get('zip'):continue
        try:
            info=archive.getinfo(origin['zip'])
            if info.file_size>16*1024*1024:continue
            out.append((item,archive.read(origin['zip'])))
        except KeyError:
            continue
    return out
