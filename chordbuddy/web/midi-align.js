// Lining up a MIDI file someone brings (exported from Reaper or any DAW) with a song's recording. Pure, so it can be tested.
//
// A MIDI file keeps its notes in beats; its tempo is only a label that turns beats into seconds, and a wrong one (files that say 120
// because nobody set it) leaves the notes right in musical terms. So there are two ways to place a file:
//   'beats'  follow the song's beats: the file's quarter notes are laid on the beats the app found in the recording, so a missing or wrong
//            tempo, drift and a live feel all come out right. Positions on the song are counted in its beats (0 = the first beat found).
//   'tempo'  use the file's own tempo, in seconds: right for a file made over this very recording (a Reaper export from the project).
// Either way, the placement is: where the file's start lands on the song (`start`), how many song units one file unit takes (`ratio`:
// half time, double time, a 6/8 felt in 2...), and anchors, like Reaper's stretch markers: a moment in the file pinned to a moment in the
// song. One anchor moves the whole file; two or more stretch the file between them (and past them at the nearest pair's rate).
// Alignment never changes the file: it is kept beside it as settings ({mode,start,ratio,anchors,transpose}).
import {chordTones} from './visual-harmony.js';

export const MODES=['beats','tempo'];
export const RATIOS=[0.5,2/3,1,1.5,2];          // the stretches worth trying when guessing: half, a 6/8 felt in 2, as is, ..., double

// ---- the song's grid: every beat the app found, as one list ------------------------------------------------------------------------
/** measures: [{start,end,beats:[seconds]}] (the chart's bars). Returns {beats:[seconds], bars:[index of each bar's first beat], end}. */
export function songGrid(measures){
  const beats=[],bars=[];
  for(const m of measures||[]){
    const own=(m.beats?.length?m.beats:[m.start]).filter(t=>Number.isFinite(t)&&(!beats.length||t>beats.at(-1)+1e-6));
    if(!own.length)continue;bars.push(beats.length);beats.push(...own);
  }
  const last=(measures||[]).at(-1);
  return {beats,bars,end:Number.isFinite(last?.end)&&last.end>(beats.at(-1)??-Infinity)?last.end:null};
}
// The beat points with the last bar's end as one more, so the final beat has a length too.
const points=grid=>grid.end!=null?[...grid.beats,grid.end]:grid.beats;
const step=(p,i)=>p.length>1?p[Math.max(1,Math.min(p.length-1,i))]-p[Math.max(1,Math.min(p.length-1,i))-1]:0.5;

/** Seconds at a song beat position (fractional; before the first beat or past the last, at the nearest beat's length). */
export function beatSeconds(grid,position){
  const p=points(grid);if(!p.length)return position*0.5;
  if(position<=0)return p[0]+position*step(p,1);
  const i=Math.floor(position);
  if(i>=p.length-1)return p.at(-1)+(position-(p.length-1))*step(p,p.length-1);
  return p[i]+(position-i)*(p[i+1]-p[i]);
}
/** The song beat position (fractional) at a time in seconds: the inverse of beatSeconds. */
export function secondsBeat(grid,seconds){
  const p=points(grid);if(!p.length)return seconds/0.5;
  if(seconds<=p[0])return (seconds-p[0])/step(p,1);
  if(seconds>=p.at(-1))return p.length-1+(seconds-p.at(-1))/step(p,p.length-1);
  let lo=0,hi=p.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(p[mid]<=seconds)lo=mid;else hi=mid;}
  return lo+(seconds-p[lo])/(p[hi]-p[lo]);
}
/** The song beat position of a bar (0-based index into the chart's bars). */
export const barBeat=(grid,bar)=>grid.bars[Math.max(0,Math.min(grid.bars.length-1,bar))]??0;
/** The bar (0-based) a song beat position falls in. */
export function beatBar(grid,position){
  let lo=0,hi=grid.bars.length-1,found=0;
  while(lo<=hi){const mid=(lo+hi)>>1;if(grid.bars[mid]<=position+1e-9){found=mid;lo=mid+1;}else hi=mid-1;}
  return found;
}

// ---- placing a file ---------------------------------------------------------------------------------------------------------------
// file: {ticksPerQuarter, seconds(tick)} (midi-file.js's timeMap gives seconds). A file with an SMPTE clock has no quarter notes,
// so it can only be placed by its seconds.
const filePosition=(file,mode,tick)=>mode==='tempo'||!file.ticksPerQuarter?file.seconds(tick):tick/file.ticksPerQuarter;
const songPosition=(grid,mode,seconds)=>mode==='tempo'?seconds:secondsBeat(grid,seconds);
const positionSeconds=(grid,mode,position)=>mode==='tempo'?position:beatSeconds(grid,position);

