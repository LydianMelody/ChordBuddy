from __future__ import annotations
import json
import os
import re
import secrets
import threading

MAX_FILE=512*1024
MAX_PATCH=32*1024
MAX_CABLES=64
VISUAL_ID=re.compile(r'[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}')
SETTINGS={'decay','hold','threshold','min','max','invert','smooth'}
INPUT_KEY=re.compile(r'[A-Za-z][A-Za-z0-9_]{0,39}')


class VisualPatches:
    """The patch bay's saved patches (which sounds drive which parts of a visualization; the frontend's visual-patch.js), kept in one
    small file with the library: the usual patch for each visualization, and a song's own patches when it has some.
    {"usual": {visual id: patch}, "songs": {song id: {visual id: patch}}}; a patch is {"cables": [{"from", "to", ...settings}]}, and
    "inputs": the visualization's inputs when it was saved (so one it gains later starts on its default cable, not unplugged)."""
    def __init__(self,library):
        self.library=library
        self.path=library.root/'visual-patches.json'
        self.lock=threading.Lock()

    def _load(self):
        try:data=json.loads(self.path.read_text('utf-8'))
        except (OSError,ValueError):data={}
        if not isinstance(data,dict):data={}
        usual=data.get('usual') if isinstance(data.get('usual'),dict) else {}
        songs=data.get('songs') if isinstance(data.get('songs'),dict) else {}
        return {'usual':usual,'songs':{k:v for k,v in songs.items() if isinstance(v,dict)}}

    def _save(self,data):
        body=json.dumps(data,indent=1,allow_nan=False).encode('utf-8')
        if len(body)>MAX_FILE:raise ValueError('There are too many saved patches. Remove a few song patches first.')
        temp=self.path.with_name(self.path.name+'.'+secrets.token_hex(3)+'.tmp')   # a crash never leaves half a file under the real name
        try:
            temp.write_bytes(body);os.replace(temp,self.path)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def clean(patch):
        """A patch from the frontend, checked: only cables with known settings of the right kind. The frontend cleans it again on use."""
        if not isinstance(patch,dict) or not isinstance(patch.get('cables'),list):raise ValueError('Expected a patch with cables')
        if len(patch['cables'])>MAX_CABLES:raise ValueError('A patch can have at most 64 cables')
        cables=[]
        for cable in patch['cables']:
            if not isinstance(cable,dict):raise ValueError('Each cable must be an object')
            source,target=cable.get('from'),cable.get('to')
            if not isinstance(source,str) or not isinstance(target,str) or not 0<len(source)<=300 or not 0<len(target)<=80:raise ValueError('Each cable needs a source and an input')
            out={'from':source,'to':target}
            for key in SETTINGS&set(cable):
                value=cable[key]
                if key=='invert':
                    if not isinstance(value,bool):raise ValueError('invert must be true or false')
                elif isinstance(value,bool) or not isinstance(value,(int,float)) or value!=value or abs(value)>1000:raise ValueError(f'{key} must be a number')
                out[key]=value
            if 'fit' in cable:   # the part of a MIDI signal used as its full range: [low, high], levels -1..1 or MIDI notes 0..127
                fit=cable['fit']
                if not isinstance(fit,list) or len(fit)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or v!=v or not -1<=v<=127 for v in fit) or fit[1]<=fit[0]:
                    raise ValueError('fit must be a low and a high value')
                out['fit']=[fit[0],fit[1]]
            if 'outside' in cable:   # past the range: 'clip' (held at the edge) or 'drop' (left out)
                if cable['outside'] not in ('clip','drop'):raise ValueError('outside must be clip or drop')
                out['outside']=cable['outside']
            cables.append(out)
        result={'cables':cables}
        if 'inputs' in patch:
            inputs=patch['inputs']
            if not isinstance(inputs,list) or len(inputs)>MAX_CABLES or not all(isinstance(k,str) and INPUT_KEY.fullmatch(k) for k in inputs):
                raise ValueError('inputs must be a list of input names')
            result['inputs']=list(dict.fromkeys(inputs))
        if len(json.dumps(result).encode('utf-8'))>MAX_PATCH:raise ValueError('That patch is too large')
        return result

    def read(self,song_id=None):
        """The usual patches, and the open song's own: {"usual": {...}, "song": {...}}."""
        if song_id:self.library.validate_song_paths(song_id)
        with self.lock:
            data=self._load()
            return {'usual':data['usual'],'song':data['songs'].get(song_id,{}) if song_id else {}}

    def save(self,visual,patch,song_id=None):
        """Saves (or with patch None, removes) a visualization's usual patch, or a song's own patch for it. Returns read(song_id)."""
        if not isinstance(visual,str) or not VISUAL_ID.fullmatch(visual):raise ValueError('Unknown visualization')
        if song_id is not None:
            if not isinstance(song_id,str):raise ValueError('Unknown song')
            self.library.validate_song_paths(song_id)
        patch=None if patch is None else self.clean(patch)
        with self.lock:
            data=self._load()
            place=data['usual'] if song_id is None else data['songs'].setdefault(song_id,{})
            if patch is None:place.pop(visual,None)
            else:place[visual]=patch
            if song_id is not None and not data['songs'][song_id]:del data['songs'][song_id]
            self._save(data)
        return self.read(song_id)
