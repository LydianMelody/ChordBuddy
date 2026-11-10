// MIDI for a performance, on the page's side: timed actions to the server's scheduler (midi_service.py), and mapped input back to commands.
// Times: the server's clock never jumps, and this works out the difference to the page's clock from the shortest round trip.
// A commit is a commit: what has reached a device can't be taken back, so only what hasn't gone out is withdrawn, and a changed decision uses a later moment.
import {ACTIONS,actionDef,writesOf,applyToState} from './performance-actions.js';

/** The difference from the page clock to the server clock, seconds. samples: [{sent, received, server}], page times in seconds. */
export function clockOffset(samples){
  if(!samples.length)return null;
  const best=samples.reduce((a,b)=>b.received-b.sent<a.received-a.sent?b:a);
  return {offset:best.server-(best.sent+best.received)/2,uncertainty:(best.received-best.sent)/2};
}

/** Wire bytes for an action. A note also gets its note-off at the end of its length. */
export function messagesFor(action,at){
  const def=actionDef(action);
  if(!def?.bytes)return [];
  const out=def.bytes(action).map((bytes,i)=>({at:at+i*(action.spacing??.005),bytes}));
  if(action.type==='midi.note')out.push({at:at+action.length,bytes:[0x80+action.channel-1,action.note,0]});
  return out;
}

/** The output frames of MIDI clock pulses (24 to the quarter note) in a stretch of a segment, from the song's real bars and beats. */
export function clockPulses(measures,fromFrame,toFrame,rate=44100){
  const out=[];
  for(const m of measures){
    const beats=[...m.beats,m.end],q=m.quarter_positions;
    for(let i=0;i<beats.length-1;i++){
      const a=beats[i]*rate,b=beats[i+1]*rate;
      if(b<=fromFrame)continue;
      if(a>=toFrame)return out;
      const quarters=q&&q.length===beats.length&&Number.isFinite(q[i])&&Number.isFinite(q[i+1])?q[i+1]-q[i]:1,pulses=Math.max(1,Math.round(quarters*24));
      for(let p=0;p<pulses;p++){const f=a+(b-a)*p/pulses;if(f>=fromFrame&&f<toFrame)out.push(Math.round(f));}
    }
  }
  return out;
}

/** A note's release arrives with its own status byte, but it is the same control as the press. */
const pressStatus=status=>(status&0xF0)===0x80?0x90|(status&15):status;
const SAME_TAP=.12;
// CC values and note velocities can be split into ranges, so one control can do several things. Other messages (a program change) have no value to split.
const usesValue=status=>(status&0xF0)===0xB0||(status&0xF0)===0x90;
/** The values a mapping answers to: all of them unless it says otherwise. */
export const valueRange=mapping=>mapping.range||[0,127];
export const sameControl=(a,b)=>a.device===b.device&&a.status===b.status&&a.data1===b.data1;
export const inRange=(mapping,value)=>!usesValue(mapping.status)||(value>=valueRange(mapping)[0]&&value<=valueRange(mapping)[1]);
/** The mapping on the same control whose range overlaps this one, if any. */
export function rangeClash(mappings,mapping,range){
  return mappings.find(m=>m!==mapping&&sameControl(m,mapping)&&valueRange(m)[0]<=range[1]&&range[0]<=valueRange(m)[1])||null;
}
/** The values a switch was heard pressing with: its "on" if momentary (its "off" only lets go), both if latching. */
const pressValues=m=>m.values?.length?m.values:Number.isFinite(m.value)?[m.value]:null;
/** Zero is what a momentary switch sends when let go. A range starting there, for a switch that never presses with zero, would take that for a press. */
const clearOfZero=(range,values)=>range[0]===0&&values&&!values.includes(0)?[1,range[1]]:range;
/** A newly learned mapping among the others, going by the values its switch sends.
 *  Sent a value already assigned: it takes that one's place and range. Sent a different one inside an assigned range: the two share that range, split between their values.
 *  Sent a value nothing covers: it gets all the free values around it. Alone on its control, it gets 0 to 127. */
