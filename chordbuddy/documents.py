"""Versioned, independent transcription documents with durable Undo/Redo."""
from __future__ import annotations

import json
import copy
import math
from pathlib import Path
import re
import uuid
from .path_policy import validate_paths, PathBudgetError
import time

import io
import zipfile
from .filenames import safe_stem, unique
from .midi import read_midi, validate_midi, write_midi, split_tracks
from .chords import chord_label
from .chart import seed_chart,validate_chart
from .music import read_music
from .timing_layout import remap_layout
from .library import validate_song_metadata
from .timing_store import TimingStore
from .analysis_contract import digest
from .separation_contract import file_hash
from .music import project_timing


class RevisionConflict(ValueError):
    pass


def abc_tokens(abc):
    tokens=[]
    offset=0
    for line in abc.splitlines(keepends=True):
        if not re.match(r'^\s*[A-Za-z]:',line):
            for match in re.finditer(r'"([^"\r\n]*)"|%[^\r\n]*',line):
                label=match.group(1)
                if label is None:
                    break
                if label and not label.startswith(('^','_','<','>','@')):
                    tokens.append((offset+match.start(),label))
        offset+=len(line)
    return tokens


def timed_chords(run_dir,duration):
    path=run_dir/'events.json'
    if not path.exists():
        return []
    payload=json.loads(path.read_text(encoding='utf-8'))
    events=payload.get('events',[]) if isinstance(payload,dict) else payload
    if not isinstance(events,list):
        return []
    valid=[]
    for event in events:
        if not isinstance(event,dict) or not isinstance(event.get('values'),dict):
            continue
        value,start=event['values'].get('chord'),event.get('time')
        if isinstance(value,str) and type(start) in (int,float) and math.isfinite(start) and 0<=start<duration:
            valid.append((float(start),chord_label(value)))
    rows=[]
    for start,label in sorted(valid,key=lambda row:row[0]):
        if rows and rows[-1]['start']==start:
            rows.pop()
        if rows and rows[-1]['label']==label:
            continue
        rows.append({'id':f'c{len(rows)}','start':start,'end':duration,'label':label,'abc_index':None})
    for i,row in enumerate(rows[:-1]):
        row['end']=rows[i+1]['start']
    return [r for r in rows if 0<=r['start']<r['end']]


def link_chords(abc,chords):
    """Conservative sequential matching: never attach an unrelated chord token."""
    tokens=abc_tokens(abc)
    cursor=0
    linked=[]
    for chord in chords:
        chord=dict(chord,abc_index=None)
        for i in range(cursor,len(tokens)):
            offset,label=tokens[i]
            if label==chord['label']:
                chord['abc_index']=offset
                cursor=i+1
                break
        linked.append(chord)
    return linked


def apply_chord_overrides(chords, overrides):
    """Overlay explicit time ranges, splitting only the affected intervals."""
    if not isinstance(overrides,list) or not overrides: return [dict(c) for c in chords]
    result=[]
    for chord in chords:
        if not isinstance(chord,dict): continue
        start,end=chord.get('start'),chord.get('end')
        if type(start) not in (int,float) or type(end) not in (int,float) or end<=start:
            result.append(dict(chord)); continue
        cuts={float(start),float(end)}
        for item in overrides:
            if item['end']>start and item['start']<end:
                cuts.update((max(start,item['start']),min(end,item['end'])))
        cuts=sorted(cuts)
        for i,(left,right) in enumerate(zip(cuts,cuts[1:])):
            value=dict(chord,start=left,end=right)
            chosen=next((item for item in overrides if item['start']<right and item['end']>left),None)
            if chosen: value['label']=chosen['label']; value['confirmed']=True; value['override_id']=chosen['id']
            if i: value['id']=f"{chord.get('id','chord')}:override:{i}"
            result.append(value)
    merged=[]
    for value in result:
        previous=merged[-1] if merged else None
        same_override=(previous and previous.get('override_id') and previous.get('override_id')==value.get('override_id')
                       and abs(previous['end']-value['start'])<1e-8)
        unanchored=not any(item.get(field) is not None for item in (previous,value) for field in ('line','offset')) if previous else False
        if same_override and unanchored:
            previous['end']=value['end']
            previous['id']=previous['override_id']
            if previous.get('abc_index') is None and value.get('abc_index') is not None:
                previous['abc_index']=value['abc_index']
        else:
            merged.append(value)
    return merged


def apply_chart_metadata(content, metadata, music=None):
    import copy
    value=copy.deepcopy(content)
    overrides=metadata.get('chord_overrides',[]) if isinstance(metadata,dict) else []
    value['chords']=apply_chord_overrides(value.get('chords',[]),overrides)
    # A split chord inherits its section and any explicit lyric placement only
    # on the first segment; later segments have no guessed lyric anchor.
    for chord in value['chords']:
        chord.setdefault('section_id', next((s['id'] for s in value.get('sections',[]) if s['start']<=chord['start']<s['end']), None))
        chord.setdefault('line',None); chord.setdefault('offset',None)
    return validate_chart(value, value.get('duration', 0), music)