/** A tidy alignment: unknown keys dropped, numbers kept finite, anchors sorted by tick with one per tick. */
export function cleanAlignment(a={}){
  const mode=MODES.includes(a.mode)?a.mode:'beats';
  const ratio=Number.isFinite(a.ratio)&&a.ratio>0.05&&a.ratio<20?a.ratio:1;
  const start=Number.isFinite(a.start)?a.start:0;
  const transpose=Number.isInteger(a.transpose)&&Math.abs(a.transpose)<=48?a.transpose:0;
  const anchors=[];
  for(const x of [...(Array.isArray(a.anchors)?a.anchors:[])].filter(x=>Number.isFinite(x?.tick)&&Number.isFinite(x?.time)).sort((p,q)=>p.tick-q.tick))
    if(!anchors.length||x.tick>anchors.at(-1).tick&&x.time>anchors.at(-1).time)anchors.push({tick:x.tick,time:x.time});
  return {mode,start,ratio,anchors,transpose};
}

/**
 * The placement as functions: seconds(tick) on the song, and tick(seconds) back. grid: songGrid(); file: {ticksPerQuarter, seconds}.
 * With no anchors: song position = start + file position x ratio. One anchor: the same rate, through the anchor. Two or more: straight
 * lines between anchors, and past the ends the rate of the nearest pair.
 */
export function placement(grid,file,alignment){
  const a=cleanAlignment(alignment),mode=!file.ticksPerQuarter?'tempo':a.mode;
  const knots=a.anchors.map(x=>({f:filePosition(file,mode,x.tick),s:songPosition(grid,mode,x.time)}));
  const map=f=>{
    if(!knots.length)return a.start+f*a.ratio;
    if(knots.length===1)return knots[0].s+(f-knots[0].f)*a.ratio;
    let i=0;while(i<knots.length-2&&f>knots[i+1].f)i++;
    const p=knots[i],q=knots[i+1];return p.s+(f-p.f)*(q.s-p.s)/(q.f-p.f);
  };
  const unmap=s=>{
    if(!knots.length)return (s-a.start)/a.ratio;
    if(knots.length===1)return knots[0].f+(s-knots[0].s)/a.ratio;
    let i=0;while(i<knots.length-2&&s>knots[i+1].s)i++;
    const p=knots[i],q=knots[i+1];return p.f+(s-p.s)*(q.f-p.f)/(q.s-p.s);
  };
  // back from a file position to a tick: quarters are linear in ticks; seconds go through the file's own tempo map
  const toTick=f=>mode==='tempo'||!file.ticksPerQuarter?(file.tick?file.tick(f):f*(file.ticksPerQuarter||960)*2):f*file.ticksPerQuarter;
  return {
    mode,alignment:a,
    position:tick=>map(filePosition(file,mode,tick)),                   // song position (beats, or seconds in tempo mode)
    seconds:tick=>positionSeconds(grid,mode,map(filePosition(file,mode,tick))),
    tick:seconds=>toTick(unmap(songPosition(grid,mode,seconds))),
  };
}

/** The same alignment with its start moved so `tick` lands at `seconds` (dragging the whole part). Anchors move with it. */
export function moveTo(grid,file,alignment,tick,seconds){
  const a=cleanAlignment(alignment),place=placement(grid,file,a),mode=place.mode;
  const shift=songPosition(grid,mode,seconds)-place.position(tick);
  return {...a,start:a.start+shift,anchors:a.anchors.map(x=>({tick:x.tick,time:positionSeconds(grid,mode,songPosition(grid,mode,x.time)+shift)}))};
}
/** Change the ratio (half time, double time...) keeping the moment at `tick` where it is. Anchors are cleared: they were for the old rate. */
export function rescale(grid,file,alignment,ratio,tick=0){
  const a=cleanAlignment(alignment),place=placement(grid,file,a),at=place.position(tick),f=filePosition(file,place.mode,tick);
  return {...a,ratio,start:at-f*ratio,anchors:[]};
}
/** Switch between following the beats and using the file's tempo, keeping the file's first note (or tick) where it is now. */
export function switchMode(grid,file,alignment,mode,tick=0){
  const a=cleanAlignment(alignment),place=placement(grid,file,a),seconds=place.seconds(tick);
  const next={...a,mode,anchors:a.anchors,ratio:mode==='tempo'?1:defaultRatio(file,grid)};
  const f=filePosition(file,mode,tick);next.start=songPosition(grid,mode,seconds)-f*next.ratio;
  return cleanAlignment(next);
}
/** Pin the moment at `tick` to `seconds` (replacing an anchor already at that tick). */
export function addAnchor(alignment,tick,seconds){
  const a=cleanAlignment(alignment);
  return cleanAlignment({...a,anchors:[...a.anchors.filter(x=>x.tick!==tick),{tick,time:seconds}]});
}
export function removeAnchor(alignment,tick){const a=cleanAlignment(alignment);return {...a,anchors:a.anchors.filter(x=>x.tick!==tick)};}

