// The sound only you hear: the click and the cue track, played by Python (chordbuddy/monitor_audio.py) so that OBS's capture of the music doesn't pick them up.
// This decides what plays and when, and sends it a moment ahead on the clock live MIDI uses. It reads where the music really is from the player's reports, so it
// follows repeats, loops, jumps and speed changes the way the MIDI does, in practice and in a show. It never touches the music, and if Python can't play, the music carries on.
//
// A stretch is a run of music with nothing unexpected in it: {cycle (a new number each time the music starts on a new path), from, to (source frames), at (when `from` is heard, page seconds), speed}.
// Only the player knows where the music is, so performance-app.js and transport.js each say what's coming as a list of stretches.
const RATE=44100;
export const AHEAD=.4;              // how far ahead sounds are sent: room for a slow page, and short enough that a change of plan rarely has to take any back
const DRIFT=.03;                    // the cue track is put back in place if it's ever this far out
const ASK_EVERY=2;                  // seconds between checks of the clocks while something is playing
const START_MARGIN=.12;             // a cue track starting now is told to start this far ahead, so it starts in time

/** The beats of the song between two source frames: [{frame, accent}], with the first of each bar as the accent. */
export function beatsBetween(measures,from,to,rate=RATE){
  const out=[];
  // A pickup before bar 1 is often too short for the beat finder to get right (Call Me's came out 1.6x too fast). Its clicks keep bar 1's beat instead, counted back from bar 1.
  const list=measures||[],bar1=list.find(m=>m.number>=1);
  if(bar1&&list[0]!==bar1){
    const beat=(bar1.end-bar1.start)/Math.max(1,(bar1.beats||[]).length),pickupStart=list[0].start-beat*.25;
    // counted back from bar 1, so each keeps its place in the bar: the first beat of a bar is accented, as it is everywhere else
    const meter=Math.max(1,(bar1.beats||[]).length);
    for(let j=1,t=bar1.start-beat;t>=pickupStart;j++,t-=beat){const frame=Math.round(t*rate);if(frame>=from&&frame<to)out.unshift({frame,accent:j%meter===0});}
  }
  for(const m of list){
    if(m.number<1)continue;
    if((m.end*rate)<=from)continue;
    if((m.start*rate)>=to)break;
    (m.beats||[]).forEach((beat,i)=>{const frame=Math.round(beat*rate);if(frame>=from&&frame<to)out.push({frame,accent:i===0});});
  }
  return out;
}
/** The stretches of practice playback: from where the music is now, and round a loop if there's one. */
export function practiceStretches({source,at,speed,loop,end,cycle}){
  const first={cycle,from:source,to:loop&&source<loop.end?loop.end:end,at,speed};
  if(!loop||source>=loop.end)return [first];
  return [first,{cycle:cycle+1,from:loop.start,to:loop.end,at:at+(loop.end-source)/RATE/speed,speed,jumped:true}];
}
/** The stretches of a running show (performance-runner.js): the segment playing, and the next one once it's committed. timeOf(frame) says when a place in the segment playing is heard. */
export function showStretches(runner,timeOf){
  const c=runner?.current;if(!c)return [];
  const speed=(runner.rate??100)/100,list=[{cycle:runner.traversal,from:c.start,to:c.end,at:timeOf(c.start),speed,key:c.key}];
  const b=runner.boundary;
  if(b?.segment?.kind==='music')list.push({cycle:runner.traversal+1,from:b.segment.start,to:b.segment.end,at:timeOf(b.at),speed,key:b.segment.key,jumped:b.jumped||!!b.nav});
  return list;
}

/** What's planned to sound from these stretches now that hasn't been sent. sent: the Set of keys sent so far, added to here.
 *  allowClick(stretch,frame) says whether the click is on there. */
export function planClicks({stretches,measures,now,ahead=AHEAD,sent,allowClick=()=>true}){
  const events=[];
  for(const s of stretches){
    const toTime=frame=>s.at+(frame-s.from)/RATE/s.speed;
    if(toTime(s.from)>now+ahead)break;
    const fromFrame=Math.max(s.from,Math.floor(s.from+(now-s.at)*RATE*s.speed)),toFrame=Math.min(s.to,Math.ceil(s.from+(now+ahead-s.at)*RATE*s.speed));
    for(const beat of beatsBetween(measures,fromFrame,toFrame)){
      const key=`${s.cycle}:${beat.frame}`;if(sent.has(key))continue;sent.add(key);
      if(allowClick(s,beat.frame))events.push({at:toTime(beat.frame),kind:'click',accent:beat.accent});
    }
  }
  return events;
}
/** Where the cue track should be. was: what it was last told, {song, cycle, source, at, speed}. Returns a new instruction when the music took a new path, changed speed or drifted away, or nothing.
 *  A stretch that simply carries on from the last is left alone, so there's no seam to hear. */
