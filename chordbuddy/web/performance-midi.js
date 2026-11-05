// MIDI for a performance, on the page's side: timed actions to the server's scheduler (midi_service.py), and mapped input back to commands.
// Times: the server's clock never jumps, and this works out the difference to the page's clock from the shortest round trip.
// A commit is a commit: what has reached a device can't be taken back, so only what hasn't gone out is withdrawn, and a changed decision uses a later moment.
import {ACTIONS,actionDef} from './performance-actions.js';

export const COMMANDS=Object.freeze({
  'play-pause':'Play or pause','stop':'Stop the show','loop-bars':'Loop four bars (L)','loop-section':'Loop the section (R)','exit-loop':'Leave the loop',
  'next-song':'Next song','next-bar':'Next bar','previous-bar':'Previous bar','next-section':'Next section','previous-section':'Previous section',
  'resume-automation':'Back to the plan',
});

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

/** What a press means. A mapping: {device, status, data1, min?, edge? ('press' default, 'both'), command}. A press is one going above zero. Ignored events are said to be ignored. */
export function matchInput(mappings,event,held=new Map()){
  const [status,data1=0,data2=0]=event.bytes,key=`${event.device}|${status}|${data1}`;
  const candidates=mappings.filter(m=>m.device===event.device&&m.status===status&&(m.data1===undefined||m.data1===data1));
  if(!candidates.length)return {command:null,reason:'not mapped'};
  const down=(status&0xF0)===0x80?false:data2>0,was=held.get(key)||false;held.set(key,down);
  const m=candidates[0];
  if(m.edge==='both')return down===was?{command:null,reason:'no change'}:{command:m.command,mapping:m};
  if(!down)return {command:null,reason:'release'};
  if(was)return {command:null,reason:'already down'};
  return {command:m.command,mapping:m};
}

/** Learn a mapping from one incoming message. */
export const learnFrom=(event,command)=>({device:event.device,status:event.bytes[0],data1:event.bytes[1],command});

const CLOCK_AHEAD=44100/2;
export function createMidiBridge({api,now=()=>performance.now()/1000,timeOfPlayed,allow=()=>true,onLog=()=>{}}){
  let offset=null,generation=1,clockState={};
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
      if(e.type==='midi'||(e.type==='oneshot'&&e.action?.type?.startsWith('midi.'))){
        if(!allow(e.action)){onLog({skipped:e.action});return;}
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
        for(const event of events){const r=matchInput(mappings(),event,held);onEvent(event,r);if(r.command&&running)onCommand(r.command,event);}
      }catch{await new Promise(r=>setTimeout(r,1000));}
    }
  })();
  return ()=>{running=false;};
}
export {ACTIONS};