export function placeLearned(mappings,mapping){
  const same=mappings.filter(m=>sameControl(m,mapping)),mine=pressValues(mapping);
  const swapIn=old=>({list:[...mappings.filter(m=>m!==old),{...mapping,range:[...valueRange(old)]}],replaced:old,split:null});
  if(!usesValue(mapping.status)||!mine){const replaced=same[0]||null;return {list:[...mappings.filter(m=>!same.includes(m)),mapping],replaced,split:null};}
  if(!same.length)return {list:[...mappings,{...mapping,range:[0,127]}],replaced:null,split:null};
  const hit=same.find(m=>mine.some(v=>inRange(m,v)));
  if(hit){
    const theirs=pressValues(hit),[lo,hi]=valueRange(hit);
    // no values to compare, one in common, or a latching switch's two values on either side of this one: they can't share
    if(!theirs||Math.max(...mine)>=Math.min(...theirs)&&Math.min(...mine)<=Math.max(...theirs))return swapIn(hit);
    const below=Math.max(...mine)<Math.min(...theirs),low=below?mine:theirs,high=below?theirs:mine;
    const edge=Math.floor((Math.max(...low)+Math.min(...high))/2);
    const lower=clearOfZero([lo,edge],low),upper=[edge+1,hi];
    const moved={...hit,range:below?upper:lower};
    return {list:[...mappings.map(m=>m===hit?moved:m),{...mapping,range:below?lower:upper}],replaced:null,split:moved};
  }
  const value=mine[0];
  const bottom=Math.max(-1,...same.map(m=>valueRange(m)[1]).filter(top=>top<value))+1,top=Math.min(128,...same.map(m=>valueRange(m)[0]).filter(start=>start>value))-1;
  return {list:[...mappings,{...mapping,range:clearOfZero([bottom,top],mine)}],replaced:null,split:null};
}
/** What a message means. A mapping: {device, status, data1, range?, edge?, on?, command}. Of the mappings on a control, the one whose range holds the value answers.
 *  edge 'press' (the default) is a momentary switch, which sends on and off: only going to its "on" value counts (on, or else anything above zero).
 *  edge 'every' is a latching switch or one that sends a single value: each message is a press, except one that follows within SAME_TAP, so a glitch can't skip two songs.
 *  Ignored events are said to be ignored. */
export function matchInput(mappings,event,held=new Map()){
  const [rawStatus,data1=0,data2=0]=event.bytes,status=pressStatus(rawStatus),key=`${event.device}|${status}|${data1}`;
  const candidates=mappings.filter(m=>m.device===event.device&&m.status===status&&(m.data1===undefined||m.data1===data1));
  if(!candidates.length)return {command:null,reason:'not mapped'};
  if(rawStatus!==status){held.set(key,false);return {command:null,reason:'release'};}
  const m=candidates.find(x=>inRange(x,data2));
  // a momentary switch's "off" usually falls outside a narrowed range: it still means the switch was let go
  if(!m){held.set(key,false);return {command:null,reason:'outside its range'};}
  if(m.edge==='every'){
    const timeKey=`${key}|${valueRange(m)[0]}`,was=held.get(timeKey);held.set(timeKey,event.t);
    if(Number.isFinite(event.t)&&Number.isFinite(was)&&event.t-was<SAME_TAP)return {command:null,reason:'same tap'};
    return {command:m.command,mapping:m};
  }
  const down=Number.isFinite(m.on)?data2===m.on:data2>0,was=held.get(key)===true;held.set(key,down);
  if(!down)return {command:null,reason:'release'};
  if(was)return {command:null,reason:'already down'};
  return {command:m.command,mapping:m};
}

/** Learn a mapping from a control's first message. A controller's "on" is kept, so a momentary switch whose "off" isn't zero still works. */
export function learnFrom(event,command,edge='press'){
  const [rawStatus,data1]=event.bytes,status=pressStatus(rawStatus),mapping={device:event.device,status,data1,command,edge};
  if((status&0xF0)===0xB0||(status&0xF0)===0x90)mapping.value=event.bytes[2];
  if((status&0xF0)===0xB0&&edge==='press')mapping.on=event.bytes[2];
  return mapping;
}

/** What two taps of one control say about it. values: what it sent, in order, a note's release as 0. Returns the edge, 'unsure' if on-then-off could still be a momentary switch's first tap, or null if it needs more.
 *  Momentary sends on, off, on, off. Latching sends on, off. A single-value switch sends on, on. */
export function readTaps(values){
  if(values.length<2)return null;
  if(values[0]===values[1])return 'every';
  return values.length>=3?'press':'unsure';
}

