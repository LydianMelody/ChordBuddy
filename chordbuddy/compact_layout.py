"""Validate presentation preferences; never rewrite canonical musical events."""
import copy,math

def validate_compact_layout(value,sections,chords,measures):
    def fail(): raise ValueError('Invalid compact layout. Reset compact layout before saving new preferences.')
    def number(v):return type(v) in (int,float) and math.isfinite(v)
    if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1:fail()
    if 'notice' in value and (not isinstance(value['notice'],str) or len(value['notice'])>1000):fail()
    groups=value.get('groups'); sm={s['id']:s for s in sections};mm={m['id']:m for m in measures};cm={c['id']:c for c in chords or []}
    if not isinstance(groups,list) or len(groups)>len(measures)+2*len(sections):fail()
    ids=set();ranges=[]
    for g in groups:
        if not isinstance(g,dict) or not isinstance(g.get('id'),str) or not 0<len(g['id'])<=300 or g['id'] in ids or not isinstance(g.get('section_id'),str) or g.get('section_id') not in sm or g.get('mode') not in ('repeat','expanded'):fail()
        ids.add(g['id']);s=sm[g['section_id']];passes=g.get('passes');last=None
        if not isinstance(passes,list) or not passes or len(passes)>len(measures):fail()
        for p in passes:
            if not isinstance(p,dict):fail()
            a,b=p.get('start'),p.get('end')
            if not number(a) or not number(b) or not s['start']<=a<b<=s['end'] or last is not None and a!=last:fail()
            mids,cids=p.get('measure_ids'),p.get('chord_ids')
            if not isinstance(mids,list) or not mids or any(not isinstance(i,str) or i not in mm for i in mids) or len(set(mids))!=len(mids):fail()
            expected=[m['id'] for m in measures if m['start']<b and m['end']>a]
            if mids!=expected or mm[mids[0]]['start']>a or mm[mids[-1]]['end']<b:fail()
            if not isinstance(cids,list) or any(not isinstance(i,str) or i not in cm for i in cids) or len(set(cids))!=len(cids):fail()
            if cids!=[c['id'] for c in chords if c['start']<b and c['end']>a]:fail()
            last=b
        a,b=passes[0]['start'],passes[-1]['end']
        if any(a<y and b>x for x,y in ranges):fail()
        ranges.append((a,b))
    return copy.deepcopy(value)

def reconcile_compact_layout(content,old_music,new_music,correspondence=None):
    result=copy.deepcopy(content);pref=result.get('layout',{}).get('compact');warnings=[]
    if pref is None:return result,warnings
    if not isinstance(pref,dict) or pref.get('version')!=1:raise ValueError('Reset unsupported compact layout before changing timing.')
    old={m['id']:m for m in old_music.get('measures',[])};new=new_music.get('measures',[]);kept=[]
    for group in pref.get('groups',[]):
        candidate=copy.deepcopy(group)
        try:
            for p in candidate['passes']:
                ids=[]
                for mid in p['measure_ids']:
                    source=old[mid]; matches=[m for m in new if m['start']==source['start'] and m['end']==source['end']]
                    if len(matches)!=1:raise ValueError('ambiguous correspondence')
                    if correspondence is not None and correspondence.get(mid)!=matches[0]['id']:raise ValueError('unproven correspondence')
                    ids.append(matches[0]['id'])
                p['measure_ids']=ids
            validate_compact_layout({'version':1,'groups':[candidate]},result['sections'],result['chords'],new);kept.append(candidate)
        except (KeyError,TypeError,ValueError):warnings.append('A compact grouping was expanded because its recording correspondence changed.')
    pref['groups']=kept
    if warnings:pref['notice']='A compact grouping was expanded after timing changed. Musical edits and prior history are preserved.'
    return result,warnings
