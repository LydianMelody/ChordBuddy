// How long things take. The editor, the set list footer and the live clocks all call these, so they can never disagree.
// Works from the path (performance-compiler.js), never the MP3's length: a repeat is its own segment, and a speed change changes the seconds.
// Music left, planned time left, slot time left and spare/over are kept separate on purpose. A pause stops the first two and not the slot.
// An until-released loop is an estimate: four plays are in the path until more actually start. Exiting removes the unused ones. Pure.
export const RATE=44100;

/** Output seconds of a music segment from `fromFrame` on, at `rate` percent, following any speed actions in it. Returns {seconds, rate}. */
export function musicSeconds(segment,{fromFrame=null,rate=100,fixedRate=false}={}){
  let at=fromFrame??segment.start,now=rate,seconds=0;
  if(!fixedRate)for(const a of segment.actions||[]){
    if(a.action?.type!=='rate.set')continue;
    if(a.frame<=at){if(fromFrame===null)now=a.action.percent;continue;}
    if(a.frame>=segment.end)break;
    seconds+=(a.frame-at)/RATE/(now/100);at=a.frame;now=a.action.percent;
  }
  seconds+=(segment.end-at)/RATE/(now/100);
  return {seconds,rate:now};
}
/** Seconds through a list of segments. Music and holds apart, because "music left" leaves out holds.
 *  position: {index, frame} where playback is; rate: the speed now, percent; holdLeft: seconds left of a hold in progress; fixedRate: a live speed
 *  override is in force, so planned speed changes won't happen. waiting: the hold at position has no time limit left (past its estimate). */
export function pathSeconds(segments,{index=0,frame=null,rate=100,holdLeft=null,fixedRate=false}={}){
  let music=0,holds=0,now=rate,unknown=false,estimated=false;
  for(let i=index;i<segments.length;i++){
    const s=segments[i];
    if(s.kind==='hold'){
      const here=i===index&&holdLeft!==null;
      if(s.seconds!==null)holds+=here?holdLeft:s.seconds;
      else if(Number.isFinite(s.expected)){holds+=here?Math.max(0,holdLeft):s.expected;estimated=true;}
      else unknown=true;
      continue;
    }
    if(s.live)estimated=true;
    const r=musicSeconds(s,{fromFrame:i===index?frame:null,rate:now,fixedRate});
    music+=r.seconds;now=r.rate;
  }
  return {music,holds,planned:music+holds,unknown,estimated,endRate:now};
}
/** A count-in into `from` (song seconds), the place the music starts. Before bar 1 it counts into bar 1, and anything before bar 1 (a pickup) plays under the end
 *  of the count; from anywhere else it counts into `from` itself. Either way the clicks are whole bars on the beat grid of the bar it counts into, so the
 *  first click of every bar is accented and says where the downbeat lands, even when `from` is partway through a bar. A pickup bar's own beats set none of
 *  it, since they can be any length (Call Me's are 1.6x too fast); the tempo is a whole bar's length over its beats, since single detected beats wobble.
 *  count: a number of bars, or a set list entry's transition ({countBars}, or {countBeats} from before count-ins were in bars, rounded up to whole bars).
 *  Returns the clicks as song times (they can be before 0, before there is any audio), and lead: the silence the music needs before it starts so the whole
 *  count fits, which is how a count-in can start before the recording does. */
export function countInOf(measures,count,ratePercent=100,from=0){
  const list=measures||[],bar1=list.find(m=>m.number>=1)??list[0],want=typeof count==='number'?{countBars:count}:(count||{});
  const none=meter=>({beat:0,beats:0,meter,bars:0,clicks:[],target:from,firstBar:0,seconds:0,lead:0});
  if(!bar1)return none(4);
  const before=from<bar1.start-1e-6,here=before?bar1:(list.find(m=>m.number>=1&&m.start<=from+1e-6&&from<m.end-1e-6)??list.at(-1));
  const meter=Math.max(1,(here.beats||[]).length);
  const bars=want.countBars>0?Math.round(want.countBars):want.countBeats>0?Math.ceil(want.countBeats/Math.max(1,(bar1.beats||[]).length)):0;
  if(!bars)return none(meter);
  const speed=(ratePercent||100)/100,step=(here.end-here.start)/meter,target=before?bar1.start:from,earliest=target-bars*meter*step;
  const clicks=[];
  for(let i=Math.ceil((earliest-here.start)/step-1e-6);here.start+i*step<target-1e-6;i++)clicks.push({at:here.start+i*step,accent:((i%meter)+meter)%meter===0});
  const first=clicks[0]?.at??target;
  return {beat:step/speed,beats:clicks.length,meter,bars,clicks,target,firstBar:target/speed,seconds:(target-first)/speed,lead:Math.max(0,(from-first)/speed)};
}
/** What a show still has to play. entries: [{segments, position?, transition:{seconds, countIn}}], first one the current song; the gap before an
 *  entry is counted once, on that entry. position on the first entry: as in pathSeconds. gapLeft: what remains of a gap already running. */
export function showSeconds(entries,{gapLeft=null}={}){
  let music=0,gaps=0,holds=0,unknown=false,estimated=false;
  entries.forEach((entry,i)=>{
    const r=pathSeconds(entry.segments,i===0?(entry.position||{}):{});
    music+=r.music;holds+=r.holds;unknown=unknown||r.unknown;estimated=estimated||r.estimated;
    const t=entry.transition||{};
    if(Number.isFinite(entry.lead))gaps+=entry.lead;
    if(i===0)gaps+=gapLeft??0;
    else{
      gaps+=(Number.isFinite(t.seconds)?t.seconds:0)+(Number.isFinite(t.countIn)?t.countIn:0);
      if(t.kind==='control'){if(Number.isFinite(t.expected)){gaps+=t.expected;estimated=true;}else unknown=true;}
    }
  });
  return {music,gaps,holds,planned:music+gaps+holds,unknown,estimated};
}
/** The clocks a performer sees. now, deadline: real time in seconds on one clock; deadline null when no target is set. */
export function timing(totals,{now,deadline=null}){
  const slotLeft=deadline===null?null:deadline-now;
  return {music:totals.music,planned:totals.planned,slotLeft,spare:slotLeft===null||totals.unknown?null:slotLeft-totals.planned,expectedFinish:totals.unknown?null:now+totals.planned,estimated:totals.estimated,unknown:totals.unknown};
}
/** m:ss, or h:mm:ss. Rounded once, here, so errors never add up entry by entry. */
export function clockText(seconds){
  if(!Number.isFinite(seconds))return '—';
  const whole=Math.round(Math.abs(seconds)),h=Math.floor(whole/3600),m=Math.floor(whole/60)%60,s=whole%60;
  return `${seconds<0?'−':''}${h?`${h}:${String(m).padStart(2,'0')}`:m}:${String(s).padStart(2,'0')}`;
}
/** "2m 14s to spare" / "38s over". */
export function spareText(spare){
  if(spare===null||!Number.isFinite(spare))return '';
  const whole=Math.round(Math.abs(spare)),h=Math.floor(whole/3600),m=Math.floor(whole/60)%60,s=whole%60,text=h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`;
  return spare<0?`${text} over`:`${text} to spare`;
}
