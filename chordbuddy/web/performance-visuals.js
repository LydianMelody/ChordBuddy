// What a performance does to a visualizer. The player sends timed actions ahead, each stamped with the moment it should be seen; this holds them
// and lays them over what the patch bay worked out for the frame. A scene change, a switch or a set value stays until replaced. A fired effect fires
// once, on the first frame at or after its moment. A visualizer opened late gets the state in force now, never the old effects again.
// A live loop's replay resets the seeded random numbers, so sparks and the like repeat the same way each pass. What a scene keeps by itself between
// frames (particles already flying) carries on, unless it reads env.events.replay and starts over. Pure: time comes in as an argument.

function mulberry(seed){
  let a=seed>>>0;
  return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
export const hashText=text=>{let h=2166136261;for(const c of String(text)){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return h>>>0;};

export class VisualCues{
  constructor(){this.pending=[];this.state={scene:null,lyrics:null,calm:null,inputs:{}};this.ramps=new Map();this.fired=new Map();this.random=Math.random;this.replay=null;this.lastReplay=null;}
  /** message: {state?: the state in force now, cues?: [{at, kind, ...}], withdraw?: at, clear?: true}. */
  receive(message){
    if(message.clear){this.pending=[];this.state={scene:null,lyrics:null,calm:null,inputs:{}};this.ramps.clear();this.fired.clear();this.random=Math.random;return;}
    if(Number.isFinite(message.withdraw))this.pending=this.pending.filter(c=>c.at<message.withdraw);
    if(message.state)this.takeState(message.state);
    if(message.cues?.length){this.pending.push(...message.cues);this.pending.sort((a,b)=>a.at-b.at);}
  }
  takeState(state){
    this.state={scene:state.scene??null,lyrics:state.lyrics??null,calm:state.calm??null,inputs:{...(state.inputs||{})}};
    this.ramps.clear();
  }
  /** Bring everything up to `now`. */
  step(now){
    while(this.pending.length&&this.pending[0].at<=now){
      const c=this.pending.shift();
      switch(c.kind){
        case 'scene':this.state.scene=c.scene;break;
        case 'switch':this.state[c.name]=c.value;break;
        case 'input':
          if(c.ramp>0)this.ramps.set(c.input,{from:this.state.inputs[c.input]??0,to:c.value,start:c.at,end:c.at+c.ramp*1000});
          else this.ramps.delete(c.input);
          this.state.inputs[c.input]=c.value;break;
        case 'trigger':this.fired.set(c.input,(this.fired.get(c.input)||0)+1);break;
        case 'state':this.takeState(c.state);break;
        case 'replay':this.random=mulberry(hashText(c.loop));this.replay={loop:c.loop,pass:c.pass};break;
        default:break;
      }
    }
  }
  valueOf(input,now){
    const r=this.ramps.get(input);
    if(!r)return this.state.inputs[input];
    if(now>=r.end){this.ramps.delete(input);return r.to;}
    return r.from+(r.to-r.from)*Math.max(0,(now-r.start)/(r.end-r.start));
  }
  /** Lays cues over a frame's patched values, by each input's type. inputs: [{key,type}]; values: env.inputs. Effects fire once, then clear. */
  overlay(inputs,values,now){
    for(const {key,type} of inputs){
      const v=this.valueOf(key,now),shots=this.fired.get(key);
      if(v!==undefined){
        if(type==='gate')values[key]=v>=.5;
        else if(type==='amount')values[key]=v;
        else if(type==='bend')values[key]=v*2-1;
      }
      if(shots){
        if(type==='trigger')values[key]=[...(Array.isArray(values[key])?values[key]:[]),...Array(shots).fill(1)];
        else if(type==='gate')values[key]=true;
        else if(type==='amount'||type==='bend')values[key]=1;
      }
    }
    this.fired.clear();
    return values;
  }
  /** Taken once a frame by the visualizer, for env.events.replay. */
  takeReplay(){const r=this.replay;this.replay=null;return r;}
}

/** On the player: turns a runner's events into stamped messages. timeOf(atPlayed)->epoch ms when that output frame will be heard; post(message). */
export function createVisualOut({timeOf,post}){
  // What's in force, for a visualizer opening late.
  let state={scene:null,lyrics:null,calm:null,inputs:{}};
  const stateOf=s=>{
    const out={scene:s['visual.scene']??null,lyrics:s['visual.lyrics']??null,calm:s['visual.calm']??null,inputs:{}};
    for(const [k,v] of Object.entries(s))if(k.startsWith('visual.input.'))out.inputs[k.slice(13)]=v;
    return out;
  };
  const cueOf=(action,at,leadMs=0)=>{
    const t=at-leadMs;
    switch(action.type){
      case 'visual.scene':return {at:t,kind:'scene',scene:action.scene};
      case 'visual.switch':return {at:t,kind:'switch',name:action.name,value:action.value};
      case 'visual.input':return {at:t,kind:'input',input:action.input,value:action.value,ramp:action.ramp||0};
      case 'visual.trigger':return {at:t,kind:'trigger',input:action.input};
      default:return null;
    }
  };
  return {
    event(e){
      switch(e.type){
        case 'visual':case 'oneshot':{const c=cueOf(e.action,timeOf(e.atPlayed),e.leadMs);if(c){post({cues:[c]});
          if(c.kind==='scene')state={...state,scene:c.scene};else if(c.kind==='switch')state={...state,[c.name]:c.value};else if(c.kind==='input')state={...state,inputs:{...state.inputs,[c.input]:c.value}};}break;}
        case 'state':{state=stateOf(e.state);post({cues:[{at:timeOf(e.atPlayed),kind:'state',state}]});break;}
        case 'loop-replay':post({cues:[{at:timeOf(e.atPlayed),kind:'replay',loop:e.loop,pass:e.pass}]});break;
        case 'withdrawn':post({withdraw:timeOf(e.atPlayed)});break;
        case 'live':if(String(e.property).startsWith('visual.')){const name=e.property.slice(7);
          if(name==='scene'||name==='lyrics'||name==='calm')state={...state,[name]:e.value};else if(name.startsWith('input.'))state={...state,inputs:{...state.inputs,[name.slice(6)]:e.value}};
          post({state});}break;
        case 'cleanup':state={scene:null,lyrics:null,calm:null,inputs:{}};post({clear:true});break;
        default:break;
      }
    },
    current:()=>({state}),
  };
}
