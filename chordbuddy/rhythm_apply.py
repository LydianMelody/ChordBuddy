"""Policy-specific previews and revision-checked application of immutable evidence."""
import copy
import json
import uuid
from pathlib import Path
from .analysis_contract import digest
from .timing_layout import remap_timing
from .separation_contract import file_hash
from .music import project_timing
from .documents import RevisionConflict

def build_rhythm_preview(document,proposal,policy):
    if policy not in ('clear','preserve'):raise ValueError('Unknown rhythm policy')
    overrides=document['timing_binding'].get('overrides',{})
    manual=bool(overrides.get('constant_tempo') or overrides.get('bpm') is not None or overrides.get('beats') or overrides.get('downbeats') or document['content'].get('layout',{}).get('bar_overrides'))
    new_music=project_timing(document['music'],proposal,overrides if policy=='preserve' else {})
    content,conflicts=remap_timing(document['content'],document['music'],new_music,proposal.get('correspondence',{}),policy,proposal.get('baseline_bars',proposal['bars']))
    if policy=='preserve' and (overrides.get('constant_tempo') or overrides.get('bpm') is not None):
        bpm=overrides.get('bpm') or document['music'].get('timing',{}).get('bpm')
        gaps=[b-a for bar in proposal['bars'] for a,b in zip(bar['beats'],bar['beats'][1:])]
        if not bpm or any(abs(gap-60/bpm)>.002 for gap in gaps):
            conflicts.append({'code':'tempo_constraint','section_id':None,'anchor_id':None,'message':'Corrected timing conflicts with your constant tempo/BPM. Adjust it or choose Replace rhythm overrides and apply.'})
    status=proposal.get('diagnostics',{}).get('status','unresolved')
    changed=status=='accepted' and (proposal['bars']!=document['music']['measures'] or policy=='clear' and manual)
    old={bar['id']:bar for bar in document['music']['measures']};details=[]
    for bar in proposal['bars']:
        before=old.get(bar['id'])
        if before and before!=bar:
            details.append({'measure_id':bar['id'],'number':bar.get('number'),'before_start':before['start'],'after_start':bar['start'],
                            'maximum_beat_shift_seconds':max((abs(b-a) for a,b in zip(before['beats'],bar['beats'])),default=0)})
    return {'id':uuid.uuid4().hex,'proposal_id':proposal.get('id'),'stamp':None,'has_manual_rhythm':manual,
            'change_details':details,
            'changes':bool(changed),'unresolved':[p for p in proposal.get('diagnostics',{}).get('passages',[]) if p['status']=='unresolved'] if status=='accepted' else [proposal.get('diagnostics',{})],
            'conflicts':conflicts,'policy':policy,'content':content,'binding':{'version_id':proposal.get('id'),'overrides':copy.deepcopy(overrides) if policy=='preserve' else {}}}

class RhythmService:
    def __init__(self,application):
        self.app=application;self.previews={};self.proposals={}

    def inputs(self,document_id):
        docs=self.app.documents;doc,stamp=docs.rhythm_snapshot(document_id)
        if doc['kind']!='chart':raise ValueError('Choose a Song chart')
        if not doc['timing_binding'].get('legacy_provenance_known',True):raise ValueError('This legacy chart has unknown timing provenance. Analyze song for a verified draft.')
        # Trust only a validated source-bound transcription stage for this run.
        store=self.app.analysis.store;verified=False
        with self.app.library.lock:
            rows=self.app.library.db.execute("SELECT manifest,reference FROM analysis_stages WHERE song_id=? AND kind='transcription'",(doc['song_id'],)).fetchall()
        for row in rows:
            manifest=json.loads(row['manifest']);ref=json.loads(row['reference'])
            if manifest.get('run_id')==doc['run_id'] and ref['source_sha256']==stamp['source_sha256']:
                store.validate(doc['song_id'],{'source_sha256':stamp['source_sha256']},manifest);verified=True;break
        if not verified:raise ValueError('Analyze song first: this chart needs a source-verified transcription.')
        state=self.app.separation_store.get_song_state(doc['song_id'])
        if not state['active']:raise ValueError('Analyze song first to prepare compatible drums.')
        root,manifest=self.app.separation_store.get_published_run(state['active']['run_id'])
        if manifest['source_sha256']!=stamp['source_sha256']:raise ValueError('Drums and transcription have different source audio')
        drums=next(asset for asset in manifest['assets'] if asset['role']=='drums')
        with self.app.library.lock:
            if docs.revision_stamp(document_id)!=stamp:raise RevisionConflict('Chart changed while preparing drums')
            row=docs._row(document_id);baseline_doc=dict(doc,music=docs._music(row,{'constant_tempo':False,'bpm':None}))
            baseline=docs.timing_version(baseline_doc)
        return doc,stamp,root/drums['relative_path'],drums,baseline,manifest['run_id']

    def prepare(self,document_id):
        doc,stamp,drums,asset,baseline,run_id=self.inputs(document_id)
        return {'document_id':document_id,'song_id':doc['song_id'],'stamp':stamp,'drums':str(drums),'baseline':baseline,
                'provenance':{'source_sha256':stamp['source_sha256'],'transcription_id':doc['run_id'],'drums_ref':run_id},
                'settings':{},'drums_sha256':asset['file_sha256']}

    def preview(self,document_id,proposal_id,policy):
        doc,stamp=self.app.documents.rhythm_snapshot(document_id);version=self.app.documents.timing.version(proposal_id)
        if version['transcription_id']!=doc['run_id'] or version['source_sha256']!=stamp['source_sha256']:raise ValueError('Proposal belongs to a different chart source')
        preview=build_rhythm_preview(doc,version,policy);preview['stamp']=stamp
        # Bound memory while retaining immutable proposal versions for reproducibility.
        if len(self.previews)>=64:self.previews.pop(next(iter(self.previews)))
        self.previews[preview['id']]=preview
        return {k:v for k,v in preview.items() if k not in ('content','binding')}

    def apply(self,document_id,preview_id,stamp,policy):
        preview=self.previews.get(preview_id)
        if not preview or preview['stamp']!=stamp or stamp['document_id']!=document_id or preview['policy']!=policy:raise RevisionConflict('Preview expired or changed; refresh before applying')
        if preview['conflicts']:raise ValueError('Resolve the preview conflicts before applying')
        if not preview['changes']:raise ValueError('No supported timing changes to apply')
        result=self.app.documents.save_bound_chart(document_id,preview['content'],preview['binding'],'Drum-based rhythm correction',stamp)
        self.previews.pop(preview_id,None)
        return result
