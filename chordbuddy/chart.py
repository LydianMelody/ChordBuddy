"""Independent section and lyric charts, seeded from real timed annotations."""
import math
from pathlib import Path

from .chords import chord_label


def finite_time(value):
    return type(value) in (int,float) and math.isfinite(value)


def seed_sections(run_dir,duration):
    path=Path(run_dir)/'structure.lab'
    intervals=[]
    if path.is_file() and not path.is_symlink():
        try:
            for line in path.read_text(encoding='utf-8').splitlines():
                fields=line.split(None,2)
                if len(fields)!=3:
                    continue
                try:
                    start,end=float(fields[0]),float(fields[1])
                except ValueError:
                    continue
                name=fields[2].strip().replace('_',' ').title()
                if name and finite_time(start) and finite_time(end) and end>start and end>0 and start<duration:
                    intervals.append((max(0,start),min(duration,end),name[:200]))
        except (OSError,UnicodeError):
            intervals=[]
    sections=[]
    def append(start,end,name):
        if end<=start:
            return
        if sections and sections[-1]['name']==name and abs(sections[-1]['end']-start)<1e-8:
            sections[-1]['end']=end
        else:
            sections.append({'id':f's{len(sections)}','name':name,'start':start,'end':end,'lyrics':''})
    cursor=0
    for start,end,name in sorted(intervals,key=lambda item:item[0]):
        if start>cursor:
            append(cursor,start,'Instrumental')
        append(max(start,cursor),end,name)
        cursor=max(cursor,end)
    if cursor<duration:
        append(cursor,duration,'Instrumental' if intervals else 'Song')
    return sections


def seed_chart(run_dir,duration,chords):
    sections=seed_sections(run_dir,duration)
    candidates=[]
    for source in chords:
        if not isinstance(source,dict):
            continue
        start,end=source.get('start'),source.get('end')
        label=source.get('label')
        if finite_time(start) and finite_time(end) and isinstance(label,str) and label.strip() and 0<=start<min(end,duration):
            candidates.append(dict(source,start=float(start),end=min(float(end),duration)))
    candidates.sort(key=lambda chord:chord['start'])
    distinct=[]
    for chord in candidates:
        if distinct and distinct[-1]['start']==chord['start']:
            distinct.pop()
        distinct.append(chord)
    result=[]
    used=set()
    for index,chord in enumerate(distinct):
        section=next((s for s in sections if s['start']<=chord['start']<s['end']),None)
        if section is None:
            continue
        identifier=chord.get('id')
        if not isinstance(identifier,str) or not identifier or identifier in used:
            identifier=f'chart-c{index}'
            while identifier in used:
                identifier+='x'
        used.add(identifier)
        end=min(chord['end'],distinct[index+1]['start']) if index+1<len(distinct) else chord['end']
        result.append({'id':identifier,'label':chord_label(chord['label']),'start':chord['start'],'end':end,
                       'section_id':section['id'],'line':None,'offset':None})
    return validate_chart({'version':1,'duration':duration,'sections':sections,'chords':result},duration)


def validate_chart(content,duration,music=None):
    if not isinstance(content,dict) or type(content.get('version')) is not int or content['version']!=1:
        raise ValueError('Invalid song chart version')
    if not finite_time(duration) or duration<=0 or not finite_time(content.get('duration')) or content['duration']!=duration:
        raise ValueError('The chart duration must match the original audio')
    sections,chords=content.get('sections'),content.get('chords')
    if not isinstance(sections,list) or not sections or not isinstance(chords,list):
        raise ValueError('A chart needs a section list and chord list')
    ids=set()
    clean_sections=[]
    previous_end=0
    for section in sections:
        if not isinstance(section,dict):
            raise ValueError('Invalid chart section')
        identifier,name,lyrics=section.get('id'),section.get('name'),section.get('lyrics')
        if not isinstance(identifier,str) or not identifier or len(identifier)>200 or identifier in ids:
            raise ValueError('Every section needs a unique identifier')
        if not isinstance(name,str) or not name.strip() or len(name)>200 or '\x00' in name:
            raise ValueError('Enter a section name between 1 and 200 characters')
        if not isinstance(lyrics,str) or len(lyrics)>2*1024*1024 or '\x00' in lyrics:
            raise ValueError('Invalid section lyrics')
        start,end=section.get('start'),section.get('end')
        if not finite_time(start) or not finite_time(end) or not previous_end<=start<end<=duration:
            raise ValueError('Sections must be ordered, nonoverlapping, and within the original audio duration')
        previous_end=end
        ids.add(identifier)
        clean_sections.append({'id':identifier,'name':name.strip(),'start':start,'end':end,'lyrics':lyrics})
    section_map={section['id']:section for section in clean_sections}
    clean_chords=[]
    chord_ids=set()
    previous_end=0
    for chord in chords:
        if not isinstance(chord,dict):
            raise ValueError('Invalid chart chord')
        identifier,label=chord.get('id'),chord.get('label')
        if not isinstance(identifier,str) or not identifier or len(identifier)>200 or identifier in chord_ids:
            raise ValueError('Every chart chord needs a unique identifier')
        if not isinstance(label,str) or not label.strip() or len(label)>2*1024*1024 or any(c in label for c in '\x00\r\n'):
            raise ValueError('Enter a nonblank chord label within the 2 MB ABC document limit')
        start,end=chord.get('start'),chord.get('end')
        if not finite_time(start) or not finite_time(end) or not previous_end<=start<end<=duration:
            raise ValueError('Chords must be ordered, nonoverlapping, and within the original audio duration')
        section_id=chord.get('section_id')
        section=section_map.get(section_id) if isinstance(section_id,str) else None
        if section is None or not section['start']<=start<section['end']:
            raise ValueError('Each chord must belong to the section containing its start time')
        line,offset=chord.get('line'),chord.get('offset')
        if line is not None or offset is not None:
            lines=section['lyrics'].split('\n')
            if type(line) is not int or type(offset) is not int or not 0<=line<len(lines) or not 0<=offset<=len(lines[line]):
                raise ValueError('Place the chord on an existing lyric line and character position, or leave both positions empty')
        chord_ids.add(identifier)
        previous_end=end
        cleaned={'id':identifier,'label':label,'start':start,'end':end,'section_id':section_id,'line':line,'offset':offset}
        if chord.get('confirmed') is True: cleaned['confirmed']=True
        if isinstance(chord.get('override_id'),str): cleaned['override_id']=chord['override_id']
        clean_chords.append(cleaned)
    result={'version':1,'duration':duration,'sections':clean_sections,'chords':clean_chords}
    if 'layout' in content: result['layout']=validate_layout(content['layout'],clean_sections,music,clean_chords)
    return result