/** A latching switch presses with every value it was heard sending; a momentary one only with its "on". Only values that can be split are kept. */
const withValues=(mapping,values)=>{if(!usesValue(mapping.status))return mapping;mapping.values=mapping.edge==='every'?[...new Set(values)].sort((a,b)=>a-b):[mapping.value];return mapping;};
/** Listens for two taps of the same control and returns its mapping, so one stray message (a preset's chatter) can't be learned by mistake.
 *  Returns {mapping} or {heard: how many messages arrived}. onHeard: told when the first message arrives. stop(): true gives up. */
export async function learnControl(api,command,{onHeard=()=>{},stop=()=>false,wait=20000,settle=2500,clock=()=>Date.now()}={}){
  let {last:after}=await api('/api/midi/events?after=999999999');
  const controls=new Map(),deadline=clock()+wait;let heard=0,unsure=null,unsureSince=0;
  while(clock()<deadline&&!stop()){
    const r=await api(`/api/midi/events?after=${after}&wait=0.25`);after=r.last;
    for(const event of r.events){
      const [rawStatus,data1=0,data2]=event.bytes,key=`${event.device}|${pressStatus(rawStatus)}|${data1}`;
      if(!controls.has(key))controls.set(key,{first:event,values:[]});
      const control=controls.get(key);control.values.push(rawStatus===pressStatus(rawStatus)?data2:0);
      if(!heard)onHeard();heard++;
      const edge=readTaps(control.values);
      if(edge==='press'||edge==='every')return {mapping:withValues(learnFrom(control.first,command,edge),control.values)};
      if(edge==='unsure'){unsure=control;unsureSince=clock();}
    }
    if(unsure&&clock()-unsureSince>=settle)return {mapping:withValues(learnFrom(unsure.first,command,'every'),unsure.values)};
  }
  return {heard};
}

const CLOCK_AHEAD=44100/2;
/** What to send a device so it matches the plan, given what it was last sent: only what differs. A new preset goes as setlist, preset and
 *  snapshot (the Helix loads a preset on its own saved snapshot); a new snapshot alone; nothing when it's already there, since sending a
 *  Helix its own preset again reloads it, and you'd hear the gap. */
