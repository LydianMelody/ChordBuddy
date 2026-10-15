"""Keep manual chart placements at recording times when the tempo grid changes."""
import copy
import math
from .compact_layout import reconcile_compact_layout

def remap_timing(content,old_music,new_music,correspondence,policy,baseline=None):
    value=copy.deepcopy(content);layout=value.get('layout')
    if not layout:return value,[]
    try:
        old=copy.deepcopy(old_music['measures']);new=copy.deepcopy(new_music['measures'])
        old_ids={m['id']:m for m in old};new_ids={m['id']:m for m in new}
        def mapped(mid):
            if mid not in old_ids:raise ValueError('Unmatched measure correspondence: '+str(mid))
            matches=[bar for bar in (baseline if baseline is not None else old_music['measures']) if abs(bar['start']-old_ids[mid]['start'])<1e-6]
            if len(matches)!=1:raise ValueError('Ambiguous recording-time measure correspondence: '+str(mid))
            target=correspondence.get(matches[0]['id'])
            if target not in new_ids:raise ValueError('Unmatched measure correspondence: '+str(mid))
            return target
        def apply_bars(measures,overrides):
            times=[t for m in measures for t in m['beats']]
            for item in overrides:
                index=next((i for i,m in enumerate(measures) if m['id']==item['id']),None)
                if index is None or index==0:raise ValueError('Manual barline has no compatible interior measure')
                measures[index]['start']=item['start'];measures[index-1]['end']=item['start']
            for bar in measures:
                if bar['end']<=bar['start']:raise ValueError('Manual barlines conflict with corrected timing')
                bar['beats']=[bar['start']]+[t for t in times if bar['start']<t<bar['end']]
        overrides=[dict(item,id=mapped(item['id'])) for item in layout.get('bar_overrides',[])] if policy=='preserve' else []
        layout['breaks']=[mapped(mid) for mid in layout.get('breaks',[])]
        layout['bar_overrides']=overrides
        range_map={mid:mapped(mid) for line in layout.get('lines',[]) for mid in (line['start_measure'],line['end_measure'])}
        apply_bars(old,content.get('layout',{}).get('bar_overrides',[]))
        apply_bars(new,overrides)
        sections={s['id']:s for s in value['sections']}
        for line in layout.get('lines',[]):
            line['start_measure']=range_map[line['start_measure']];line['end_measure']=range_map[line['end_measure']]
            section=sections[line['section_id']]
            for word in line['words']:
                bar=old_ids[word['measure_id']];points=bar['beats']+[bar['end']];index=math.floor(word['beat'])
                time=points[index]+(word['beat']-index)*(points[index+1]-points[index])
                target=next((m for m in new if m['start']<=time<m['end']),None)
                if target is None or not section['start']-1e-7<=time<section['end']-1e-7:raise ValueError('Lyric anchor would cross its section boundary')
                points=target['beats']+[target['end']];index=next(i for i in range(len(points)-1) if time<points[i+1])
                word.update(measure_id=target['id'],beat=index+(time-points[index])/(points[index+1]-points[index]))
            ids=[line['start_measure'],line['end_measure']]+[w['measure_id'] for w in line['words']]
            line['start_measure']=min(ids,key=lambda mid:new_ids[mid]['start']);line['end_measure']=max(ids,key=lambda mid:new_ids[mid]['start'])
        value,_=reconcile_compact_layout(value,old_music,new_music,correspondence)
        from .chart import validate_chart
        validate_chart(value,value['duration'],new_music)
        return value,[]
    except (ValueError,KeyError,IndexError,StopIteration) as exc:
        return copy.deepcopy(content),[{'code':'mapping_conflict','section_id':locals().get('line',{}).get('section_id'), 'anchor_id':locals().get('word',{}).get('measure_id'),'message':str(exc)}]


def remap_layout(content, old_music, new_music):
    value=copy.deepcopy(content)
    layout=value.get('layout')
    if not layout or old_music['measures']==new_music['measures']:
        return value
    old=copy.deepcopy(old_music['measures'])
    new=copy.deepcopy(new_music['measures'])
    if not old or not new:
        if layout.get('lines') or layout.get('bar_overrides') or layout.get('breaks'):
            raise ValueError('Timing is unavailable; existing manual placements cannot be moved safely.')
        value,_=reconcile_compact_layout(value,old_music,new_music)
        return value
    old_by_id={m['id']:m for m in old}
    def nearest(time):
        return min(new,key=lambda m:abs(m['start']-time))
    breaks=list(dict.fromkeys(nearest(old_by_id[mid]['start'])['id'] for mid in layout.get('breaks',[])))
    overrides=[]
    for override in layout.get('bar_overrides',[]):
        target=nearest(old_by_id[override['id']]['start'])
        if target is new[0] or any(o['id']==target['id'] for o in overrides):
            raise ValueError('This tempo grid conflicts with manual barlines. Adjust those barlines before changing tempo.')
        overrides.append(dict(override,id=target['id']))
    def apply(measures, corrections):
        times=[t for m in measures for t in m['beats']]
        for correction in corrections:
            index=next(i for i,m in enumerate(measures) if m['id']==correction['id'])
            measures[index]['start']=correction['start']
            measures[index-1]['end']=correction['start']
        for m in measures:
            if m['end']<=m['start']:
                raise ValueError('The new tempo conflicts with a manual barline.')
            m['beats']=[m['start']]+[t for t in times if m['start']+1e-6<t<m['end']-1e-6]
    apply(old,layout.get('bar_overrides',[]))
    apply(new,overrides)
    sections={s['id']:s for s in value['sections']}
    def containing(time):
        return next((m for m in new if m['start']<=time<m['end']),new[-1])
    for line in layout.get('lines',[]):
        section=sections[line['section_id']]
        for word in line['words']:
            source=old_by_id[word['measure_id']]
            index=math.floor(word['beat'])
            points=source['beats']+[source['end']]
            time=points[index]+(word['beat']-index)*(points[index+1]-points[index])
            target=containing(time)
            if not section['start']-1e-7<=time<section['end']-1e-7:
                raise ValueError('A placed lyric would cross its section boundary. Adjust that section boundary before changing tempo.')
            points=target['beats']+[target['end']]
            index=next(i for i in range(len(points)-1) if time<points[i+1])
            word.update(measure_id=target['id'],beat=index+(time-points[index])/(points[index+1]-points[index]))
        members=[m for m in new if m['end']>section['start']+1e-6 and m['start']<section['end']-1e-6]
        if not members:
            raise ValueError('The new tempo leaves a lyric section without a bar. Adjust its boundary first.')
        first=old_by_id[line['start_measure']]['start']
        last=old_by_id[line['end_measure']]['start']
        indices=[new.index(min(members,key=lambda m:abs(m['start']-t))) for t in (first,last)]
        indices.extend(next(i for i,m in enumerate(new) if m['id']==w['measure_id']) for w in line['words'])
        line.update(start_measure=new[min(indices)]['id'],end_measure=new[max(indices)]['id'])
    layout.update(breaks=breaks,bar_overrides=overrides)
    value,_=reconcile_compact_layout(value,old_music,new_music)
    return value
