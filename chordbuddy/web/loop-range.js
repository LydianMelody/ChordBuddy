// Pure helpers for loop ranges on the navigation bar. No DOM, no transport.
import {musicalPosition} from './musical-grid.js';

// Zoomed in at least this far (song length / visible span) the loop snaps to beats; otherwise to bars.
export const BEAT_ZOOM=4;

export function snapGrain(duration,viewport){
  const span=Math.max(.001,(viewport?.end??duration)-(viewport?.start??0));
  return duration/span>=BEAT_ZOOM?'beat':'bar';
}

// Sorted, de-duplicated times a loop edge may land on. grain 'free' (the magnet off): none, an edge goes exactly where it is dropped.
export function snapPoints(measures,grain){
  const points=[];
  if(grain==='free')return points;
  for(const measure of measures||[]){
    if(grain==='beat')points.push(...(measure.beats?.length?measure.beats:[measure.start]));
    else points.push(measure.start);
  }
  const last=measures?.at(-1);if(last)points.push(last.end);
  return [...new Set(points.filter(Number.isFinite))].sort((a,b)=>a-b);
}

export function snapTime(points,seconds){
  if(!points.length)return seconds;
  let best=points[0];
  for(const point of points)if(Math.abs(point-seconds)<Math.abs(best-seconds))best=point;
  return best;
}

// Drag from a to b (either order). Both edges snap; a zero-length result widens to the next grid line.
export function snapRange(measures,a,b,{grain,duration}){
  const points=snapPoints(measures,grain),low=Math.min(a,b),high=Math.max(a,b);
  let start=snapTime(points,low),end=snapTime(points,high);
  if(!points.length){start=Math.max(0,low);end=Math.min(duration,high);}
  if(end<=start){
    const next=points.find(point=>point>start+1e-6);
    if(next!==undefined)end=next;
    else{// at the very end of the song: widen backwards to the previous grid line
      end=start;start=points.filter(point=>point<end-1e-6).at(-1)??Math.max(0,end-1);
    }
  }
  return {start:Math.max(0,start),end:Math.min(duration,end)};
}

// Move one edge of an existing range while keeping at least one grid step between the edges.
export function moveEdge(measures,range,edge,seconds,{grain,duration}){
  const points=snapPoints(measures,grain);
  const snapped=points.length?snapTime(points,seconds):seconds;
  if(edge==='start'){
    const limit=points.filter(point=>point<range.end-1e-6).at(-1)??Math.max(0,range.end-.1);
    return {start:Math.max(0,Math.min(snapped,limit)),end:range.end};
  }
  const limit=points.find(point=>point>range.start+1e-6)??Math.min(duration,range.start+.1);
  return {start:range.start,end:Math.min(duration,Math.max(snapped,limit))};
}

// Drag one edge, and when it is pulled past the other edge the two swap roles: the start dragged beyond the end becomes the end.
// range is the loop as it was when the drag began (its other edge stays put). Returns {range, edge} (edge: the one now being dragged).
export function dragEdge(measures,range,edge,seconds,options){
  const fixed=edge==='start'?range.end:range.start;
  const now=edge==='start'?(seconds>fixed?'end':'start'):(seconds<fixed?'start':'end');
  return {range:moveEdge(measures,{start:fixed,end:fixed},now,seconds,options),edge:now};
}

export function sectionAtSeconds(sections,seconds){
  return (sections||[]).find(section=>seconds>=section.start&&seconds<section.end)||null;
}

// "Bars 5–9" style label for a range.
export function describeRange(measures,range){
  const first=musicalPosition(measures,range.start),last=musicalPosition(measures,Math.max(range.start,range.end-1e-6));
  if(!first||!last)return 'Loop';
  return first.bar===last.bar?`Bar ${first.bar}`:`Bars ${first.bar}–${last.bar}`;
}

export const SPEED_MIN=50,SPEED_MAX=125,SPEED_STEP=5;
export const stepSpeed=(percent,direction)=>Math.max(SPEED_MIN,Math.min(SPEED_MAX,Math.round((percent+direction*SPEED_STEP)/SPEED_STEP)*SPEED_STEP));

// R loops the section you are in. An intro starts at bar 1 and leaves out a fade-in (and the silent lead-in before bar 1); an outro that
// fades out loops only its first four bars at full volume. fades: {fadeIn:{end}, fadeOut:{start}} as found by fade-out.js; musicStart:
// where bar 1 begins. Any other section, or one with no whole bars left, loops whole.
const INTRO=/\bintro\b/i,OUTRO=/\boutro\b/i,SLACK=.05;
export function sectionLoopRange(section,measures,{fadeIn=null,fadeOut=null,musicStart=null}={},bars=4){
  const whole={start:section.start,end:section.end};
  const inside=(measures||[]).filter(m=>m.start>=section.start-SLACK&&m.end<=section.end+SLACK);
  if(INTRO.test(section.name||'')){
    const first=inside.find(m=>!(fadeIn&&m.start<fadeIn.end-SLACK)&&!(Number.isFinite(musicStart)&&m.start<musicStart-SLACK));
    return first?{start:first.start,end:section.end}:whole;
  }
  if(OUTRO.test(section.name||'')&&fadeOut&&fadeOut.start<section.end-SLACK){
    const picked=inside.filter(m=>m.end<=fadeOut.start+SLACK).slice(0,bars);
    return picked.length?{start:picked[0].start,end:picked.at(-1).end}:whole;
  }
  return whole;
}

// L loops four bars: the four-bar block of the section you are in (its bars 1-4, 5-8, ...; an intro counts from bar 1), or, inside a
// phrase the chart repeats (×4, ×8 ...), the pass you are in. phrases: the passes [{start,end}] of every repeated phrase.
export function barLoopRange(section,measures,seconds,{phrases=[],musicStart=null}={},bars=4){
  const pass=phrases.find(p=>seconds>=p.start-SLACK&&seconds<p.end-SLACK);
  if(pass)return {start:pass.start,end:pass.end};
  const inside=(measures||[]).filter(m=>m.start>=section.start-SLACK&&m.start<section.end-SLACK&&!(Number.isFinite(musicStart)&&m.start<musicStart-SLACK));
  if(!inside.length)return {start:section.start,end:section.end};
  const at=Math.max(0,inside.findLastIndex(m=>m.start<=seconds+SLACK)),block=inside.slice(at-at%bars,at-at%bars+bars);
  return {start:block[0].start,end:Math.min(section.end,block.at(-1).end)};
}
