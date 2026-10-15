"""Read-only measures from original model rhythm annotations."""
import json
import math
import copy
from statistics import median
from functools import lru_cache
from pathlib import Path
from .chart import seed_sections
from .confidence import read_confidence, filter_beat_times
from .chords import chord_label

def project_timing(raw_music,version,overrides):
    value=copy.deepcopy(raw_music)
    value['measures']=copy.deepcopy(version['bars'])
    for bar in value['measures']:
        positions=bar.get('quarter_positions')
        if not isinstance(positions,list) or len(positions)!=len(bar['beats'])+1:
            original=next((m for m in raw_music.get('measures',[]) if m['id']==bar['id']
                           and m['beats']==bar['beats'] and m['end']==bar['end']),None)
            bar['quarter_positions']=copy.deepcopy(original.get('quarter_positions')) if original and original.get('quarter_positions') else [None]*(len(bar['beats'])+1)
    value['rhythm_diagnostics']=copy.deepcopy(version.get('diagnostics',{}))
    value['timing']=dict(overrides or {},corrected=True)
    return value


def complete_beats(inside, start, end, meter, interval, bounded):
    """Interpolate absent quarter-pulse positions, never replace detections."""
    if not meter or not inside:
        return inside, set()
    units = meter[0]*4/meter[1]
    count = math.ceil(units)
    # A premature downbeat is a boundary problem, not four very fast beats.
    if interval and end-start < units*interval*.75:
        return inside, set()
    anchors = {0: start}
    for time, number, _ in inside:
        position = number-1
        if position < 0 or position >= units or position in anchors and abs(anchors[position]-time)>1e-6:
            return inside, set()
        anchors[position] = time
    if bounded:
        anchors[units] = end
    elif interval:
        anchors[units] = anchors[max(anchors)]+(units-max(anchors))*interval
    else:
        return inside, set()
    positions = sorted(anchors)
    if any(anchors[a]>=anchors[b] for a,b in zip(positions,positions[1:])):
        return inside, set()
    inferred = {}
    for position in range(count):
        if position in anchors:
            continue
        left = max(p for p in positions if p<position)
        right = min(p for p in positions if p>position)
        time = anchors[left]+(anchors[right]-anchors[left])*(position-left)/(right-left)
        if time < end-1e-6:
            inferred[time]=position+1
    return sorted(inside+[(t, number, meter) for t,number in inferred.items()]), set(inferred)


def quarter_projection(inside, points, meter, bounded, interval=None, constant=False):
    """Add proven quarter-note labels without changing the stored beat index."""
    if not meter:
        return [None]*len(points)
    units=meter[0]*4/meter[1]
    known={time:number-1 for time,number,_ in inside if 0<number<units+1}
    labelled=sorted(known.items())
    if any(a[1]>=b[1] for a,b in zip(labelled,labelled[1:])):
        return [None]*len(points)
    values=[known.get(t) for t in points]
    # A downbeat proves the terminal meter boundary except for a demonstrably
    # truncated bar. Constant-tempo mode supplies its explicitly chosen scale.
    premature=interval and points[-1]-points[0]<units*interval*.75 and known.get(points[0])==0
    if bounded and not premature:
        values[-1]=units
    elif constant and interval and values[0] is not None:
        values[-1]=values[0]+(points[-1]-points[0])/interval
    elif interval and labelled:
        end=labelled[-1][0]+(units-labelled[-1][1])*interval
        if abs(end-points[-1])<1e-6:values[-1]=units
    return values


def read_music(run_dir,duration,timing=None,beat_remove_threshold=0):
    root=Path(run_dir)
    signatures=[]
    for name in ('beat.lab','downbeat.lab','events.json','structure.lab','confidence.json','unfiltered/beat.lab','unfiltered/downbeat.lab','unfiltered/events.json'):
        try:
            stat=(root/name).stat(); signatures.append((name,stat.st_mtime_ns,stat.st_size))
        except OSError: signatures.append((name,None,None))
    timing = timing if isinstance(timing, dict) else {}
    constant = timing.get('constant_tempo') is True
    bpm = timing.get('bpm')
    if bpm is not None and (type(bpm) not in (int,float) or not math.isfinite(bpm) or not 20 <= bpm <= 300):
        bpm = None
    return copy.deepcopy(_read_music(str(root),duration,tuple(signatures),constant,bpm,int(beat_remove_threshold or 0)))


