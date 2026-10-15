// Timing mode geometry. Pure: numbers in, numbers out, no DOM.
//
// Rules the page relies on:
//  - a word can be dragged anywhere between its nearest fixed neighbours (pinned words, older chord bindings, or the row
//    ends) on the same line: it may cross barlines, but it can never pass another word or leave its line;
//  - while one word is dragged, the unpinned words between its fixed neighbours slide with it (puppet warp);
//  - every bar has its own width, wide enough that nothing overlaps; barlines alone show the timing;
//  - a pointer position snaps to the grid (or a chord onset or an existing pin).
import {spreadBetween} from './word-layout.js';
import {buildPlacementTargets,secondsAtAddress,SNAP_QUARTERS} from './musical-grid.js';

export const ZOOM_LEVELS=Object.freeze([.75,1,1.5,2,3,4,6]);
export const DEFAULT_ZOOM=2,BEAT_PX=32;
export const beatPx=zoom=>BEAT_PX*zoom;
export const SNAPS=Object.freeze([['quarter','1/4'],['eighth','1/8'],['sixteenth','1/16'],['thirty-second','1/32']]);
export const DEFAULT_SNAP='eighth';

export function stepZoom(zoom,direction){
  const i=ZOOM_LEVELS.reduce((best,z,n)=>Math.abs(z-zoom)<Math.abs(ZOOM_LEVELS[best]-zoom)?n:best,0);
  return ZOOM_LEVELS[Math.max(0,Math.min(ZOOM_LEVELS.length-1,i+direction))];
}

export const isFixed=token=>token.kind==='pin'||token.kind==='chord';

// Earliest and latest time word `index` may be dragged to. A fixed neighbour is a hard wall: two pins can never share an
// instant, so a word must land strictly between them. The ends of the row are inclusive.
export function dragLimits(times,fixed,index,rowStart,rowEnd){
  let left=rowStart,right=rowEnd,leftFixed=false,rightFixed=false;
  for(let i=index-1;i>=0;i--)if(fixed[i]){left=times[i];leftFixed=true;break;}
  for(let i=index+1;i<times.length;i++)if(fixed[i]){right=times[i];rightFixed=true;break;}
  return {left:Math.max(rowStart,left),right:Math.min(rowEnd,Math.max(left,right)),leftFixed,rightFixed};
}
const EDGE=1e-6;
export function allowedTime(time,limits){
  return (limits.leftFixed?time>limits.left+EDGE:time>=limits.left-EDGE)&&(limits.rightFixed?time<limits.right-EDGE:time<=limits.right+EDGE);
}
// Of the candidate drop points ({seconds}), the one nearest `wanted` that is allowed, or null if there is no room.
export function nearestAllowed(candidates,wanted,limits){
  let best=null;
  for(const c of candidates){
    if(!allowedTime(c.seconds,limits))continue;
    if(!best||Math.abs(c.seconds-wanted)<Math.abs(best.seconds-wanted))best=c;
  }
  return best;
}

// Where every word would be with word `index` pinned at `time` (the other pins stay where they are).
export function previewTimes(times,fixed,index,time,lineStart,lineEnd){
  const f=times.map((t,i)=>fixed[i]&&i!==index?t:null);
  f[index]=time;if(f[0]===null)f[0]=lineStart;
  return spreadBetween(f,lineEnd);
}
// Where every word would be with word `index` released.
export function releasedTimes(times,fixed,index,lineStart,lineEnd){
  const f=times.map((t,i)=>fixed[i]&&i!==index?t:null);
  if(f[0]===null)f[0]=lineStart;
  return spreadBetween(f,lineEnd);
}

// ---- bar widths ----
// bars: [{id, beats}]; lanes: [[{barId, beat, width}]] (words of one line, chords, ...) in time order.
// Every bar is at least `beats * beatPx` wide and wider where the words in a lane would otherwise touch.
export function barWidths(bars,lanes,perBeat,{gap=8}={}){
  const width=new Map(bars.map(b=>[b.id,Math.max(1,b.beats||4)*perBeat]));
  const beatsOf=new Map(bars.map(b=>[b.id,Math.max(1,b.beats||4)]));
  const index=new Map(bars.map((b,i)=>[b.id,i]));
  for(const lane of lanes){
    const items=lane.filter(item=>index.has(item.barId)).sort((a,b)=>index.get(a.barId)-index.get(b.barId)||a.beat-b.beat);
    for(let k=0;k<items.length;k++){
      const a=items[k],b=items[k+1],n=beatsOf.get(a.barId);
      if(!b){
        // the last word of a lane: keep it inside its bar unless it sits right at the barline
        const room=n-a.beat;if(room>=.5)width.set(a.barId,Math.max(width.get(a.barId),(a.width+gap)*n/room));
        continue;
      }
      if(a.barId===b.barId){
        const delta=b.beat-a.beat;if(delta>1e-6)width.set(a.barId,Math.max(width.get(a.barId),(a.width+gap)*n/delta));
      }else if(index.get(b.barId)===index.get(a.barId)+1){
        // across a barline: the room left in this bar plus the room before the next word in the next bar
        const next=b.beat/beatsOf.get(b.barId)*width.get(b.barId),room=n-a.beat;
        if(room>1e-6){const need=((a.width+gap)-next)*n/room;if(need>0)width.set(a.barId,Math.max(width.get(a.barId),need));}
      }
    }
  }
  return width;
}

// ---- snapping ----
// Candidate drop points inside one bar: grid lines, chord onsets and existing pins. Each has a beat (0..beats) and seconds.
export function barTargets(measure,{snap=DEFAULT_SNAP,onsets=[],pins=[]}={}){
  const result=buildPlacementTargets([measure],{snap,anchors:pins.map(p=>({measure_id:measure.id,beat:p})),onsets});
  let targets=result.targets.map(t=>({beat:t.address.beat,seconds:t.seconds,kinds:t.kinds,position:t.position}));
  if(!targets.length){
    // no musical grid for this bar: fall back to subdividing its beats
    const step=SNAP_QUARTERS[snap]||.5,n=measure.beats?.length||0;
    for(let b=0;b<n-1e-9;b+=step){try{targets.push({beat:b,seconds:secondsAtAddress([measure],{measure_id:measure.id,beat:b}),kinds:['grid'],position:null});}catch{/* no timing for this beat */}}
  }
  return targets.sort((a,b)=>a.beat-b.beat);
}
// The target nearest to a position inside a bar (x pixels from the bar's left edge, bar `width` wide).
export function nearestTarget(targets,x,width,beats){
  if(!targets.length)return null;
  const beat=Math.max(0,Math.min(beats,x/width*beats));
  let best=targets[0];for(const t of targets)if(Math.abs(t.beat-beat)<Math.abs(best.beat-beat))best=t;
  return best;
}
export const beatToX=(beat,width,beats)=>beat/beats*width;