export function catchUpActions(device,state,known){
  const out=[];
  for(const [property,value] of Object.entries(state||{})){
    if(!property.startsWith(`midi.${device}.`)||value===undefined)continue;
    const was=known[property];
    if(property.endsWith('.tone')){
      const t=value,channel=t.channel??1,newPreset=t.preset!==undefined&&(t.preset!==was?.preset||t.setlist!==was?.setlist);
      if(newPreset)out.push({type:'midi.helix',device,channel,setlist:t.setlist,preset:t.preset,snapshot:t.snapshot});
      else if(t.setlist!==undefined&&t.setlist!==was?.setlist)out.push({type:'midi.helix',device,channel,setlist:t.setlist});
      else if(t.snapshot!==undefined&&t.snapshot!==was?.snapshot)out.push({type:'midi.helix',device,channel,snapshot:t.snapshot});
      continue;
    }
    if(JSON.stringify(value)===JSON.stringify(was))continue;
    const cc=/\.(\d+)\.cc\.(\d+)$/.exec(property),pc=/\.(\d+)\.pc$/.exec(property);
    if(cc)out.push({type:'midi.cc',device,channel:+cc[1],controller:+cc[2],value});
    else if(pc)out.push({type:'midi.pc',device,channel:+pc[1],program:value});
  }
  return out;
}
const devicesIn=state=>[...new Set(Object.keys(state||{}).map(p=>/^midi\.(.+?)\.(?:tone|\d+\.cc\.\d+|\d+\.pc)$/.exec(p)?.[1]).filter(Boolean))];
/** known: what each device was last sent ({property: value}), shared by the previews of one sitting, so a jump doesn't resend what's there. */
export function createMidiBridge({api,now=()=>performance.now()/1000,timeOfPlayed,allow=()=>true,onLog=()=>{},known={}}){
  let offset=null,generation=1,clockState={},caughtUpAt=null;
  const toServer=pageSeconds=>pageSeconds+(offset?.offset??0);
  const bridge={
    /** Measure the clock difference. Returns the uncertainty in seconds. */
    async calibrate(rounds=7){
      const samples=[];
      for(let i=0;i<rounds;i++){const sent=now(),{clock}=await api('/api/midi/status'),received=now();samples.push({sent,received,server:clock});}
      offset=clockOffset(samples);
      return offset;
    },
    event(e){
      // Where the music starts, and after a jump or a loop: each device is put where the plan has it there, flags behind the playhead included
      if(e.type==='state'&&e.state){
        const at=toServer(timeOfPlayed(e.atPlayed));
        for(const device of devicesIn(e.state)){
          const actions=catchUpActions(device,e.state,known).filter(a=>allow(a));
          for(const a of actions){const next=applyToState(known,a);for(const [p] of writesOf(a))known[p]=next[p];}
          const events=actions.flatMap(a=>messagesFor(a,at));
          if(events.length){onLog({caughtUp:device,actions:actions.length});api('/api/midi/schedule',{device,generation,events}).catch(error=>onLog({error:error.message}));}
        }
        caughtUpAt=e.atPlayed;return;
      }
      if(e.type==='midi'||(e.type==='oneshot'&&e.action?.type?.startsWith('midi.'))){
        if(!allow(e.action)){onLog({skipped:e.action});return;}
        // a flag right where the music starts, that the catch-up has just sent: once is enough (twice would reload the preset)
        const after=applyToState(known,e.action),same=writesOf(e.action).every(([p])=>JSON.stringify(after[p])===JSON.stringify(known[p]));
        if(same&&caughtUpAt!==null&&Math.abs(e.atPlayed-caughtUpAt)<44100*.3){onLog({skipped:e.action,already:true});return;}
        for(const [p] of writesOf(e.action))known[p]=after[p];
        const at=toServer(timeOfPlayed(e.atPlayed)-(e.leadMs||0)/1000);
        api('/api/midi/schedule',{device:e.action.device,generation,events:messagesFor(e.action,at)}).catch(error=>onLog({error:error.message}));
      }else if(e.type==='withdrawn'){
        api('/api/midi/cancel',{from:toServer(timeOfPlayed(e.atPlayed))}).catch(()=>{});
      }else if(e.type==='cleanup'){
        generation++;api('/api/midi/cleanup',{}).catch(()=>{});
      }
    },
    /** Keep MIDI clock going for the next stretch: a little ahead, from the song's real beats. Called on each report while a show plays. */
    clock(runner,device){
      const c=runner.current;if(!c||!device)return;
      if(clockState.segment!==c.key){
        clockState={segment:c.key,next:Math.max(c.start,runner.source)};
        if(!clockState.started){clockState.started=true;api('/api/midi/schedule',{device,generation,events:[{at:toServer(timeOfPlayed(runner.played)),bytes:[0xFA]}]}).catch(()=>{});}
      }
      const until=Math.min(c.end,runner.source+CLOCK_AHEAD);
      if(until<=clockState.next)return;
      const frames=clockPulses(runner.measures,clockState.next,until);clockState.next=until;
      if(!frames.length)return;
      api('/api/midi/schedule',{device,generation,events:frames.map(f=>({at:toServer(timeOfPlayed(c.startPlayed+(f-c.start))),bytes:[0xF8]}))}).catch(error=>onLog({error:error.message}));
    },
    stopClock(device){if(device&&clockState.started){clockState={};api('/api/midi/schedule',{device,generation,events:[{at:toServer(now()),bytes:[0xFC]}]}).catch(()=>{});}},
    /** A device came back: send where things stand now, and nothing it missed. state: the plan's current values. */
    chase(state,device){
      const events=[],at=toServer(now()+.02);
      for(const [property,value] of Object.entries(state)){
        if(!property.startsWith(`midi.${device}.`))continue;
        if(property.endsWith('.tone')){events.push(...messagesFor({type:'midi.helix',device,channel:value.channel??1,...value},at));continue;}
        const cc=/\.(\d+)\.cc\.(\d+)$/.exec(property),pc=/\.(\d+)\.pc$/.exec(property);
        if(cc)events.push(...messagesFor({type:'midi.cc',device,channel:+cc[1],controller:+cc[2],value},at));
        else if(pc)events.push(...messagesFor({type:'midi.pc',device,channel:+pc[1],program:value},at));
      }
      return events.length?api('/api/midi/schedule',{device,generation,events}):Promise.resolve({queued:0});
    },
  };
  return bridge;
}

