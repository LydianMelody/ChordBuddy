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
// With the magnet on, the grid follows the zoom: the finest of 1/4, 1/8, 1/16 and 1/32 whose lines are still at least 20px apart.
// With it off, a word lands exactly where it is dropped ('free'); the grid is still drawn by the zoom.
export const SNAP_MIN_PX=20;
export function autoSnap(zoom){
  const beat=beatPx(zoom);
  for(const [name,parts] of [['thirty-second',8],['sixteenth',4],['eighth',2]])if(beat/parts>=SNAP_MIN_PX)return name;
  return 'quarter';
}

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
export function barWidths(bars,lanes,perBeat,{gap=8,capPerBeat=Infinity}={}){
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
  // A run of quick syllables must not stretch a bar without limit: the page stacks crowded words on a second row instead (see staggerRows).
  for(const bar of bars){const beats=beatsOf.get(bar.id);width.set(bar.id,Math.min(width.get(bar.id),Math.max(beats*perBeat,beats*capPerBeat)));}
  return width;
}

// Rows for words that would touch: items [{x,width}] sorted by x get the first row whose last word ends before they start.
// Returns the row of each item and how many rows were needed.
export function staggerRows(items,gap=8){
  const ends=[],rows=[];
  for(const item of items){let r=0;while(r<ends.length&&ends[r]+gap>item.x)r++;ends[r]=item.x+item.width;rows.push(r);}
  return {rows,count:Math.max(1,ends.length)};
}

// Bar widths for a zoom level. Zooming in never makes a bar narrower: the width needed to keep words apart depends on how wide the
// neighbouring bars are, so on its own it can shrink as the zoom grows (a bar went 1135, 879, 538, 538, 768 px over the zoom levels).
// Taking the widest a bar has been at any smaller zoom makes zoom predictable.
export function barWidthsAtZoom(bars,lanes,zoom,options){
  const levels=[...new Set([...ZOOM_LEVELS.filter(z=>z<zoom-1e-9),zoom])].sort((a,b)=>a-b);
  const widest=new Map();
  for(const level of levels)for(const [id,width] of barWidths(bars,lanes,beatPx(level),options))widest.set(id,Math.max(widest.get(id)||0,width));
  return widest;
}

// ---- snapping ----
// Candidate drop points inside one bar: grid lines, chord onsets and existing pins. Each has a beat (0..beats) and seconds.
export function barTargets(measure,{snap=DEFAULT_SNAP,onsets=[],pins=[]}={}){
  const result=buildPlacementTargets([measure],{snap,anchors:pins.map(p=>({measure_id:measure.id,beat:p})),onsets});
  let targets=result.targets.map(t=>({beat:t.address.beat,seconds:t.seconds,kinds:t.kinds,position:t.position}));
  // The musical grid is only trusted when every beat of the bar has a quarter-note label. With gaps (a 6/8 bar whose beats are
  // eighths came out labeled 0, 1, 2, then nothing) its lines land in the wrong places and cover only part of the bar, so the bar
  // is divided evenly by its own beats instead; saved pins, chord onsets and melody notes still count.
  const q=measure.quarter_positions,n=measure.beats?.length||0;
  const complete=Array.isArray(q)&&q.length===n+1&&q.every((v,i)=>Number.isFinite(v)&&(!i||v>q[i-1]));
  if(!complete)targets=targets.filter(t=>t.kinds.some(k=>k!=='grid'));
  if(!targets.length||!complete){
    // beats can be eighths (6/8) or quarters: one beat is 4/meter[1] quarter notes long
    const beatQuarters=measure.meter?.[1]>0?4/measure.meter[1]:1,step=(SNAP_QUARTERS[snap]||.5)/beatQuarters;
    for(let b=0;b<n-1e-9;b+=step){
      let seconds;try{seconds=secondsAtAddress([measure],{measure_id:measure.id,beat:b});}catch{continue;}   // no timing for this beat
      const near=targets.find(t=>Math.abs(t.seconds-seconds)<1e-6);
      if(near){if(!near.kinds.includes('grid'))near.kinds.push('grid');continue;}
      targets.push({beat:b,seconds,kinds:['grid'],position:null});
    }
  }
  return targets.sort((a,b)=>a.beat-b.beat);
}
// The target nearest to a position inside a bar (x pixels from the bar's left edge, bar `width` wide).
export function nearestTarget(targets,x,width,beats,beatOf=null){
  if(!targets.length)return null;
  const beat=Math.max(0,Math.min(beats,beatOf?beatOf(x):x/width*beats));
  let best=targets[0];for(const t of targets)if(Math.abs(t.beat-beat)<Math.abs(best.beat-beat))best=t;
  return best;
}
export const beatToX=(beat,width,beats)=>beat/beats*width;