/** Song beats per file quarter note that make one bar of the file one bar of the song (4/4 on 4 beats: 1; 6/8 on 2 beats: 2/3). */
export function defaultRatio(file,grid){
  const sig=file.timeSignatures?.[0]||{numerator:4,denominator:4},quarters=sig.numerator*4/sig.denominator;
  const counts=grid.bars.map((b,i)=>(grid.bars[i+1]??grid.beats.length)-b).filter(n=>n>0);
  if(!counts.length||!(quarters>0))return 1;
  const tally=new Map();for(const n of counts)tally.set(n,(tally.get(n)||0)+1);
  const usual=[...tally].sort((p,q)=>q[1]-p[1])[0][0];
  const r=usual/quarters;return Math.abs(r-1)<0.02?1:r;
}

/**
 * A first placement, before any guessing: a file with its own tempo that fits inside the recording is taken as made over it (a Reaper
 * export starts at the project's start), so it uses its tempo from 0 s; anything else follows the song's beats from bar `firstBar`.
 */
export function defaultAlignment(file,grid,{duration=0,firstBar=0,lastTick=0}={}){
  const length=file.seconds(lastTick);
  if(file.hasTempo&&file.ticksPerQuarter&&duration>0&&length<=duration*1.05+2)return cleanAlignment({mode:'tempo',start:0,ratio:1});
  if(!file.ticksPerQuarter)return cleanAlignment({mode:'tempo',start:0,ratio:1});
  return cleanAlignment({mode:'beats',start:barBeat(grid,firstBar),ratio:defaultRatio(file,grid)});
}

// ---- snapping ---------------------------------------------------------------------------------------------------------------------
export const GRAINS=['bar','beat','eighth','sixteenth'];
/** The finest grid that still leaves `minPx` between lines at this zoom (pixels per beat), like the word-timing grid. */
export function grainFor(pxPerBeat,minPx=14){
  if(pxPerBeat/4>=minPx)return 'sixteenth';if(pxPerBeat/2>=minPx)return 'eighth';if(pxPerBeat>=minPx)return 'beat';return 'bar';
}
/** The nearest grid line to a time, in seconds: 'bar', 'beat', 'eighth', 'sixteenth', or 'free' (no snapping). */
export function snapSeconds(grid,seconds,grain){
  if(grain==='free'||!grid.beats.length)return seconds;
  const b=secondsBeat(grid,seconds);
  if(grain==='bar'){
    const i=beatBar(grid,b),here=grid.bars[i],next=grid.bars[i+1]??(grid.end!=null?grid.beats.length:null);
    const best=next!=null&&b-here>next-b?next:here;return beatSeconds(grid,best);
  }
  const parts={beat:1,eighth:2,sixteenth:4}[grain]||1;
  return beatSeconds(grid,Math.round(b*parts)/parts);
}

// ---- notes on the song ------------------------------------------------------------------------------------------------------------
/** A source's notes placed on the song: [{start,end,pitch,velocity,tick,...}] in song seconds, transposed, sorted, dropping none. */
export function placeNotes(notes,place){
  const t=place.alignment.transpose||0;
  return (notes||[]).map(n=>{const start=place.seconds(n.tick),end=Math.max(start+0.01,place.seconds(n.endTick));
    return {...n,start,end,pitch:Math.max(0,Math.min(127,n.pitch+t))};}).sort((a,b)=>a.start-b.start);
}
/** Points of a control curve ([{tick,value}]) placed on the song: [{time,value}]. */
export const placePoints=(list,place)=>(list||[]).map(p=>({time:place.seconds(p.tick),value:p.value}));

