"""Edit note events while retaining original MIDI tempo and controller data."""
import bisect
from collections import defaultdict, deque
import io
import math

import mido


def tempo_map(midi):
    changes = []
    for track in midi.tracks:
        tick = 0
        for msg in track:
            tick += msg.time
            if msg.type == 'set_tempo':
                changes.append((tick,msg.tempo))
    points = [(0,0.0,500000)]
    for tick,tempo in sorted(changes,key=lambda p:p[0]):
        prev,seconds,rate = points[-1]
        at = seconds+mido.tick2second(tick-prev,midi.ticks_per_beat,rate)
        if tick == prev:
            points[-1]=(tick,at,tempo)
        else:
            points.append((tick,at,tempo))
    return points


def tick_seconds(tick,points,tpb):
    point=points[max(0,bisect.bisect_right([p[0] for p in points],tick)-1)]
    return point[1]+mido.tick2second(tick-point[0],tpb,point[2])


def seconds_tick(seconds,points,tpb):
    point=points[max(0,bisect.bisect_right([p[1] for p in points],seconds)-1)]
    return round(point[0]+mido.second2tick(seconds-point[1],tpb,point[2]))


def read_midi(path):
    midi=mido.MidiFile(path)
    if midi.type == 2:
        raise ValueError('Asynchronous MIDI tracks are not supported')
    points=tempo_map(midi)
    notes,tracks=[],[]
    for index,track in enumerate(midi.tracks):
        tick=0
        active=defaultdict(deque)
        meta={'name':track.name or f'Track {index+1}','program':0,'is_drum':False}
        for msg in track:
            tick+=msg.time
            seconds=tick_seconds(tick,points,midi.ticks_per_beat)
            if msg.type=='program_change':
                meta['program']=msg.program
            if msg.type=='note_on' and msg.velocity>0:
                active[(msg.channel,msg.note)].append((seconds,msg.velocity))
                if msg.channel==9:
                    meta['is_drum']=True
            elif msg.type=='note_off' or msg.type=='note_on' and msg.velocity==0:
                key=(msg.channel,msg.note)
                if active[key]:
                    start,velocity=active[key].popleft()
                    if seconds>start:
                        notes.append({'id':f'n{len(notes)}','pitch':msg.note,'start':start,'end':seconds,'velocity':velocity,'track':index,'channel':msg.channel})
        tracks.append(meta)
    return {'notes':sorted(notes,key=lambda n:(n['start'],n['pitch'])),'tracks':tracks,'duration':max([n['end'] for n in notes]+[midi.length])}


def validate_midi(content,original):
    if not isinstance(content,dict) or not isinstance(content.get('notes'),list):
        raise ValueError('MIDI notes must be a list')
    if content.get('tracks') != original['tracks']:
        raise ValueError('Track settings cannot be changed in this editor')
    if len(content['notes'])>100000:
        raise ValueError('This document has too many notes')
    ids=set()
    for note in content['notes']:
        if not isinstance(note,dict) or not isinstance(note.get('id'),str) or note['id'] in ids:
            raise ValueError('Every note needs a unique identifier')
        ids.add(note['id'])
        for key,lo,hi in [('pitch',0,127),('velocity',1,127),('track',0,len(original['tracks'])-1),('channel',0,15)]:
            value=note.get(key,0 if key=='channel' else None)
            if type(value) is not int or not lo<=value<=hi:
                raise ValueError(f'Invalid note {key}')
        if any(type(note.get(k)) not in (int,float) or not math.isfinite(note[k]) for k in ('start','end')) or not 0<=note['start']<note['end']<=86400:
            raise ValueError('A note needs a nonnegative start and a later end (within 24 hours)')
    return dict(content,duration=max([n['end'] for n in content['notes']]+[original['duration']]))


def write_midi(path,content):
    midi=mido.MidiFile(path)
    points=tempo_map(midi)
    for index,track in enumerate(midi.tracks):
        events=[]
        tick=0
        original_end=0
        for msg in track:
            tick+=msg.time
            original_end=tick
            if msg.type not in ('note_on','note_off','end_of_track'):
                events.append((tick,0,msg.copy()))
        for note in content['notes']:
            if note['track']!=index:
                continue
            start=seconds_tick(note['start'],points,midi.ticks_per_beat)
            end=max(start+1,seconds_tick(note['end'],points,midi.ticks_per_beat))
            channel=note.get('channel',9 if content['tracks'][index]['is_drum'] else 0)
            events.append((start,2,mido.Message('note_on',note=note['pitch'],velocity=note['velocity'],channel=channel)))
            events.append((end,1,mido.Message('note_off',note=note['pitch'],velocity=0,channel=channel)))
        replacement=mido.MidiTrack()
        prev=0
        for tick,_,msg in sorted(events,key=lambda e:(e[0],e[1])):
            replacement.append(msg.copy(time=tick-prev))
            prev=tick
        replacement.append(mido.MetaMessage('end_of_track',time=max(0,original_end-prev)))
        midi.tracks[index]=replacement
    stream=io.BytesIO()
    midi.save(file=stream)
    return stream.getvalue()


FRIENDLY_TRACKS={'ins':'Instruments','vocal':'Vocal melody','chords':'Chords'}


def friendly_track_name(name, index=0):
    """What a track is called to people: SheetSage names them Vocal, Ins and Chords."""
    clean = (name or '').strip()
    return FRIENDLY_TRACKS.get(clean.lower()) or clean or f'Track {index+1}'


def split_tracks(data):
    """One standalone MIDI file per track that has notes, as [(track name, bytes)].
    Every file keeps the tempo and time-signature track, so each opens at the right speed on its own."""
    source = mido.MidiFile(file=io.BytesIO(data))
    has_notes = lambda track: any(m.type in ('note_on', 'note_off') for m in track)
    conductor = [track for track in source.tracks if not has_notes(track)]
    files = []
    for index, track in enumerate(source.tracks):
        if not has_notes(track):
            continue
        out = mido.MidiFile(type=1, ticks_per_beat=source.ticks_per_beat)
        for other in conductor:
            out.tracks.append(mido.MidiTrack(other.copy()))
        out.tracks.append(mido.MidiTrack(track.copy()))
        stream = io.BytesIO()
        out.save(file=stream)
        files.append((friendly_track_name(track.name, index), stream.getvalue()))
    return files