def validate_layout(layout,sections,music,chords=None):
    if not isinstance(layout,dict): raise ValueError('Invalid chart layout')
    if type(layout.get('bars_per_line')) is not int or layout['bars_per_line'] not in (2,3,4,8): raise ValueError('Invalid bars per line')
    measures=[dict(m) for m in (music or {}).get('measures',[])]
    original_beats=[beat for measure in measures for beat in measure['beats']]
    indices={m['id']:i for i,m in enumerate(measures)}
    breaks=layout.get('breaks',[])
    if not isinstance(breaks,list) or any(not isinstance(b,str) or b not in indices for b in breaks) or len(set(breaks))!=len(breaks): raise ValueError('Invalid measure breaks')
    overrides=layout.get('bar_overrides',[])
    if not isinstance(overrides,list): raise ValueError('Invalid bar overrides')
    seen=set()
    for item in overrides:
        if not isinstance(item,dict) or not isinstance(item.get('id'),str) or item['id'] not in indices or item['id'] in seen or not finite_time(item.get('start')): raise ValueError('Invalid bar boundary')
        seen.add(item['id']); index=indices[item['id']]; start=item['start']
        if index==0: raise ValueError('Choose an interior barline to correct')
        measures[index]['start']=start
        if index: measures[index-1]['end']=start
    for m in measures:
        if m['start']>=m['end']: raise ValueError('Bar boundaries must remain ordered')
        m['beats']=[m['start']]+[b for b in original_beats if m['start']+1e-6<b<m['end']-1e-6]
    section_map={s['id']:s for s in sections}; assigned=set()
    lines=layout.get('lines',[])
    if not isinstance(lines,list): raise ValueError('Invalid lyric placements')
    for item in lines:
        if not isinstance(item,dict) or not isinstance(item.get('section_id'),str) or item['section_id'] not in section_map: raise ValueError('Unknown lyric section')
        section=section_map[item['section_id']]; line=item.get('line'); text=section['lyrics'].split('\n')
        if type(line) is not int or not 0<=line<len(text) or (section['id'],line) in assigned: raise ValueError('Invalid lyric line')
        assigned.add((section['id'],line))
        first,last=item.get('start_measure'),item.get('end_measure')
        if not isinstance(first,str) or not isinstance(last,str) or first not in indices or last not in indices or indices[first]>indices[last]: raise ValueError('Invalid lyric measure range')
        if any(not (measures[indices[mid]]['end']>section['start']+1e-6 and measures[indices[mid]]['start']<section['end']-1e-6) for mid in (first,last)): raise ValueError('Lyric measures must belong to their section')
        words=item.get('words',[])
        if not isinstance(words,list): raise ValueError('Invalid word placements')
        offsets=set(); positions=[]
        for word in words:
            if not isinstance(word,dict): raise ValueError('Invalid word placement')
            offset,mid,beat=word.get('offset'),word.get('measure_id'),word.get('beat')
            if type(offset) is not int or not 0<=offset<len(text[line]) or offset in offsets or not isinstance(mid,str) or mid not in indices or not indices[first]<=indices[mid]<=indices[last] or not finite_time(beat) or not 0<=beat<len(measures[indices[mid]]['beats']): raise ValueError('Invalid word anchor')
            bar=measures[indices[mid]]; points=bar['beats']+[bar['end']]; index=int(beat)
            anchor_time=points[index]+(beat-index)*(points[index+1]-points[index])
            if not section['start']-1e-7<=anchor_time<section['end']-1e-7: raise ValueError('A lyric anchor must be inside its section')
            offsets.add(offset)
            positions.append((offset,indices[mid],beat))
        ordered=sorted(positions)
        if any(a[1:]>=b[1:] for a,b in zip(ordered,ordered[1:])): raise ValueError('Word anchors must follow lyric order')
    if 'compact' in layout:
        from .compact_layout import validate_compact_layout
        validate_compact_layout(layout['compact'],sections,chords or [],measures)
    import copy
    return copy.deepcopy(layout)
