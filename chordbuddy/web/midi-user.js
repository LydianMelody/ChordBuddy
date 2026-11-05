// Your own MIDI files on a song, made ready for the visualizer and the import screen. Pure, so it can be tested.
// Each file is kept beside the song with its settings: {alignment (midi-align.js), parts:{sourceId:{use}}}. A part can replace what the
// model wrote ('vocal' or 'instrumental', for visuals only: the chart, the MIDI tab and the model's files are never changed), be an extra
// a visual can use ('extra'), or be left out ('off'). Only what a file really contains is offered (describeSignals).
import {parseMidi,timeMap,extractSources,describeSignals} from './midi-file.js';
import {songGrid,placement,placeNotes,placePoints,defaultAlignment,cleanAlignment} from './midi-align.js';

export const USES=[['extra','Visual extra'],['vocal','Replace the vocal melody'],['instrumental','Replace the instrumental melody'],['off','Leave out']];
export const REPLACEABLE=['vocal','instrumental'];

/** A parsed file, ready to place: {parsed, sources, clock:{ticksPerQuarter,hasTempo,timeSignatures,seconds,tick}, lastTick}. */
export function readFile(bytes){
  const parsed=parseMidi(bytes),map=timeMap(parsed),sources=extractSources(parsed);
  let lastTick=0;for(const s of sources)for(const n of s.notes)lastTick=Math.max(lastTick,n.endTick);
  if(!lastTick)lastTick=parsed.length||0;
  return {parsed,sources,lastTick,clock:{ticksPerQuarter:parsed.ticksPerQuarter,hasTempo:parsed.hasTempo,timeSignatures:parsed.timeSignatures,seconds:map.seconds,tick:map.tick}};
}

/** What a part should be used as when nobody has said: the tracks Chord Buddy writes into a custom file replace what they came from. */
export function suggestedUse(source){
  const name=String(source.name||'').trim().toLowerCase();
  if(name==='vocal melody')return 'vocal';
  if(name==='instruments'||name==='instrumental melody')return 'instrumental';
  return 'extra';
}
/** The uses of the parts the file really has now (a part a new export dropped is gone; a new one gets its suggested use), at most one part
 *  per replaced melody. */
export function cleanParts(settings,file){
  const parts={},taken=new Set();
  for(const source of file.sources){
    let use=settings?.parts?.[source.id]?.use;
    if(!USES.some(([id])=>id===use))use=suggestedUse(source);
    if(REPLACEABLE.includes(use)){if(taken.has(use)||!source.notes.length)use='extra';else taken.add(use);}
    parts[source.id]={use};
  }
  return parts;
}
/** Settings with every part of the file given a use (cleanParts) and a tidy alignment. */
export function cleanSettings(settings,file,{grid,duration=0,firstBar=0}={}){
  const parts=cleanParts(settings,file);
  const alignment=settings?.alignment?cleanAlignment(settings.alignment):defaultAlignment(file.clock,grid,{duration,firstBar,lastTick:file.lastTick});
  return {version:1,alignment,parts};
}

// Unique names for the extras across all files: a visual looks them up by name ("Bass", "Bass 2").
function uniqueName(name,used){let n=name||'MIDI',i=2;while(used.has(n.toLowerCase()))n=`${name} ${i++}`;used.add(n.toLowerCase());return n;}

/**
 * Everything the visualizer uses from a song's files. files: [{id, name, file (readFile), settings}]; measures: the chart's bars.
 * Returns {replace:{vocal?:notes, instrumental?:notes}, extras:[{id, file, name, kind, signals, notes, controls:{key:[{time,value}]}}]}
 * with times in song seconds. Notes keep their velocity; extras' `notes` carry per-note bend/pressure/slide as [{time,value}] when present.
 */
export function songParts(files,measures,{duration=0,firstBar=0}={}){
  const grid=songGrid(measures),replace={},extras=[],used=new Set();
  for(const entry of files||[]){
    if(!entry?.file)continue;
    const settings=cleanSettings(entry.settings,entry.file,{grid,duration,firstBar}),place=placement(grid,entry.file.clock,settings.alignment);
    for(const source of entry.file.sources){
      const use=settings.parts[source.id]?.use;if(use==='off')continue;
      const notes=placeNotes(source.notes,place).map(n=>{
        const out={start:n.start,end:n.end,pitch:n.pitch,velocity:n.velocity};
        for(const k of ['bend','pressure','slide'])if(n[k]?.length)out[k]=placePoints(n[k],place);
        return out;
      });
      if(REPLACEABLE.includes(use)&&!replace[use]){replace[use]=notes;continue;}
      const controls={};for(const [key,points] of Object.entries(source.controls||{}))if(points?.length)controls[key]=placePoints(points,place);
      extras.push({id:`${entry.id}:${source.id}`,file:entry.id,name:uniqueName(source.name,used),kind:source.kind,signals:describeSignals(source),notes,controls});
    }
  }
  return {replace,extras};
}

/** For the visualizer: a song's MIDI files, fetched and read. entries: the server's list; fetch(path) -> ArrayBuffer. */
export async function loadSongFiles(songId,entries,fetchBytes,cache=new Map()){
  const out=[];
  for(const e of entries||[]){
    const key=`${e.id}:${e.mtime}`;
    try{if(!cache.has(key))cache.set(key,readFile(new Uint8Array(await fetchBytes(`/api/user-midi/${encodeURIComponent(songId)}/${e.id}`))));
      out.push({id:e.id,name:e.name,file:cache.get(key),settings:e.settings});}catch{/* a damaged file is skipped, not fatal */}
  }
  return out;
}