// Virtual tap tempo: taps a tempo into a Helix with CC 64 (its manual, p.78), and sends nothing until the tempo changes, so you can still tap your own. Tested on a Helix Floor, this landed
// on the exact tempo and stayed steady, where a running MIDI clock made its delays warp every few seconds. CC 64 is the sustain pedal on most other gear, so it's offered for Line 6 HX gear only.
const TAP_MESSAGE=[0xB0,64,127],TAPS=4,LOWEST_TAP=40,SETTLE=.4,SAME_TEMPO=.4;
export const canTapTempo=name=>/\b(helix|hx)\b/i.test(String(name));
/** A tempo at a speed, to the Helix's 0.1 BPM. Nothing if there's no tempo, or it's slower than the Helix accepts a tap. */
export function tapBpm(songBpm,ratePercent=100){
  if(!Number.isFinite(songBpm)||songBpm<=0)return null;
  const bpm=Math.round(songBpm*ratePercent/10)/10;
  return bpm>=LOWEST_TAP?bpm:null;
}
/** The messages for one set of taps, starting at `at` seconds on the server's clock. */
export const tapEvents=(bpm,at,beat=60/bpm)=>Array.from({length:TAPS},(_,i)=>({at:at+i*beat,bytes:[...TAP_MESSAGE]}));

const median=list=>{const s=[...list].sort((a,b)=>a-b);return s.length?s[s.length>>1]:null;};
const MAP_SMOOTH=5,MAP_HOLD=4,MAP_CHANGE=3,MAP_SHORTEST=8;
/** A song's tempo map: [{start seconds, bpm}], whole numbers on the app's own scale. Detected beats wobble from bar to bar, and every wobble sent to a Helix would be heard, so a new
 *  tempo must differ by MAP_CHANGE BPM or more for MAP_HOLD bars in a row. A song with a set steady tempo, or one that never moves that far, is one entry: the tempo the app shows. */
export function tempoMap(measures,songBpm,{constant=false}={}){
  const shown=Number.isFinite(songBpm)&&songBpm>0?Math.round(songBpm):null;
  // a whole bar's length, not its beat spacing: single beats are rounded to a time grid, so one can read 167 or 176 when the song is at 170
  const bars=(measures||[]).map(m=>{const count=m.beats?.length||0,length=m.end-m.start;return {start:m.start,bpm:count&&length>0?count*60/length:null};}).filter(b=>b.bpm);
  if(!bars.length)return shown?[{start:0,bpm:shown}]:[];
  if(constant)return [{start:0,bpm:shown??Math.round(median(bars.map(b=>b.bpm)))}];
  // the beat may be counted differently from the tempo shown (eighths in 6/8): keep to the app's scale
  const wanted=shown?shown/median(bars.map(b=>b.bpm)):1,scale=[1/3,1/2,2/3,1,3/2,2,3].reduce((best,r)=>Math.abs(Math.log(r/wanted))<Math.abs(Math.log(best/wanted))?r:best,1);
  const smooth=bars.map((b,i)=>({start:b.start,bpm:median(bars.slice(Math.max(0,i-(MAP_SMOOTH>>1)),i+(MAP_SMOOTH>>1)+1).map(x=>x.bpm))*scale}));
  // where the tempo moves and stays moved
  const cuts=[0];let held=smooth[0].bpm;
  const settled=i=>median(smooth.slice(i,i+MAP_HOLD).map(x=>x.bpm));
  held=settled(0);
  for(let i=1;i+MAP_HOLD<=smooth.length;i++){
    const run=smooth.slice(i,i+MAP_HOLD).map(x=>x.bpm-held);
    if(run.every(d=>d>=MAP_CHANGE)||run.every(d=>d<=-MAP_CHANGE)){cuts.push(i);held=settled(i);i+=MAP_HOLD-1;}
  }
  // each stretch's tempo comes from all of it; a short one is a few odd bars, not a tempo, and stretches that end up alike are one
  let parts=cuts.map((from,i)=>({from,to:cuts[i+1]??smooth.length}));
  const short=parts.findIndex(p=>p.to-p.from<MAP_SHORTEST);
  for(let i=short;i>=0&&parts.length>1;){
    if(i+1<parts.length)parts[i+1].from=parts[i].from;else parts[i-1].to=parts[i].to;
    parts.splice(i,1);i=parts.findIndex(p=>p.to-p.from<MAP_SHORTEST);
  }
  const tempoOf=p=>median(smooth.slice(p.from,p.to).map(x=>x.bpm));
  const merged=[];
  for(const part of parts){const last=merged.at(-1);if(last&&Math.abs(tempoOf(last)-tempoOf(part))<MAP_CHANGE)last.to=part.to;else merged.push({...part});}
  // what the app shows wins when it's the same tempo, so the number you see is the number that's sent
  const map=merged.map((p,i)=>{const t=tempoOf(p);return {start:i===0?0:smooth[p.from].start,bpm:shown&&Math.abs(t-shown)<MAP_CHANGE?shown:Math.round(t)};});
  return map;
}