// ---- compressed row layout ----
// A bar is not scaled evenly any more: the stretches between words (and chords) shrink to COMPRESS of a normal beat, and a stretch grows
// only as far as the word before it needs. A bar whose words all fit keeps its normal width, spread evenly, as before; a bar with one
// crowded spot no longer stretches all of itself to make room there. Each bar is a list of knots (beat -> pixels from the bar's left edge)
// with straight lines between them.
export const COMPRESS=.3;
export function layoutRowBars(bars,lanes,perBeat,{gap=8,compress=COMPRESS}={}){
  const index=new Map(bars.map((b,i)=>[b.id,i])),beatsOf=bars.map(b=>Math.max(1,b.beats||4)),near=1e-6;
  const knotBeats=bars.map((b,i)=>new Set([0,beatsOf[i]]));
  const items=lanes.map(lane=>lane.filter(it=>index.has(it.barId)).map(it=>({...it,at:index.get(it.barId),beat:Math.max(0,Math.min(beatsOf[index.get(it.barId)],it.beat))}))
    .sort((a,b)=>a.at-b.at||a.beat-b.beat));
  for(const lane of items)for(const it of lane)knotBeats[it.at].add(it.beat);
  // every bar: its sorted beats (ones closer than `near` merged) and the width of the stretch from each to the next
  const knots=knotBeats.map(set=>{const out=[];for(const v of [...set].sort((a,b)=>a-b))if(!out.length||v-out.at(-1)>near)out.push(v);return out;});
  const segs=knots.map(list=>list.slice(1).map((v,k)=>({d:v-list[k],w:(v-list[k])*perBeat*compress})));
  const knotOf=(at,beat)=>{let best=0;knots[at].forEach((v,k)=>{if(Math.abs(v-beat)<Math.abs(knots[at][best]-beat))best=k;});return best;};
  // the stretches lying between two points of the row
  const between=(a,b)=>{
    const out=[],ka=knotOf(a.at,a.beat),kb=knotOf(b.at,b.beat);
    if(a.at===b.at){for(let k=ka;k<kb;k++)out.push(segs[a.at][k]);return out;}
    for(let k=ka;k<segs[a.at].length;k++)out.push(segs[a.at][k]);
    for(let k=0;k<kb;k++)out.push(segs[b.at][k]);
    return out;
  };
  const widen=(list,need)=>{
    const have=list.reduce((sum,s)=>sum+s.w,0);if(have>=need-1e-9||!list.length)return;
    const weight=list.reduce((sum,s)=>sum+Math.max(s.d,1e-3),0);
    for(const s of list)s.w+=(need-have)*Math.max(s.d,1e-3)/weight;
  };
  for(const lane of items){
    for(let k=0;k<lane.length;k++){
      const a=lane[k],b=lane[k+1],need=a.width+gap;
      if(b&&b.at-a.at<=1){if(b.at!==a.at||b.beat-a.beat>near)widen(between(a,b),need);continue;}
      // the last word of a lane (or the last before a gap of bars): keep it inside its bar unless it sits right at the barline
      if(beatsOf[a.at]-a.beat>=.5)widen(between(a,{at:a.at,beat:beatsOf[a.at]}),need);
    }
  }
  // a bar is never narrower than its normal width: what is left over is shared evenly between its stretches
  const result=new Map();
  bars.forEach((b,i)=>{
    const total=segs[i].reduce((sum,s)=>sum+s.w,0),slack=Math.max(0,beatsOf[i]*perBeat-total);
    let x=0;const out=[{beat:0,x:0}];
    segs[i].forEach((s,k)=>{x+=s.w+slack*s.d/beatsOf[i];out.push({beat:knots[i][k+1],x});});
    result.set(b.id,{width:x,knots:out});
  });
  return result;
}
// Pixels from the bar's left edge for a beat, and the beat at a pixel position, along a bar's knots.
export function xOfKnots(knots,beat){
  if(!knots?.length)return 0;
  if(beat<=knots[0].beat)return knots[0].x;
  for(let i=1;i<knots.length;i++)if(beat<=knots[i].beat){const a=knots[i-1],b=knots[i];return a.x+(beat-a.beat)/(b.beat-a.beat)*(b.x-a.x);}
  return knots.at(-1).x;
}
export function beatOfKnots(knots,x){
  if(!knots?.length)return 0;
  if(x<=knots[0].x)return knots[0].beat;
  for(let i=1;i<knots.length;i++)if(x<=knots[i].x){const a=knots[i-1],b=knots[i];return b.x>a.x?a.beat+(x-a.x)/(b.x-a.x)*(b.beat-a.beat):a.beat;}
  return knots.at(-1).beat;
}