export function planCue({stretches,was,song,now,margin=START_MARGIN,drift=DRIFT}){
  const here=stretches.find(s=>{const t=s.at+(s.to-s.from)/RATE/s.speed;return s.at<=now&&now<t;})||stretches[0];
  if(!here||!song)return null;
  const sourceAt=(s,t)=>s.from+(t-s.at)*RATE*s.speed;
  const instruct=(s,when)=>{const at=Math.max(when,s.at);return {at,song,cycle:s.cycle,source:Math.max(s.from,sourceAt(s,at))/RATE,speed:s.speed};};
  if(!was||was.song!==song)return instruct(here,now+margin);
  const expected=was.source*RATE+(now-was.at)*RATE*was.speed,off=Math.abs(expected-sourceAt(here,now))/RATE/here.speed;
  if(was.speed!==here.speed||off>drift){
    // about to reach a jump that's coming anyway: that one puts it right
    const next=stretches[stretches.indexOf(here)+1];
    if(was.speed===here.speed&&next?.jumped&&next.at-now<margin)return null;
    return instruct(here,now+margin);
  }
  return null;
}

/** The next stretch that isn't simply the music carrying on, sent when its moment is within reach. */
export function planCueJump({stretches,was,song,now,ahead=AHEAD}){
  if(!was||!song)return null;
  for(const s of stretches){
    if(s.cycle<=was.cycle||s.at<=now||s.at>now+ahead||!s.jumped)continue;
    return {at:s.at,song,cycle:s.cycle,source:s.from/RATE,speed:s.speed};
  }
  return null;
}

/** performer(): while a show runs, {song, measures, stretches(now), countIn?: [{k, at, accent}], waiting?: true during a gap, next?: the next song, clickOn?(stretch,frame), cueFlags?(stretches,now): [{key, at, on}]}; otherwise null.
 *  practice(): {song, measures} for what's open. onProblem(message): said once, and the music carries on. */