/** The song's tempo at a place, in BPM on the app's scale, from its tempo map (the same tempo a Helix is tapped): null when it isn't known.
 *  song: {measures, bpm, constant}, as songTempo() gives it. The map is worked out once per song. */
let tempoCache={measures:null,bpm:null,constant:null,map:[]};
export function tempoAt(song,seconds){
  if(!song?.measures?.length&&!song?.bpm)return null;
  const c=tempoCache;
  if(c.measures!==song.measures||c.bpm!==song.bpm||c.constant!==!!song.constant)tempoCache={measures:song.measures,bpm:song.bpm,constant:!!song.constant,map:tempoMap(song.measures,song.bpm,{constant:!!song.constant})};
  const map=tempoCache.map;if(!map.length)return null;
  let at=map[0];for(const entry of map)if(entry.start<=seconds)at=entry;else break;
  return at.bpm;
}
export const SPEED_LOW=50,SPEED_HIGH=125;
/** The speed that plays `bpm` where the song's own tempo is `base`, to a tenth of a percent: {percent}, or {error} in words when the speed control can't reach it. */
export function speedForTempo(bpm,base){
  if(!Number.isFinite(base)||base<=0)return {error:'This song’s tempo isn’t known yet, so a tempo can’t be set. Analyze it first, or use the speed.'};
  if(!Number.isFinite(bpm)||bpm<=0)return {error:'Type a tempo in beats per minute.'};
  const percent=Math.round(bpm/base*1000)/10;
  if(percent<SPEED_LOW||percent>SPEED_HIGH){const lo=Math.ceil(base*SPEED_LOW/100),hi=Math.floor(base*SPEED_HIGH/100);return {error:`The song is at ${Math.round(base)} BPM here, so the speed can play it from ${lo} to ${hi} BPM.`};}
  return {percent};
}

/** device(): the device set to follow the tempo map in MIDI setup, or nothing. song(): {id, bpm, measures, constant} of what's open, with no bpm until it's known.
 *  Following sends only changes: nothing on a resume or a seek within one tempo. A set of taps ends on the bar where a new tempo starts. When it's turned on and when a song first plays it
 *  reads the tempo the device's own clock reports, and taps only if that's different. A Helix with Send MIDI Clock off reports nothing, so then it goes by the last tempo sent.
 *  Within a song it never reads and corrects, or it would undo a tempo you tapped yourself.
 *  sync(name, snapshot) is that check, now: {bpm, tapped}, or null with no song to go by.
 *  follow(name) sends the map's tempo now, whatever was last sent, and follows from there. setBpm(name, bpm) taps that tempo and stops following until the next song. */