// ---- guessing ---------------------------------------------------------------------------------------------------------------------
// The guess slides the file along the song, at each likely ratio, and scores each place by how well it agrees with what the app already
// knows: pitched notes against the model's melodies (the same pitch, octave aside, starting at the same moment: the strongest clue),
// against the chord chart, and against moments something starts in the recording; drum notes against the drum stem's hits. A busy
// recording has a start almost everywhere, so onsets only count above what chance alone would give. Sparse parts are fine: only the
// notes there are compared. It only proposes: the person always confirms.
const ONSET_WIDTH=0.05;                          // seconds: how close a start must be to count (a Gaussian of this width)
const near=(sorted,t)=>{let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>1;if(sorted[mid]<t)lo=mid+1;else hi=mid;}return lo;};
function nearestGap(sorted,t){
  if(!sorted.length)return Infinity;const i=near(sorted,t);
  return Math.min(i<sorted.length?sorted[i]-t:Infinity,i>0?t-sorted[i-1]:Infinity);
}
function chordIndex(chords,t){
  let lo=0,hi=chords.length-1,found=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(chords[mid].start<=t){found=mid;lo=mid+1;}else hi=mid-1;}
  return found>=0&&t<chords[found].end?found:-1;
}
const gauss=d=>Math.exp(-0.5*(d/ONSET_WIDTH)**2);
// How much of an onset match chance alone gives on this many starts per second (so a dense recording does not make every place look good).
const chanceOf=(list,duration)=>Math.min(0.9,list.length/Math.max(1,duration)*ONSET_WIDTH*2.5);
const aboveChance=(raw,chance)=>Math.max(0,(raw-chance)/(1-chance));
// A model melody note with this pitch class starting near t (1 at the same moment), or half for one already sounding then.
function melodyMatch(m,t,pc){
  let best=0;
  for(let i=Math.max(0,near(m.starts,t-0.15));i<m.starts.length&&m.starts[i]<=t+0.15;i++)if(m.notes[i].pc===pc)best=Math.max(best,gauss(m.starts[i]-t));
  if(best<0.5){for(let i=near(m.starts,t)-1,k=0;i>=0&&k<6;i--,k++){const n=m.notes[i];if(n.end>t&&n.pc===pc){best=Math.max(best,0.5);break;}}}
  return best;
}
// How well notes at these times agree (each 0..1): melody, onset (above chance), harmony (sounding time in the chord), drums, and inside
// (notes inside the song: a place that pushes the part off the end loses).
function agreement(times,notes,refs,duration,transpose=0){
  let inSong=0,pitched=0,drums=0,melody=0,rhythm=0,onset=0,drum=0,harmonyHit=0,harmonyAll=0;
  for(let i=0;i<notes.length;i++){
    const t=times[i],n=notes[i];if(t<-0.05||t>duration+0.05)continue;inSong++;
    if(n.drum){drums++;const list=refs.drumHits.length?refs.drumHits:refs.onsets;if(list.length)drum+=gauss(nearestGap(list,t));continue;}
    pitched++;const pc=((n.pitch+transpose)%12+12)%12;
    if(refs.melody.starts.length){melody+=melodyMatch(refs.melody,t,pc);rhythm+=gauss(nearestGap(refs.melody.starts,t));}
    if(refs.onsets.length)onset+=gauss(nearestGap(refs.onsets,t));
    const c=chordIndex(refs.chords,t);
    if(c>=0&&refs.chords[c].tones){const w=Math.min(2,n.length||0.25);harmonyAll+=w;if(refs.chords[c].tones.has(pc))harmonyHit+=w;}
  }
  const all=notes.length||1;
  return {inside:inSong/all,pitched,drums,melody:pitched?melody/pitched:0,rhythm:pitched?aboveChance(rhythm/pitched,refs.melodyChance):0,onset:pitched?aboveChance(onset/pitched,refs.onsetChance):0,
    drum:drums?aboveChance(drum/drums,refs.drumChance):0,harmony:harmonyAll?harmonyHit/harmonyAll:0,hasHarmony:harmonyAll>0,hasMelody:refs.melody.starts.length>0};
}
// Agreement in time alone, blind to pitch: the same whatever key the file is in, so places can be found before the key is known.
function timing(s){
  const pitched=s.hasMelody?0.6*s.rhythm+0.4*s.onset:s.onset,n=s.pitched+s.drums||1;
  return s.inside*(pitched*s.pitched+s.drum*s.drums)/n;
}
function total(s){
  const parts=[];
  if(s.hasMelody)parts.push([0.45,s.melody]);if(s.hasHarmony)parts.push([0.35,s.harmony]);parts.push([0.2,s.onset]);
  const weight=parts.reduce((a,[w])=>a+w,0),pitched=parts.reduce((a,[w,v])=>a+w*v,0)/weight;
  const n=s.pitched+s.drums||1;
  return s.inside*(pitched*s.pitched+s.drum*s.drums)/n;
}