class DocumentStore:
    def __init__(self,library):
        self.library=library
        self.timing=TimingStore(library)

    def _row(self,document_id):
        row=self.library.db.execute('SELECT * FROM documents WHERE id=?',(document_id,)).fetchone()
        if row is None:
            raise KeyError('Document not found')
        return dict(row)

    def _get(self,document_id):
        db=self.library.db
        row=self._row(document_id)
        edits=db.execute('SELECT position,label FROM edits WHERE document_id=? ORDER BY position',(document_id,)).fetchall()
        payload=db.execute('SELECT content FROM edits WHERE document_id=? AND position=?',(document_id,row['cursor'])).fetchone()
        baseline=db.execute('SELECT content FROM edits WHERE document_id=? AND position=0',(document_id,)).fetchone()
        kept=bool(db.execute('SELECT 1 FROM retained_documents WHERE document_id=? AND run_id=?',(document_id,self.library.song(row['song_id'])['active_run'])).fetchone())
        result={'id':document_id,'name':row['name']+(' · kept edits' if kept else ''),'kind':row['kind'],'content':json.loads(payload['content']),
                'run_id':row['run_id'],'song_id':row['song_id'],'kept':kept,'user_modified':json.loads(payload['content'])!=json.loads(baseline['content']),
                'revision':row['revision'],'can_undo':row['cursor']>0,'can_redo':row['cursor']<len(edits)-1,
                'undo_label':edits[row['cursor']]['label'] if row['cursor'] else '',
                'redo_label':edits[row['cursor']+1]['label'] if row['cursor']<len(edits)-1 else ''}

        if row['kind']=='chart':
            result['timing_binding']=self.timing.binding(document_id,row['cursor'])
            result['user_modified']=result['user_modified'] or result['timing_binding']!=self.timing.binding(document_id,0)
        if row['kind'] in ('chart','abc'): result['music']=self._music(row)
        # Derive export status from the authoritative content, so a reload cannot
        # forget a committed edit whose optional file export failed. No DB migration.
        try:
            destination=self._export_destination(row)
            validate_paths([destination,destination.with_name(destination.name+'.partial')])
            if row['cursor']>0 or destination.exists():
                if not destination.exists() or destination.read_bytes()!=self._export_payload(row,result['content']):
                    result['export_warning']='Edit saved; exported file is out of date. Retry export.'
        except (OSError,PathBudgetError) as exc:
            result['export_warning']=f'Edit saved; exported file could not be checked: {exc}'
        return result

    def _music(self,row,timing=None):
        song=self.library.song(row['song_id'])
        run=self.library.contained(Path(song['folder'])/'runs'/row['run_id'])
        settings=self.library.read_settings()
        metadata=self.library.song_metadata(song['id'])
        if row['kind']=='chart' and timing is None:
            binding=self.timing.binding(row['id'],row['cursor'])
            raw=read_music(run,song['duration'],binding['overrides'],settings.get('beat_remove_threshold',0))
            if not binding['version_id'].startswith('legacy:'):
                return project_timing(raw,self.timing.version(binding['version_id']),binding['overrides'])
            return raw
        return read_music(run,song['duration'],metadata.get('timing') if timing is None else timing,settings.get('beat_remove_threshold',0))

    def revision_stamp(self,document_id,verify_source=True):
        with self.library.lock:
            row=self._row(document_id)
            return {'document_id':document_id,'document_revision':row['revision'],
                    'source_sha256':file_hash(self.library.source_path(row['song_id'])) if verify_source else None,
                    'transcription_id':row['run_id'],'binding_digest':digest(self.timing.binding(document_id,row['cursor']))}

    def rhythm_snapshot(self,document_id):
        with self.library.lock:
            doc=self._get(document_id);stamp=self.revision_stamp(document_id)
            if doc['revision']!=stamp['document_revision'] or digest(doc['timing_binding'])!=stamp['binding_digest']:
                raise RevisionConflict('Chart changed while preparing timing; refresh the preview.')
            return doc,stamp

    def preview_cleanup(self,document_id):
        from .separation_store import SeparationStore
        from .chart import seed_sections
        from .chart_cleanup import terminal_artifact_patch
        with self.library.lock:
            doc=self._get(document_id)
            if doc['kind']!='chart':raise ValueError('Choose a Song chart')
            baseline=json.loads(self.library.db.execute('SELECT content FROM edits WHERE document_id=? AND position=0',(document_id,)).fetchone()[0])
            source_hash=file_hash(self.library.source_path(doc['song_id']))
            if self.library.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_stages'").fetchone():
                for stage in self.library.db.execute("SELECT manifest,reference FROM analysis_stages WHERE song_id=? AND kind='transcription'",(doc['song_id'],)).fetchall():
                    value=json.loads(stage['manifest']);ref=json.loads(stage['reference'])
                    if value.get('run_id')!=doc['run_id']:continue
                    if ref['source_sha256']!=source_hash or digest(value)!=ref['manifest_sha256']:
                        return {'available':False,'reason':'Transcription source provenance does not match this recording'}
                    try:
                        if any(file_hash(self.library.contained(a['path']))!=a['sha256'] for a in value['assets']):raise ValueError('Changed transcription artifact')
                    except (OSError,ValueError):return {'available':False,'reason':'Transcription artifacts no longer match their source evidence'}
            store=SeparationStore(self.library);state=store.get_song_state(doc['song_id'])
            if not state['active']:return {'available':False,'reason':'Canonical EOF evidence unavailable'}
            root,manifest=store.get_published_run(state['active']['run_id'])
            song=self.library.song(doc['song_id']);run=self.library.contained(Path(song['folder'])/'runs'/doc['run_id'])
            structure=run/'structure.lab'
            try:
                lines=[line.split(None,2) for line in structure.read_text(encoding='utf-8').splitlines() if line.strip()]
                endpoint=max(float(line[1]) for line in lines)
                generated=seed_sections(run,song['duration'])
            except (OSError,ValueError,IndexError):return {'available':False,'reason':'Structure provenance unavailable'}
            tail=baseline['sections'][-1]
            proven=bool(generated and generated[-1]==tail and tail['name']=='Instrumental' and tail['start']==endpoint)
            evidence={'source_sha256':source_hash,'canonical_source_sha256':manifest['source_sha256'],'canonical_frames':manifest['frames'],
                      'canonical_rate':manifest['sample_rate'],'model_rate':24000,'generated_gap_id':tail['id'] if proven else None,'structure_end':endpoint}
            patch=terminal_artifact_patch(doc['content'],baseline,evidence)
            return {'available':bool(patch),'stamp':self.revision_stamp(document_id),'patch':patch,'evidence':evidence}

    def apply_cleanup(self,document_id,preview,revision):
        with self.library.lock:
            current=self.preview_cleanup(document_id)
            if not current.get('available') or current['stamp']!=preview.get('stamp') or current['stamp']['document_revision']!=revision:raise RevisionConflict('Cleanup preview changed; refresh before applying')
            return self.save_bound_chart(document_id,current['patch']['content'],self.get(document_id)['timing_binding'],current['patch']['label'],current['stamp'])

    def timing_version(self,document):
        stamp=self.revision_stamp(document['id'])
        bars=document['music']['measures']
        return {'source_sha256':stamp['source_sha256'],'transcription_id':stamp['transcription_id'],
                'drums_ref':None,'algorithm':'original','settings':{},'bars':bars,'baseline_bars':copy.deepcopy(bars),
                'beats':[t for bar in bars for t in bar['beats']],
                'correspondence':{bar['id']:bar['id'] for bar in bars},'diagnostics':{}}

    def set_chart_timing(self,document_id,timing,revision):
        with self.library.lock:
            row=self._row(document_id);doc=self._get(document_id)
            if row['kind']!='chart':raise ValueError('Choose a Song chart')
            if type(revision) is not int or revision!=doc['revision']:raise RevisionConflict('Chart changed; reload timing controls')
            clean=validate_song_metadata({'timing':timing,'chord_overrides':[]})['timing']
            music=self._music(row,clean);updated=remap_layout(doc['content'],doc['music'],music)
            version=self.timing_version(dict(doc,music=music));version['algorithm']='manual-tempo'
            binding={'version_id':self.timing.put_version(version),'overrides':clean}
            return self.save_bound_chart(document_id,updated,binding,'Chart timing',self.revision_stamp(document_id))

    def save_bound_chart(self,document_id,content,binding,label,stamp,*,verify_source=True):
        with self.library.transaction() as db:
            row=self._row(document_id)
            if row['kind']!='chart':raise ValueError('Choose a Song chart')
            if self.revision_stamp(document_id,verify_source=verify_source)!=stamp:raise RevisionConflict('Chart or source changed. Refresh the preview before applying.')
            previous=self._get(document_id)
            if not verify_source and binding!=previous['timing_binding']:raise ValueError('A timing change requires source validation')
            if binding['version_id'].startswith('legacy:'):
                music=self._music(row,binding['overrides'])
            else:
                version=self.timing.version(binding['version_id'])
                if (verify_source and version['source_sha256']!=stamp['source_sha256']) or version['transcription_id']!=row['run_id']:raise ValueError('Timing belongs to another source or transcription')
                music=project_timing(previous['music'],version,binding['overrides'])
            content=validate_chart(content,previous['content']['duration'],music)
            if content==previous['content'] and binding==previous['timing_binding']:return previous
            self.timing.record_binding(db,document_id,row['cursor'],previous['timing_binding'])
            db.execute('DELETE FROM edits WHERE document_id=? AND position>?',(document_id,row['cursor']))
            db.execute('DELETE FROM timing_bindings WHERE document_id=? AND position>?',(document_id,row['cursor']))
            db.execute('INSERT INTO edits VALUES(?,?,?,?)',(document_id,row['cursor']+1,json.dumps(content,allow_nan=False),label))
            self.timing.record_binding(db,document_id,row['cursor']+1,binding)
            db.execute('UPDATE documents SET cursor=cursor+1,revision=revision+1 WHERE id=?',(document_id,))
        return self._saved(document_id)

    def get(self,document_id):
        with self.library.lock:
            return self._get(document_id)

    def for_song(self,song_id):
        with self.library.transaction():
            run=self.library.song(song_id)['active_run']
            if run:
                self._ensure_chart(song_id,run)
            return [{k:v for k,v in self._get(identifier).items() if k not in ('content','music')}
                    for identifier in self._run_document_ids(song_id,run)]

    def _run_document_ids(self,song_id,run):
        return [r['id'] for r in self.library.db.execute("""SELECT id FROM documents WHERE song_id=? AND
            (run_id=? OR id IN (SELECT document_id FROM retained_documents WHERE run_id=?))
            ORDER BY CASE kind WHEN 'chart' THEN 0 WHEN 'abc' THEN 1 WHEN 'midi' THEN 2 ELSE 3 END,
            CASE WHEN run_id=? THEN 0 ELSE 1 END,name,id""",(song_id,run,run,run))]

    def has_user_changes(self,song_id):
        with self.library.lock:
            return any(d['user_modified'] for d in self.for_song(song_id))

    def _retain_edits(self,song_id,run_id,previous_run):
        db=self.library.db
        if not db.execute('SELECT 1 FROM runs WHERE song_id=? AND id=?',(song_id,previous_run)).fetchone():
            raise ValueError('Previous run is not registered for this song')
        for identifier in self._run_document_ids(song_id,previous_run):
            if self._row(identifier)['run_id']!=run_id and self._get(identifier)['user_modified']:
                db.execute('INSERT OR IGNORE INTO retained_documents VALUES(?,?)',(run_id,identifier))

    def freeze_active_timing(self,song_id):
        """Capture only the proven current legacy position before active-run changes."""
        db=self.library.db;active=self.library.song(song_id)['active_run']
        for row in db.execute("SELECT id,cursor FROM documents WHERE song_id=? AND run_id=? AND kind='chart'",(song_id,active)).fetchall():
            binding=self.timing.binding(row['id'],row['cursor'])
            self.timing.record_binding(db,row['id'],row['cursor'],binding)

    def select_cached_run(self,song_id,run_id):
        with self.library.transaction() as db:
            previous=self.library.song(song_id)['active_run']
            if previous==run_id:return
            if not db.execute("SELECT 1 FROM runs WHERE id=? AND song_id=? AND status IN ('complete','completed')",(run_id,song_id)).fetchone():raise ValueError('Cached transcription is not completed')
            self.freeze_active_timing(song_id)
            if previous:self._retain_edits(song_id,run_id,previous)
            db.execute("UPDATE songs SET active_run=?,status='completed',error=NULL WHERE id=?",(run_id,song_id))

    def _ensure_chart(self,song_id,run_id):
        db=self.library.db
        existing=db.execute("SELECT id FROM documents WHERE song_id=? AND run_id=? AND kind='chart'",(song_id,run_id)).fetchone()
        if existing:
            return existing['id']
        if not db.execute('SELECT id FROM runs WHERE id=? AND song_id=?',(run_id,song_id)).fetchone():
            raise ValueError('Run is not registered')
        song=self.library.song(song_id)
        run_dir=self.library.contained(Path(song['folder'])/'runs'/run_id)
        score=db.execute("SELECT id FROM documents WHERE song_id=? AND run_id=? AND kind='abc' ORDER BY CASE name WHEN 'score.abc' THEN 0 ELSE 1 END,name",(song_id,run_id)).fetchone()
        chords=self._get(score['id'])['content'].get('chords',[]) if score else []
        if not chords:
            try:
                chords=timed_chords(run_dir,song['duration'])
            except (ValueError,TypeError,OSError):
                chords=[]
        chords=apply_chord_overrides(chords,self.library.song_metadata(song_id).get('chord_overrides',[]))
        content=seed_chart(run_dir,song['duration'],chords)
        identifier=uuid.uuid4().hex
        # The immutable baseline is edit zero in SQLite. A nominal derived
        # path keeps this new document separate from every inference original.
        original_path=str((run_dir/'derived'/'Song chart.json').relative_to(self.library.root))
        db.execute('INSERT INTO documents(id,song_id,run_id,name,kind,original_path) VALUES(?,?,?,?,?,?)',
                   (identifier,song_id,run_id,'Song chart.json','chart',original_path))
        db.execute('INSERT INTO edits VALUES(?,?,?,?)',(identifier,0,json.dumps(content,allow_nan=False),'Original song chart'))
        return identifier

    def song_detail(self,song_id):
        with self.library.lock:
            song=self.library.song(song_id)
            docs=self.for_song(song_id)
            # the chart with kept edits over the blank one a newer analysis added
            score=(next((d for d in docs if d['kind']=='chart' and d['kept']),None) or next((d for d in docs if d['kind']=='chart'),None)
                   or next((d for d in docs if d['kind']=='abc'),None))
            if score:
                chords=self._get(score['id'])['content']['chords']
            elif song['active_run']:
                chords=timed_chords(self.library.folder(song_id)/'runs'/song['active_run'],song['duration'])
            else:
                chords=[]
            return {'song':song,'metadata':self.library.song_metadata(song_id),'documents':docs,'chords':chords,'runs':self.library.runs(song_id)}

    def ingest(self,song_id,run_dir,status,error):
        run_dir=Path(run_dir).resolve()
        with self.library.transaction() as db:
            song=self.library.song(song_id)
            expected=(self.library.folder(song_id)/'runs'/run_dir.name).resolve()
            if run_dir != expected or not run_dir.is_relative_to(self.library.root):
                raise ValueError('Invalid run directory')
            run=db.execute('SELECT id FROM runs WHERE id=? AND song_id=?',(run_dir.name,song_id)).fetchone()
            if run is None:
                raise ValueError('Run is not registered')
            try:
                chords=timed_chords(run_dir,song['duration'])
            except (ValueError,TypeError,KeyError):
                chords=[]
            problems=[]
            # Expose each user-readable upstream output, including annotations.
            for path in sorted(run_dir.rglob('*')):
                relative=path.relative_to(run_dir)
                if path.is_symlink() or not path.is_file() or any(part in ('edited','unfiltered') for part in relative.parts) or relative.as_posix() in ('confidence.json','run-options.json') or path.suffix.lower() not in ('.abc','.mid','.json','.lab','.txt','.tsv') or path.stat().st_size>20*1024*1024:
                    continue
                if not path.resolve().is_relative_to(run_dir):
                    continue
                name=relative.as_posix()
                if db.execute('SELECT 1 FROM documents WHERE run_id=? AND name=?',(run_dir.name,name)).fetchone():
                    continue
                kind={'.abc':'abc','.mid':'midi'}.get(path.suffix.lower(),'text')
                try:
                    if kind=='abc':
                        abc=path.read_text(encoding='utf-8')
                        content={'abc':abc,'chords':apply_chord_overrides(link_chords(abc,chords),self.library.song_metadata(song_id).get('chord_overrides',[]))}
                    elif kind=='midi':
                        content=read_midi(path)
                    else:
                        content={'text':path.read_text(encoding='utf-8')}
                    doc_id=uuid.uuid4().hex
                    db.execute('INSERT INTO documents(id,song_id,run_id,name,kind,original_path) VALUES(?,?,?,?,?,?)',
                               (doc_id,song_id,run_dir.name,name,kind,str(path.relative_to(self.library.root))))
                    db.execute('INSERT INTO edits VALUES(?,?,?,?)',(doc_id,0,json.dumps(content,allow_nan=False),'Original transcription'))
                except (ValueError,TypeError,OSError,EOFError) as exc:
                    problems.append(f'{name}: {exc}')
            if problems:
                error='; '.join(([error] if error else [])+problems)
                status='partial'
            if db.execute('SELECT 1 FROM documents WHERE run_id=?',(run_dir.name,)).fetchone():
                self._ensure_chart(song_id,run_dir.name)
            options_path=run_dir/'run-options.json'
            if status in ('complete','completed'):self.freeze_active_timing(song_id)
            if status in ('complete','completed') and options_path.is_file():
                options=json.loads(options_path.read_text(encoding='utf-8'))
                if options.get('edit_policy')=='keep' and options.get('previous_run'):
                    self._retain_edits(song_id,run_dir.name,options['previous_run'])
            replace_success=(status in ('complete','completed') and options_path.is_file() and
                             json.loads(options_path.read_text(encoding='utf-8')).get('edit_policy')=='replace')
            self.library.finish_run(song_id,run_dir.name,status,error,clear_metadata=replace_success)

    def apply_song_metadata(self, song_id, value, revision=None):
        """Persist metadata and materialize explicit chord edits in active docs."""
        with self.library.transaction() as db:
            cleaned=validate_song_metadata(value)
            previous=self.library.song_metadata(song_id)
            if revision is not None and (type(revision) is not int or revision!=previous['revision']):
                raise ValueError('Song metadata changed. Reload it before editing again.')
            active=self.library.song(song_id).get('active_run')
            pending=[]
            bindings={}
            if active:
                rows=[self._row(identifier) for identifier in self._run_document_ids(song_id,active)]
                for row in rows:
                    if row['kind'] not in ('chart','abc'): continue
                    current=self._get(row['id'])['content']
                    updated=dict(current)
                    if row['kind']=='chart':
                        old_binding=self.timing.binding(row['id'],row['cursor'])
                        self.timing.record_binding(db,row['id'],row['cursor'],old_binding)
                        music=self._music(row,cleaned['timing']) if previous.get('timing')!=cleaned['timing'] else self._music(row)
                        if previous.get('timing')!=cleaned['timing']:
                            updated=remap_layout(current,self._music(row),music)
                        updated=apply_chart_metadata(updated,cleaned,music)
                        if previous.get('timing')!=cleaned['timing']:
                            bindings[row['id']]={'version_id':'legacy:'+row['run_id'],'overrides':cleaned['timing'],'legacy_provenance_known':True}
                        else:bindings[row['id']]=old_binding
                    else:
                        updated=dict(current,chords=apply_chord_overrides(current.get('chords',[]),cleaned['chord_overrides']))
                    if updated==current and (row['kind']!='chart' or bindings[row['id']]==old_binding): continue
                    pending.append((row,json.dumps(updated,allow_nan=False)))
            db.execute('INSERT OR REPLACE INTO song_metadata(song_id,metadata,metadata_revision) VALUES(?,?,?)',
                       (song_id,json.dumps(cleaned,allow_nan=False,separators=(',',':')),previous['revision']+1))
            for row,payload in pending:
                db.execute('DELETE FROM edits WHERE document_id=? AND position>?',(row['id'],row['cursor']))
                if row['kind']=='chart':
                    db.execute('DELETE FROM timing_bindings WHERE document_id=? AND position>?',(row['id'],row['cursor']))
                    self.timing.record_binding(db,row['id'],row['cursor']+1,bindings[row['id']])
                db.execute('INSERT INTO edits VALUES(?,?,?,?)',(row['id'],row['cursor']+1,payload,'Song metadata'))
                db.execute('UPDATE documents SET cursor=cursor+1,revision=revision+1 WHERE id=?',(row['id'],))
        return self.library.song_metadata(song_id)

    def start_chord_at_measure(self, song_id, chord_id, measure_id, revision=None, document_id=None):
        """Confirm a selected chord across a preceding no-chord span in its bar."""
        with self.library.lock:
            metadata=self.library.song_metadata(song_id)
            if revision is not None and revision!=metadata['revision']:
                raise ValueError('Song metadata changed. Reload it before editing again.')
            if document_id:
                row=self._row(document_id)
                if row['song_id']!=song_id or row['kind']!='chart':
                    raise ValueError('Choose a chart chord to start at a barline.')
            else:
                active=self.library.song(song_id).get('active_run')
                candidate=self.library.db.execute("SELECT id FROM documents WHERE song_id=? AND run_id=? AND kind='chart'",(song_id,active)).fetchone()
                if candidate is None:
                    raise ValueError('No active chart is available.')
                row=self._row(candidate['id'])
            content=self._get(row['id'])['content']
            measures=[dict(item) for item in self._music(row).get('measures',[])]
            indices={item['id']:index for index,item in enumerate(measures)}
            for item in content.get('layout',{}).get('bar_overrides',[]):
                index=indices.get(item.get('id'))
                if index is not None and index>0 and type(item.get('start')) in (int,float):
                    measures[index]['start']=item['start']; measures[index-1]['end']=item['start']
            measure=next((item for item in measures if item['id']==measure_id),None)
            chord=next((item for item in content.get('chords',[]) if item.get('id')==chord_id),None)
            def no_chord(label):
                normalized=str(label or '').strip().upper().replace(' ','').replace('.','')
                return not normalized or normalized in ('N','NC','NOCHORD')
            if measure is None or chord is None or no_chord(chord.get('label')):
                raise ValueError('Choose a visible chord inside a bar.')
            start,end=measure['start'],measure['end']
            if not start+1e-6<chord.get('start',-1)<end-1e-6:
                raise ValueError('The chord must start later inside this bar.')
            real_before=any(other is not chord and other.get('start',float('inf'))<chord['start']-1e-6 and other.get('end',-1)>start+1e-6 and not no_chord(other.get('label')) for other in content.get('chords',[]))
            if real_before:
                raise ValueError('Another chord already occupies the start of this bar.')
            overrides=[item for item in metadata['chord_overrides'] if item['id']!=chord_id]
            overrides.append({'id':chord_id,'start':start,'end':chord['end'],'label':chord['label'],'confirmed':True})
            return self.apply_song_metadata(song_id,{'timing':metadata['timing'],'chord_overrides':overrides},revision)

    def _validate(self,row,content,previous):
        if not isinstance(content,dict):
            raise ValueError('Invalid document content')
        if row['kind']=='midi':
            return validate_midi(content,previous)
        if row['kind']=='chart':
            return validate_chart(content,self.library.song(row['song_id'])['duration'],self._music(row))
        if row['kind']=='text':
            if not isinstance(content.get('text'),str) or len(content['text'])>20*1024*1024:
                raise ValueError('Text document is too large or invalid')
            return {'text':content['text']}
        abc=content.get('abc')
        if not isinstance(abc,str) or len(abc)>2*1024*1024 or '\x00' in abc:
            raise ValueError('Invalid ABC score')
        if not re.search(r'^K:',abc,re.M):
            raise ValueError('The score must contain a K: key header')
        old_tokens=abc_tokens(previous['abc'])
        new_tokens=abc_tokens(abc)
        old_indices={offset:i for i,(offset,label) in enumerate(old_tokens)}
        updated=[]
        if len(old_tokens)==len(new_tokens):
            for chord in previous['chords']:
                chord=dict(chord)
                if chord.get('abc_index') in old_indices:
                    offset,label=new_tokens[old_indices[chord['abc_index']]]
                    chord.update(abc_index=offset,label=label)
                updated.append(chord)
        else:
            # Structural ABC changes need a new timing alignment. Preserve timings
            # but clear links rather than assign a correction to the wrong chord.
            updated=[dict(c,abc_index=None) for c in previous['chords']]
        result={'abc':abc,'chords':updated}
        engraving=content.get('engraving',previous.get('engraving'))
        if engraving is not None:
            result['engraving']=validate_engraving(engraving)
            if abc_structure(abc)!=abc_structure(previous['abc']):
                result['engraving']['anchors']=[]
        elif 'engraving' in content:
            raise ValueError('Invalid engraving settings')
        return result

    def save(self,document_id,content,label,revision):
        with self.library.lock:
            row=self._row(document_id)
            if row['kind']=='chart':
                if type(revision) is not int or revision!=row['revision']:raise RevisionConflict('This document changed. Reload it before editing again.')
                return self.save_bound_chart(document_id,content,self.timing.binding(document_id,row['cursor']),label,self.revision_stamp(document_id,verify_source=False),verify_source=False)
        with self.library.transaction() as db:
            row=self._row(document_id)
            if type(revision) is not int or revision!=row['revision']:
                raise RevisionConflict('This document changed. Reload it before editing again.')
            previous=self._get(document_id)['content']
            content=self._validate(row,content,previous)
            if content==previous:
                return self._get(document_id)
            label=self.library.clean_name(label)
            db.execute('DELETE FROM edits WHERE document_id=? AND position>?',(document_id,row['cursor']))
            db.execute('INSERT INTO edits VALUES(?,?,?,?)',(document_id,row['cursor']+1,json.dumps(content,allow_nan=False),label))
            db.execute('UPDATE documents SET cursor=cursor+1,revision=revision+1 WHERE id=?',(document_id,))
        saved=self._saved(document_id)
        if row['kind']=='abc' and previous.get('engraving',{}).get('anchors') and abc_structure(content['abc'])!=abc_structure(previous['abc']):
            saved['engraving_warning']='Melody changed; manual syllable anchors were cleared. Place them again.'
        return saved

    def history(self,document_id,action,revision):
        with self.library.transaction() as db:
            row=self._row(document_id)
            if type(revision) is not int or revision!=row['revision']:
                raise RevisionConflict('This document changed. Reload it before editing again.')
            if action=='restore':
                original=json.loads(db.execute('SELECT content FROM edits WHERE document_id=? AND position=0',(document_id,)).fetchone()[0])
                # Restore must retain original chord associations even after structural edits.
                db.execute('DELETE FROM edits WHERE document_id=? AND position>?',(document_id,row['cursor']))
                db.execute('INSERT INTO edits VALUES(?,?,?,?)',(document_id,row['cursor']+1,json.dumps(original),'Restore original'))
                if row['kind']=='chart':
                    original_binding=self.timing.binding(document_id,0)
                    db.execute('DELETE FROM timing_bindings WHERE document_id=? AND position>?',(document_id,row['cursor']))
                    self.timing.record_binding(db,document_id,row['cursor']+1,original_binding)
                cursor=row['cursor']+1
            elif action in ('undo','redo'):
                cursor=row['cursor']+(-1 if action=='undo' else 1)
                if not db.execute('SELECT 1 FROM edits WHERE document_id=? AND position=?',(document_id,cursor)).fetchone():
                    raise ValueError(f'Nothing to {action}')
            else:
                raise ValueError('Unknown history action')
            db.execute('UPDATE documents SET cursor=?,revision=revision+1 WHERE id=?',(cursor,document_id))
        return self._saved(document_id)

    def _saved(self,document_id):
        with self.library.lock:
            warning=None
            try:
                self.export(document_id)
            except (OSError,PathBudgetError) as exc:
                # SQLite remains authoritative even if an external reader locks export.
                warning=f'Edit saved; file export needs retry: {exc}'
            doc=self._get(document_id)
            if warning:doc['export_warning']=warning
            return doc

    def retry_export(self,document_id,revision):
        """Retry only the derived file; never resubmit content or append edit history."""
        with self.library.lock:
            row=self._row(document_id)
            if type(revision) is not int or revision!=row['revision']:
                raise RevisionConflict('This document changed. Reload it before retrying export.')
            return self._saved(document_id)

    def _export_destination(self,row):
        return self.library.contained(Path(self.library.song(row['song_id'])['folder'])/'runs'/row['run_id']/'edited'/row['name'])

    def _export_payload(self,row,content):
        if row['kind']=='midi':return write_midi(self.library.contained(row['original_path']),content)
        if row['kind']=='chart':return json.dumps(content,ensure_ascii=False,allow_nan=False,indent=2).encode('utf-8')
        return content['abc' if row['kind']=='abc' else 'text'].encode('utf-8')

    def midi_download(self,document_id,mode='single'):
        """The MIDI for a download or another program: one multichannel file, or a zip with one file per track."""
        if mode not in ('single','tracks'):raise ValueError('Choose one file or one file per track')
        with self.library.lock:
            row=self._row(document_id)
            if row['kind']!='midi':raise ValueError('Choose a MIDI output')
            data=self._export_payload(row,self._get(document_id)['content'])
            stem=safe_stem(self.library.song(row['song_id'])['title'],'Song')
        if mode=='single':return data,stem+'.mid'
        files=split_tracks(data)
        names=unique([safe_stem(name,'Track')+'.mid' for name,_ in files])
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
            for name,(_,content) in zip(names,files):archive.writestr(stem+' - '+name,content)
        return stream.getvalue(),stem+' - MIDI tracks.zip'

    def outputs_zip(self,song_id):
        """Everything the model wrote for the song's current analysis (beats, chords, melody, tokens...) in one zip."""
        with self.library.lock:
            song=self.library.song(song_id)
            if not song['active_run']:raise ValueError('Analyze this song first.')
            run_dir=self.library.contained(Path(song['folder'])/'runs'/song['active_run'])
            entries=[]
            for path in sorted(run_dir.rglob('*')):
                relative=path.relative_to(run_dir)
                if path.is_symlink() or not path.is_file() or any(part in ('edited','unfiltered') for part in relative.parts) or relative.as_posix() in ('confidence.json','run-options.json') or path.suffix.lower() not in ('.abc','.mid','.json','.lab','.txt','.tsv') or path.stat().st_size>20*1024*1024:continue
                if path.resolve().is_relative_to(run_dir):entries.append((relative.as_posix(),path.read_bytes()))
        if not entries:raise ValueError('There are no model outputs to export yet.')
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
            for name,content in entries:archive.writestr(name,content)
        return stream.getvalue(),safe_stem(song['title'],'Song')+' - model outputs.zip'

    def export(self,document_id):
        with self.library.lock:
            row=self._row(document_id)
            data=self._export_payload(row,self._get(document_id)['content'])
            destination=self._export_destination(row)
            validate_paths([destination,destination.with_name(destination.name+'.partial')])
            destination.parent.mkdir(parents=True,exist_ok=True)
            # Match confidence metadata recovery: avoid unnecessary replacement and
            # tolerate bounded, short Windows sharing/access blocks without unlinking.
            if destination.exists() and destination.read_bytes()==data:
                return data,Path(row['name']).name
            temporary=destination.with_name(destination.name+'.partial')
            temporary.write_bytes(data)
            for attempt in range(6):
                try:
                    temporary.replace(destination)
                    return data,Path(row['name']).name
                except PermissionError as exc:
                    if getattr(exc,'winerror',None) not in (5,32,33) or attempt==5:
                        raise
                    time.sleep(.025*2**attempt)