@lru_cache(maxsize=32)
def _read_music(run_dir,duration,signatures,constant_tempo=False,requested_bpm=None,beat_remove_threshold=0):
    root=Path(run_dir)
    warnings=[]
    def lines(name):
        path=root/name
        if path.is_symlink() or not path.is_file(): return []
        try: return path.read_text(encoding='utf-8').splitlines()
        except (OSError,UnicodeError):
            warnings.append(f'Could not read {name}')
            return []
    event_beats=[]; event_sections=[]; current_meter=None
    raw_root = root/'unfiltered' if (root/'unfiltered').is_dir() else root

    def raw_lines(name):
        path=raw_root/name
        if path.is_symlink() or not path.is_file(): return []
        try: return path.read_text(encoding='utf-8').splitlines()
        except (OSError,UnicodeError): return []

    # Confidence is a raw sidecar even when the current output was filtered.
    # Read it once and apply the current setting as a reversible projection.
    confidence=read_confidence(root)
    try:
        payload=json.loads('\n'.join(raw_lines('events.json') or lines('events.json')) or '[]')
        events=payload.get('events',[]) if isinstance(payload,dict) else payload
        for event in events if isinstance(events,list) else []:
            if not isinstance(event,dict): continue
            time=event.get('time'); values=event.get('values',{})
            if type(time) not in (int,float) or not math.isfinite(time) or not 0<=time<duration or not isinstance(values,dict): continue
            rhythm=values.get('rhythm')
            if isinstance(rhythm,dict):
                meter=rhythm.get('meter')
                if isinstance(meter,list) and len(meter)==2 and all(type(v) is int and v>0 for v in meter): current_meter=meter
                position=rhythm.get('eighth_position')
                if type(position) in (int,float) and math.isfinite(position) and position>=0:
                    event_beats.append((time,position/2+1,current_meter))
            name=values.get('structure')
            if isinstance(name,str) and name.strip(): event_sections.append((time,name.replace('_',' ').title()))
    except (ValueError,TypeError): warnings.append('Could not read events.json')
    beats=[]
    for line in raw_lines('beat.lab') or lines('beat.lab'):
        try:
            fields=line.split(); time=float(fields[0]); number=int(fields[1])
            meter=[int(fields[2]),int(fields[3])] if len(fields)>=4 else None
            if math.isfinite(time) and 0<=time<duration and number>0 and (meter is None or all(v>0 for v in meter)):
                beats.append((time,number,meter))
        except (ValueError,IndexError): pass
    # Keep the model grid immutable in the returned measure objects.  The
    # current removal tolerance is a display projection (``beat_visible``),
    # so relaxing it can restore a beat and existing lyric anchors continue to
    # refer to the same raw beat index.
    beats=sorted({b[0]:b for b in (beats or event_beats)}.values())
    raw_intervals=[b[0] for b in beats]
    visible_times=set(filter_beat_times(raw_intervals, confidence, beat_remove_threshold))
    down=[]
    for line in raw_lines('downbeat.lab') or lines('downbeat.lab'):
        try:
            time=float(line.split()[0])
            if math.isfinite(time) and 0<=time<duration: down.append(time)
        except (ValueError,IndexError): pass
    starts=sorted(set(down or [b[0] for b in beats if b[1]==1]))
    pickup=bool(starts and beats and beats[0][0]<starts[0])
    if pickup: starts.insert(0,beats[0][0])
    # Preserve recorded downbeats and meter boundaries.  Constant-tempo mode
    # changes only interior beat positions; it never invents a meter.
    intervals=[(b[0],b[1],b[2]) for b in beats]
    effective_bpm=None
    if raw_intervals:
        gaps=[(b[0]-a[0])/(b[1]-a[1]) for a,b in zip(beats,beats[1:])
              if b[1]>a[1] and b[2]==a[2]]
        if not gaps:
            for a,b in zip(starts,starts[1:]):
                meter=next((v[2] for v in reversed(beats) if v[0]<=a and v[2]),None)
                if meter and b>a:
                    gaps.append((b-a)/(meter[0]*4/meter[1]))
        if gaps:
            effective_bpm=60.0/median(gaps)
            if constant_tempo and requested_bpm is None and starts:
                # Millisecond-rounded timestamps bias a median gap over a
                # whole song. Fit the pulse spacing to elapsed recording time.
                anchor=starts[1] if pickup else starts[0]
                interval=60/effective_bpm
                samples=[]; position=0; previous=anchor
                for time in raw_intervals:
                    if time<=anchor: continue
                    position+=max(1,round((time-previous)/interval))
                    samples.append((position,time-anchor)); previous=time
                if samples:
                    fitted=sum(p*t for p,t in samples)/sum(p*p for p,t in samples)
                    effective_bpm=60/fitted
    if requested_bpm is not None:
        effective_bpm=float(requested_bpm)
    if constant_tempo and effective_bpm:
        interval=60.0/effective_bpm
        rebuilt=[]
        grid_starts=[]
        # Meter changes remain explicit; extra model downbeats do not reset a
        # user-declared steady pulse. Preserve the pickup before the first bar.
        changes=[]
        for time, _, meter in intervals:
            if meter and (not changes or changes[-1][1]!=meter):
                changes.append((time,meter))
        if starts and changes:
            first=starts[1] if pickup else starts[0]
            if pickup:
                grid_starts.append(starts[0])
                rebuilt.extend(b for b in intervals if b[0]<first)
            cursor=first
            while cursor<duration-1e-6:
                meter=next((m for t,m in reversed(changes) if t<=cursor+1e-6),changes[0][1])
                units=meter[0]*4/meter[1]
                end=min(cursor+units*interval,duration,next((t for t,m in changes if t>cursor+1e-6),duration))
                grid_starts.append(cursor)
                rebuilt.extend((cursor+j*interval,j+1,meter) for j in range(math.ceil(units)) if cursor+j*interval<end-1e-6)
                cursor=end
            starts=grid_starts
            intervals=rebuilt
            visible_times={b[0] for b in intervals}
    measures=[]
    for i,start in enumerate(starts):
        end=starts[i+1] if i+1<len(starts) else duration
        inside=[b for b in intervals if start<=b[0]<end]
        meter=next((b[2] for b in reversed(intervals) if b[0]<=start and b[2]),None)
        inferred=set()
        if not constant_tempo and not (pickup and i==0):
            inside,inferred=complete_beats(inside,start,end,meter,60/effective_bpm if effective_bpm else None,i+1<len(starts))
            visible_times.update(inferred)
        warning=None
        if meter is None: warning='Time signature unavailable'
        elif not constant_tempo and sum(b[0] in visible_times for b in inside)!=meter[0]*4/meter[1]: warning=f'Observed {sum(b[0] in visible_times for b in inside)} beats; expected {meter[0]*4/meter[1]:g}'
        if pickup and i==0: warning='Partial pickup before first downbeat'
        measure_beats=sorted(set([start]+[b[0] for b in inside]))
        measures.append({'id':f'm{i}','number':i+1,'start':start,'end':end,'meter':meter,
                         'beats':measure_beats,
                         'quarter_positions':quarter_projection(inside,measure_beats+[end],meter,i+1<len(starts),60/effective_bpm if effective_bpm else None,constant_tempo),
                         'beat_visible':[constant_tempo or beat in visible_times for beat in measure_beats],
                         'beat_inferred':[beat in inferred or constant_tempo for beat in measure_beats],
                         'warning':None if constant_tempo else warning})
    if not measures: warnings.append('Beat timing unavailable; measures cannot be displayed')
    sections=[{k:s[k] for k in ('name','start','end')} for s in seed_sections(root,duration)]
    if event_sections and not (root/'structure.lab').is_file():
        event_sections=sorted(dict(event_sections).items())
        sections=[{'name':name,'start':start,'end':event_sections[i+1][0] if i+1<len(event_sections) else duration} for i,(start,name) in enumerate(event_sections)]
    if constant_tempo:
        # The user explicitly chose the grid, so model rhythm certainty is no
        # longer actionable in this view.
        confidence = dict(confidence, beats=[])
    for chord in confidence.get('chords',[]):
        if isinstance(chord.get('label'),str):chord['label']=chord_label(chord['label'])
    for measure in measures:
        measure['beat_confidence']=[next((b['score'] for b in confidence.get('beats',[]) if abs(b['time']-time)<1e-6),None) for time in measure['beats']]
    timing={'constant_tempo':bool(constant_tempo),'bpm':effective_bpm}
    if constant_tempo and not effective_bpm:
        warnings.append('Tempo unavailable; constant tempo grid cannot be displayed')
    return {'measures':measures,'sections':sections,'warnings':warnings,'confidence':confidence,'timing':timing}