/**
 * Prepare what the guess compares against. melody: the model's notes [{start,end,pitch}]; onsets: [seconds] where something starts in
 * the recording (the stems' hits); drumHits: the drum stem's hits; chords: [{start,end,label}].
 */
export function guessReferences({melody=[],onsets=[],drumHits=[],chords=[],duration=0}={}){
  const notes=(melody||[]).filter(n=>Number.isFinite(n.start)&&Number.isFinite(n.pitch)).map(n=>({start:n.start,end:Number.isFinite(n.end)?n.end:n.start+0.2,pc:((n.pitch%12)+12)%12}))
    .sort((a,b)=>a.start-b.start);
  const sorted=list=>[...(list||[])].filter(Number.isFinite).sort((a,b)=>a-b);
  const all=sorted([...onsets,...notes.map(n=>n.start)]),drum=sorted(drumHits);
  const span=duration||Math.max(all.at(-1)||0,drum.at(-1)||0,1);
  return {melody:{notes,starts:notes.map(n=>n.start)},melodyChance:chanceOf(notes,span),onsets:all,drumHits:drum,onsetChance:chanceOf(all,span),drumChance:chanceOf(drum,span),
    chords:(chords||[]).filter(c=>Number.isFinite(c.start)&&c.end>c.start).sort((a,b)=>a.start-b.start)
      .map(c=>{const t=chordTones(c.label);return {start:c.start,end:c.end,tones:t?new Set(t.tones):null};})};
}

/**
 * Propose placements: [{alignment, score, melody, onset, harmony, drum, bar, transpose}] best first (up to 4, in different bars), plus
 * `confidence` ('high' | 'medium' | 'low') and `transpose`: the semitones the best place's notes fit much better moved by (a file in
 * another key). notes: [{tick,endTick,pitch,drum?}] of the parts being placed (all of them together is best: more to agree on).
 * First every place is scored by timing alone, which does not care about the key; the best few dozen (and the best by harmony as the
 * file stands) are then scored in full at every transposition, keeping the file's own key unless another clearly fits better.
 */