def abc_structure(abc):
    # Remove only recognized chord tokens and title fields; melody edits invalidate anchors.
    for offset,label in reversed(abc_tokens(abc)):
        abc=abc[:offset]+abc[offset+len(label)+2:]
    return re.sub(r'^T:[^\r\n]*(?:\r?\n|$)','',abc,flags=re.M)


def validate_engraving(value):
    import copy
    if not isinstance(value,dict): raise ValueError('Invalid engraving settings')
    if type(value.get('bars_per_line')) is not int or value['bars_per_line'] not in (0,2,3,4,8): raise ValueError('Invalid bars per line')
    if type(value.get('show_instrumental')) is not bool: raise ValueError('Invalid staff setting')
    if value.get('music_size','medium') not in ('large','medium','small'): raise ValueError('Invalid music size')
    text=value.get('lyrics_text')
    if not isinstance(text,str) or len(text)>2*1024*1024 or '\x00' in text: raise ValueError('Invalid lyrics')
    breaks=value.get('breaks',[])
    if not isinstance(breaks,list) or any(type(i) is not int or i<0 for i in breaks) or len(set(breaks))!=len(breaks): raise ValueError('Invalid engraving breaks')
    anchors=value.get('anchors',[])
    if not isinstance(anchors,list): raise ValueError('Invalid syllable anchors')
    seen=set()
    for anchor in anchors:
        if not isinstance(anchor,dict): raise ValueError('Invalid syllable anchor')
        index,text=anchor.get('index'),anchor.get('text')
        if type(index) is not int or index<0 or index in seen or not isinstance(text,str) or len(text)>10000 or any(c in text for c in '\x00\r\n'): raise ValueError('Invalid syllable anchor')
        seen.add(index)
    return copy.deepcopy(value)

