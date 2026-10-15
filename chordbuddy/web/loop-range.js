// Pure helpers for loop ranges on the navigation bar. No DOM, no transport.
import {musicalPosition} from './musical-grid.js';

// Zoomed in at least this far (song length / visible span) the loop snaps to beats; otherwise to bars.
export const BEAT_ZOOM=4;

export function snapGrain(duration,viewport){
  const span=Math.max(.001,(viewport?.end??duration)-(viewport?.start??0));
  return duration/span>=BEAT_ZOOM?'beat':'bar';
}

// Sorted, de-duplicated times a loop edge may land on.
export function snapPoints(measures,grain){
  const points=[];
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
