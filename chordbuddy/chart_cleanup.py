"""Delete only a proven, unchanged and empty terminal container-duration gap."""
import copy
import math
from .analysis_contract import digest

def terminal_artifact_patch(content,baseline,evidence):
    sections=content.get('sections',[])
    if len(sections)<2:return None
    tail=sections[-1];previous=sections[-2]
    original=next((s for s in baseline.get('sections',[]) if s['id']==tail['id']),None)
    if tail!=original or tail.get('lyrics') or tail['id']!=evidence.get('generated_gap_id'):return None
    # A held chord in the preceding section may already end at container EOF.
    # It remains byte-for-byte present after merging the empty gap into that section.
    if any(c.get('section_id')==tail['id'] or c.get('start',0)>=tail['start'] for c in content.get('chords',[])):return None
    layout=content.get('layout',{})
    if any(line.get('section_id')==tail['id'] for line in layout.get('lines',[])):return None
    if any(item.get('start',0)>=tail['start'] for item in layout.get('bar_overrides',[])):return None
    try:
        start,end=tail['start'],tail['end'];rate=evidence['canonical_rate'];model_rate=evidence['model_rate']
        values=[start,end,rate,model_rate,evidence['canonical_frames'],evidence['structure_end'],content['duration']]
        if not all(type(x) in (int,float) and math.isfinite(x) for x in values) or rate<=0 or model_rate<=0:return None
        if not 0<end-start<=.100 or end!=content['duration'] or previous['end']!=start:return None
        if evidence['source_sha256']!=evidence['canonical_source_sha256']:return None
        tolerance=1/rate+1/model_rate+.000001;canonical=evidence['canonical_frames']/rate
        if abs(start-canonical)>tolerance or abs(start-evidence['structure_end'])>tolerance or end<canonical:return None
    except (KeyError,TypeError,ZeroDivisionError):return None
    result=copy.deepcopy(content);result['sections'][-2]['end']=end;result['sections'].pop()
    return {'expected_hash':digest(content),'removed_id':tail['id'],'predecessor_id':previous['id'],'content':result,'label':'Remove empty end artifact'}