export function createMonitorOut({api,transport,performer=()=>null,practice=()=>null,now=()=>performance.now()/1000,onProblem=()=>{}}){
  let practiceCount=null;            // {song, clicks:[{k, at, accent}], until (source frame)}: the count-in Play asked for, in practice
  let offset=null,fastest=Infinity,lastAsked=-Infinity,calibrating=null,sent=new Set(),cue=null,moving=false,lastKey=null,cycle=0,lastSource=null,failed=false,clickOn=false,cueWanted=false;
  const tracks=new Map();                         // song -> the version of its cue track, loaded and ready; null for none; a promise while it's asked for
  const fail=error=>{if(!failed){failed=true;onProblem(error?.message||String(error));}};
  const toServer=seconds=>seconds+(offset??0);
  /** The page's clock and Python's run at one speed, so all that's needed is how far apart they are. A busy page or server only ever makes an answer slower,
   *  and throws its reading off by up to that much, so the quickest answer yet is the one to go by. */
  async function askClock(){
    lastAsked=now();
    const a=now(),{clock}=await api('/api/monitor/status'),b=now();
    if(b-a<fastest){fastest=b-a;offset=clock-(a+b)/2;}
  }
  function calibrate(rounds=12){
    calibrating??=(async()=>{
      for(let i=0;i<rounds;i++)await askClock();
      await api('/api/monitor/schedule',{events:[]});     // opens the output now, so the first click isn't lost to opening it
    })().catch(fail).finally(()=>{calibrating=null;});
    return calibrating;
  }
  /** Take back everything, and start over from where the music is. */
  function reset(){
    sent=new Set();cue=null;practiceCount=null;
    if(moving){moving=false;api('/api/monitor/cancel',{}).catch(()=>{});}
  }
  function send(events){
    if(!events.length)return;
    moving=true;
    api('/api/monitor/schedule',{events:events.map(e=>({...e,at:toServer(e.at)}))}).then(()=>{failed=false;}).catch(fail);
  }
  /** A song's cue track, asked for once and made ready ahead of the moment it's needed. */
  function trackFor(song){
    if(!tracks.has(song)){
      const asking=api('/api/monitor/load',{song_id:song}).then(r=>{tracks.set(song,r.key);return r.key;}).catch(error=>{
        tracks.set(song,null);if(!/no cue track/i.test(error?.message||''))fail(error);return null;});
      tracks.set(song,asking);
    }
    return tracks.get(song);
  }
  function practiceNow(state){
    const d=transport.getDiagnostics?.();if(!d||d.state!=='playing'||!Number.isFinite(d.heardAt))return null;
    const loop=state.loop?.enabled&&Number.isFinite(state.loop.start)?{start:Math.round(state.loop.start*RATE),end:Math.round(state.loop.end*RATE)}:null;
    return practiceStretches({source:d.sourceFrame,at:d.heardAt,speed:(state.rate??100)/100,loop,end:Math.round((state.duration||0)*RATE),cycle});
  }
  function tick(state=transport.getSnapshot()){
    const show=performer(),open=show||practice();
    const keyNow=show?`show|${show.song}`:`${state.songId}|${state.seeks}|${state.loop?.enabled?`${state.loop.start}-${state.loop.end}`:''}`;
    if(!show&&!state.playIntent)lastKey=keyNow;          // moving the playhead while stopped is where the next Play starts, not a jump away from it
    const counting=!!show?.countIn?.length||(!show&&practiceCount?.song===open?.song);
    if(!(clickOn||cueWanted||counting)||!open||!(state.playIntent||show?.waiting)){if(moving)reset();lastSource=null;return;}
    if(offset===null){calibrate();return;}
    if(!calibrating&&now()-lastAsked>ASK_EVERY)askClock().catch(()=>{});
    const t=now(),key=keyNow;
    // a jump nobody planned (a seek, a new song, a loop moved): start over. Going round a loop is part of the plan, below. A count-in Play asked for a moment
    // ago belongs to where the music starts now, so it stays.
    if(key!==lastKey){const fresh=practiceCount&&practiceCount.clicks.some(c=>c.at>t)?practiceCount:null;if(lastKey!==null)reset();practiceCount=fresh;lastKey=key;lastSource=null;}
    // a count-in plays whatever the click's M says: it's asked for song by song
    for(const c of show?.countIn??(practiceCount?.song===open?.song?practiceCount.clicks:[])){
      const id=`in:${open.song}:${c.k}`;
      if(c.at>t&&c.at<=t+AHEAD&&!sent.has(id)){sent.add(id);send([{at:c.at,kind:'click',accent:!!c.accent}]);}
    }
    if(show?.next&&cueWanted)trackFor(show.next);       // the next song's cue track, ready before it's needed
    const stretches=show?show.stretches(t):practiceNow(state);
    if(!stretches?.length)return;
    if(!show){
      const source=stretches[0].from;
      if(lastSource!==null&&source<lastSource-RATE*.05){cycle++;for(const s of stretches)s.cycle++;}
      lastSource=source;
    }
    const countUntil=!show&&practiceCount?.song===open.song?practiceCount.until:-Infinity;
    if(clickOn)send(planClicks({stretches,measures:open.measures,now:t,sent,allowClick:(s,frame)=>frame>=countUntil&&(open.clickOn?.(s,frame)??true)}));
    if(cueWanted){
      const track=trackFor(open.song);
      if(typeof track==='string'){
        const change=planCue({stretches,was:cue,song:track,now:t})||planCueJump({stretches,was:cue,song:track,now:t});
        if(change){cue=change;send([{at:change.at,kind:'cue',song:change.song,source:change.source,speed:change.speed}]);}
        for(const flag of open.cueFlags?.(stretches,t)??[]){if(!sent.has(flag.key)){sent.add(flag.key);send([{at:flag.at,kind:flag.on?'cue-on':'cue-off'}]);}}
      }
    }
  }
  const unsubscribe=transport.subscribe(tick);
  return {
    tick,reset,calibrate,trackFor,
    /** A count-in Play asked for in practice. Taken back by a pause, a seek, or a new song, like everything else here. */
    countIn(plan){practiceCount=plan;if(offset===null)calibrate();},
    /** The cue track was added, replaced or removed. */
    forgetTrack(song){tracks.delete(song);cue=null;},
    /** The strips changed. A muted part isn't only silent: nothing is even scheduled for it. */
    setMonitor(values){
      const before=[clickOn,cueWanted];
      clickOn=!values.click.mute&&values.click.gain>0;cueWanted=!values.cue.mute&&values.cue.gain>0;
      api('/api/monitor/gains',{click:values.click.gain,cue:values.cue.gain}).catch(fail);
      if(before[0]!==clickOn||before[1]!==cueWanted)reset();
      if((clickOn||cueWanted)&&!before[0]&&!before[1])calibrate();
    },
    dispose(){unsubscribe();reset();},
  };
}