export function guessAlignment({file,grid,notes,refs,duration}){
  const sample=sampleNotes(notes,600);
  if(!sample.length||!duration)return {candidates:[],confidence:'low',transpose:0};
  const enriched=sample.map(n=>({...n,length:Math.max(0,file.seconds(n.endTick)-file.seconds(n.tick))}));
  const base=file.ticksPerQuarter&&grid.beats.length>1?defaultRatio(file,grid):1;
  // the file's own feel (one of its bars to one of the song's) is the likelier reading: another ratio must clearly agree better
  const prior=a=>a.mode==='beats'&&Math.abs(a.ratio-base)>1e-6?0.9:1;
  const sweep=[];
  const consider=alignment=>{
    const place=placement(grid,file,alignment),times=enriched.map(n=>place.seconds(n.tick)),s=agreement(times,enriched,refs,duration,0);
    sweep.push({alignment:place.alignment,times,quick:timing(s)*prior(place.alignment),plain:total(s)*prior(place.alignment)});
  };
  if(file.ticksPerQuarter&&grid.beats.length>1){
    const totalBeats=grid.beats.length,firstQ=sample[0].tick/file.ticksPerQuarter,lastQ=sample.at(-1).tick/file.ticksPerQuarter;
    for(const r of [...new Set(RATIOS.map(x=>+(x*base).toFixed(6)))]){
      // every start that keeps most of the part inside the song, one beat apart
      const from=Math.floor(-firstQ*r)-1,to=Math.ceil(totalBeats-firstQ*r)+1;
      if(to-from>4000)continue;
      for(let start=from;start<=to;start++)if(start+lastQ*r>0)consider({mode:'beats',start,ratio:r});
    }
  }
  if(file.hasTempo||!file.ticksPerQuarter){
    // its own tempo: the offsets where its note starts agree with the recording's, found by voting (every note against every start near it)
    const votes=new Map(),starts=sample.map(n=>file.seconds(n.tick));
    for(const t of starts)for(const o of refs.onsets){const d=o-t;if(Math.abs(d)>duration)continue;const bin=Math.round(d/0.02);votes.set(bin,(votes.get(bin)||0)+1);}
    const top=[...votes].sort((p,q)=>q[1]-p[1]).slice(0,12).map(([bin])=>bin*0.02);
    for(const offset of [0,...top])consider({mode:'tempo',start:offset,ratio:1});
  }
  if(!sweep.length)return {candidates:[],confidence:'low',transpose:0};
  // the shortlist, scored in full at every key; a transposed reading has to beat the file's own key clearly
  const short=new Set([...[...sweep].sort((p,q)=>q.quick-p.quick).slice(0,30),...[...sweep].sort((p,q)=>q.plain-p.plain).slice(0,15)]);
  const results=[];
  const full=(alignment,times)=>{
    // another key only when it clearly fits the chords better, or matches the melody far better (a bass a fourth off still sits on
    // chord tones, and can brush the melody by chance)
    const own=agreement(times,enriched,refs,duration,0);let best={alignment,score:total(own)*prior(alignment),...own,transpose:0,first:times[0],times};
    for(let k=-6;k<=5;k++){
      if(!k)continue;const s=agreement(times,enriched,refs,duration,k);
      const clearer=s.hasHarmony&&s.harmony>own.harmony+0.12||s.hasMelody&&s.melody>own.melody+0.3&&s.melody>0.5;
      const score=total(s)*prior(alignment)*0.92;if(clearer&&score>best.score)best={alignment,score,...s,transpose:k,first:times[0],times};
    }
    results.push(best);
  };
  for(const c of short)full(c.alignment,c.times);
  results.sort((p,q)=>q.score-p.score);
  // fine-tune the best few: half beats and sixteenths in beats mode, 10 ms in tempo mode
  for(const r of results.slice(0,6)){
    const a=r.alignment,steps=a.mode==='beats'?[-0.5,-0.25,-0.125,0.125,0.25,0.5]:[-0.04,-0.03,-0.02,-0.01,0.01,0.02,0.03,0.04];
    for(const d of steps){const place=placement(grid,file,{...a,start:a.start+d});full(place.alignment,enriched.map(n=>place.seconds(n.tick)));}
  }
  results.sort((p,q)=>q.score-p.score);
  const picked=[];
  for(const r of results){
    const t=r.first,bar=beatBar(grid,secondsBeat(grid,t));r.bar=bar;
    // one entry per place: the same ratio in a nearby spot, or the same notes at the same times however it was described (a file's own
    // tempo that matches the song's beats is one placement, not two)
    const same=p=>p.times.every((x,i)=>Math.abs(x-r.times[i])<0.06);
    if(picked.some(p=>same(p)||(Math.abs(p.first-t)<2*beatLength(grid,t)||p.bar===bar)&&p.alignment.mode===r.alignment.mode&&Math.abs(p.alignment.ratio-r.alignment.ratio)<1e-6))continue;
    picked.push(r);if(picked.length>=4)break;
  }
  const best=picked[0],second=picked[1];
  const lead=second?(best.score-second.score)/Math.max(1e-6,best.score):1;
  const confidence=best.score>0.45&&lead>0.15?'high':best.score>0.25&&lead>0.06?'medium':'low';
  return {candidates:picked.map(r=>({alignment:r.alignment,score:r.score,melody:r.melody,onset:r.onset,harmony:r.harmony,drum:r.drum,inside:r.inside,transpose:r.transpose,
    bar:r.alignment.mode==='beats'?beatBar(grid,Math.max(0,r.alignment.start)):beatBar(grid,Math.max(0,secondsBeat(grid,r.alignment.start)))})),confidence,transpose:best.transpose};
}
const beatLength=(grid,t)=>{const b=secondsBeat(grid,t);return Math.max(0.15,beatSeconds(grid,b+1)-beatSeconds(grid,b));};
// At most `limit` notes, spread evenly through the part, so a dense file guesses as fast as a sparse one.
function sampleNotes(notes,limit){
  const sorted=[...(notes||[])].filter(n=>Number.isFinite(n.tick)).sort((a,b)=>a.tick-b.tick);
  if(sorted.length<=limit)return sorted;
  const out=[];for(let i=0;i<limit;i++)out.push(sorted[Math.floor(i*sorted.length/limit)]);return out;
}