export function createTempoTap({api,device,song,allowed=()=>true,now=()=>Date.now(),onError=()=>{}}){
  let lastSent=null,mapFor=null,map=[],asked=null,paused=false,songNow=null,rateNow=null,settle=0,checkDue=true;
  const mapOf=open=>{if(mapFor!==open.id||!map.length){map=tempoMap(open.measures,open.bpm,{constant:open.constant});mapFor=open.id;}return map;};
  async function send(name,bpm,delay=0,beat=60/bpm){
    try{
      const {clock}=await api('/api/midi/status');
      await api('/api/midi/schedule',{device:name,generation:0,events:tapEvents(bpm,clock+.02+delay,beat)});
      return bpm;
    }catch(error){onError(error);return null;}
  }
  /** Taps a goal unless the device is already there. */
  async function check(name,goal){
    const before=lastSent;lastSent=goal.bpm;
    let heard=null;try{heard=(await api('/api/midi/status')).clock_in?.[name]??null;}catch(error){onError(error);}
    const reads=Number.isFinite(heard?.bpm)&&heard.seconds_ago<1;
    if(reads?Math.abs(heard.bpm-goal.bpm)<SAME_TEMPO:before===goal.bpm)return {bpm:goal.bpm,tapped:false};
    await send(name,goal.bpm,goal.delay??0);
    return {bpm:goal.bpm,tapped:true};
  }
  /** What should be set when `seconds` of this song is playing at this speed, and how soon to start tapping it. */
  function target(open,seconds,rate){
    const list=mapOf(open);if(!list.length)return null;
    let index=0;for(let i=0;i<list.length;i++)if(list[i].start<=seconds)index=i;
    const next=list[index+1],speed=rate/100;
    if(next){
      const bpm=tapBpm(next.bpm,rate),lead=bpm?3*60/bpm:0,away=(next.start-seconds)/speed;
      if(bpm&&away<=lead+.15)return {bpm,delay:Math.max(0,away-lead)};
    }
    return {bpm:tapBpm(list[index].bpm,rate),delay:0};
  }
  return {
    async follow(name=device(),snapshot={}){
      const open=song();if(!name||!open?.bpm)return null;
      asked=device()?null:name;paused=false;
      const goal=target(open,snapshot.seconds??0,snapshot.rate??100);if(!goal?.bpm)return null;
      lastSent=goal.bpm;return send(name,goal.bpm);
    },
    async sync(name=device(),snapshot={}){
      const open=song();if(!name||!open?.bpm)return null;
      paused=false;checkDue=false;songNow=open.id;
      const goal=target(open,snapshot.seconds??0,snapshot.rate??100);if(!goal?.bpm)return null;
      return check(name,goal);
    },
    async setBpm(name,bpm){
      if(!name)return null;
      asked=null;paused=true;lastSent=bpm;
      return send(name,bpm);
    },
    tick(snapshot){
      const name=device()||asked;
      if(!name||!allowed())return;
      const open=song();if(!open?.id||!open.bpm)return;
      if(songNow!==open.id){songNow=open.id;paused=false;checkDue=true;}
      const rate=snapshot.rate??100;
      // the speed buttons go a step at a time: wait until it has stopped moving
      if(rateNow!==rate){if(rateNow!==null)settle=now()+SETTLE*1000;rateNow=rate;}
      if(paused||!snapshot.playing||now()<settle)return;
      const goal=target(open,snapshot.seconds??0,rate);
      if(!goal?.bpm)return;
      if(checkDue){checkDue=false;check(name,goal);return;}
      if(goal.bpm===lastSent)return;
      lastSent=goal.bpm;send(name,goal.bpm,goal.delay,60/goal.bpm);
    },
  };
}

/** Notices a device going away and coming back. check() once every few seconds. Coming back: it is opened again, and told only where things stand now. */
export function createDeviceWatch({api,devices,onLost,onBack}){
  const gone=new Set();
  return {
    async check(){
      let ports;try{ports=await api('/api/midi/ports');}catch{return;}
      if(!ports?.available)return;
      const present=new Set(ports.outputs.map(p=>p.name));
      for(const {name,critical} of devices()){
        if(!present.has(name)){
          if(!gone.has(name)){gone.add(name);await api('/api/midi/disconnect',{name}).catch(()=>{});onLost(name,!!critical);}
        }else if(gone.has(name)){
          const r=await api('/api/midi/connect',{name}).catch(()=>null);
          if(r?.output){gone.delete(name);onBack(name);}
        }
      }
    },
    gone:()=>[...gone],
  };
}

/** Reads mapped input for as long as it runs. Only explicit mappings do anything, so a pedal's own preset chatter is ignored. */
export function listenForInput({api,mappings,onCommand,onEvent=()=>{}}){
  let running=true,after=0;const held=new Map();
  (async()=>{
    try{after=(await api('/api/midi/events?after=999999999')).last;}catch{}
    while(running){
      try{
        const {events,last}=await api(`/api/midi/events?after=${after}&wait=1`);after=last;
        for(const event of events){const r=matchInput(mappings(),event,held);onEvent(event,r);if(r.command&&running)onCommand(r.command,r.mapping,event);}
      }catch{await new Promise(r=>setTimeout(r,1000));}
    }
  })();
  return ()=>{running=false;};
}
export {ACTIONS};
