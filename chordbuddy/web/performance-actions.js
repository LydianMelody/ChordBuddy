// Everything a performance can do by itself: one registry of actions, for the editor, the compiler and the engine alike.
// An action is plain data, {type, ...fields}. Imported files can only name actions from this list; they can never run code.
//   kind 'state'  sets a value that stays (a fader, a scene, a Helix snapshot). After a jump, the value there is worked out again and set.
//   kind 'oneshot' happens once when the music crosses it (a flash, a MIDI note, a marker). Skipped ones are never played to catch up.
// writes(action) lists the properties an action sets. A property is what a live change takes over: muting the guitar by hand blocks later
// planned guitar mutes, and nothing else. A Helix tone is one property, because changing its preset overwrites everything under it.
// Pure: no DOM, no clock.

export const STEM_ROLES=Object.freeze(['bass','drums','other','vocals','piano','lead','rhythm']);        // the mixer's order
const STEM_NAMES={bass:'Bass',drums:'Drums',other:'Other',vocals:'Vocals',piano:'Piano',lead:'Lead guitar',rhythm:'Rhythm guitar'};
export const DOMAINS=Object.freeze(['tracks','visuals','midi','rate','structure']);
export const RATE_MIN=50,RATE_MAX=125;

const int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
const unit=v=>Number.isFinite(v)&&v>=0&&v<=1;
const text=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00\r\n]/.test(v);
const ramp=a=>a.ramp===undefined||(Number.isFinite(a.ramp)&&a.ramp>=0&&a.ramp<=600);
const channel=a=>int(a.channel,1,16);
const percent=v=>`${Math.round(v*100)}%`;
const after=a=>a.ramp?` over ${a.ramp} seconds`:'';

export const ACTIONS=Object.freeze({
  'track.set':{domain:'tracks',kind:'state',label:'Change a track',
    check:a=>!STEM_ROLES.includes(a.track)?'Choose a track.':(a.gain===undefined&&a.mute===undefined&&a.solo===undefined)?'Choose what changes on this track.':(a.gain!==undefined&&!unit(a.gain))||(a.mute!==undefined&&typeof a.mute!=='boolean')||(a.solo!==undefined&&typeof a.solo!=='boolean')||!ramp(a)?'That track setting is out of range.':null,
    writes:a=>[['gain',a.gain],['mute',a.mute],['solo',a.solo]].filter(([,v])=>v!==undefined).map(([k,v])=>[`track.${a.track}.${k}`,v]),
    describe:a=>{const name=STEM_NAMES[a.track],parts=[];if(a.mute!==undefined)parts.push(a.mute?`mute ${name}`:`unmute ${name}`);if(a.solo!==undefined)parts.push(a.solo?`solo ${name}`:`stop soloing ${name}`);if(a.gain!==undefined)parts.push(`set ${name} to ${percent(a.gain)}${after(a)}`);const s=parts.join(', ');return s[0].toUpperCase()+s.slice(1);}},
  'master.set':{domain:'tracks',kind:'state',label:'Change the overall volume',
    check:a=>!unit(a.value)||!ramp(a)?'The overall volume is out of range.':null,
    writes:a=>[['master',a.value]],
    describe:a=>`${a.ramp?'Fade':'Set'} the overall volume to ${percent(a.value)}${after(a)}`},
  'rate.set':{domain:'rate',kind:'state',label:'Change the speed',
    check:a=>!(Number.isFinite(a.percent)&&a.percent>=RATE_MIN&&a.percent<=RATE_MAX)?`Speed must be between ${RATE_MIN}% and ${RATE_MAX}%.`:null,
    writes:a=>[['rate',a.percent]],
    describe:a=>`Set the speed to ${a.percent}%`},
  'visual.scene':{domain:'visuals',kind:'state',label:'Change the visualization',
    check:a=>!text(a.scene,40)?'Choose a visualization.':null,
    writes:a=>[['visual.scene',a.scene]],
    describe:a=>`Show the ${a.scene} visualization`},
  'visual.switch':{domain:'visuals',kind:'state',label:'Lyrics or calm mode',
    check:a=>!['lyrics','calm'].includes(a.name)||typeof a.value!=='boolean'?'Choose lyrics or calm mode, on or off.':null,
    writes:a=>[[`visual.${a.name}`,a.value]],
    describe:a=>`Turn ${a.name==='calm'?'calm mode':'the lyrics'} ${a.value?'on':'off'}`},
  'visual.input':{domain:'visuals',kind:'state',label:'Set a part of the visualization',
    check:a=>!text(a.input,40)||!unit(a.value)||!ramp(a)?'Choose a part of the visualization and a value from 0 to 1.':null,
    writes:a=>[[`visual.input.${a.input}`,a.value]],
    describe:a=>`Set “${a.input}” to ${percent(a.value)}${after(a)}`},
  'visual.trigger':{domain:'visuals',kind:'oneshot',label:'Fire a visual effect',
    check:a=>!text(a.input,40)?'Choose the effect to fire.':null,
    writes:()=>[],
    describe:a=>`Fire “${a.input}”`},
  'midi.helix':{domain:'midi',kind:'state',label:'Helix: setlist, preset or snapshot',
    check:a=>!text(a.device)||!channel(a)?'Choose a device and channel.':(a.setlist===undefined&&a.preset===undefined&&a.snapshot===undefined)?'Choose a setlist, preset or snapshot.':(a.setlist!==undefined&&!int(a.setlist,1,8))||(a.preset!==undefined&&!int(a.preset,1,128))||(a.snapshot!==undefined&&!int(a.snapshot,1,8))?'Setlists run 1–8, presets 1–128, snapshots 1–8.':null,
    writes:a=>[[`midi.${a.device}.tone`,{setlist:a.setlist,preset:a.preset,snapshot:a.snapshot}]],
    // The documented order: bank (CC32), then Program Change, then snapshot (CC69). Wire values count from 0.
    bytes:a=>{const s=0xB0+a.channel-1,out=[];if(a.setlist!==undefined)out.push([s,32,a.setlist-1]);if(a.preset!==undefined)out.push([0xC0+a.channel-1,a.preset-1]);if(a.snapshot!==undefined)out.push([s,69,a.snapshot-1]);return out;},
    describe:a=>[a.setlist!==undefined&&`setlist ${a.setlist}`,a.preset!==undefined&&`preset ${a.preset}`,a.snapshot!==undefined&&`snapshot ${a.snapshot}`].filter(Boolean).join(', ').replace(/^./,c=>`Helix: ${c.toUpperCase()}`)},
  'midi.cc':{domain:'midi',kind:'state',label:'MIDI controller value (CC)',
    check:a=>!text(a.device)||!channel(a)||!int(a.controller,0,127)||!int(a.value,0,127)?'Choose a device, channel, controller and value (0–127).':null,
    writes:a=>[[`midi.${a.device}.${a.channel}.cc.${a.controller}`,a.value]],
    bytes:a=>[[0xB0+a.channel-1,a.controller,a.value]],
    describe:a=>`Send CC ${a.controller} = ${a.value} on channel ${a.channel}`},
  'midi.pc':{domain:'midi',kind:'state',label:'MIDI program change',
    check:a=>!text(a.device)||!channel(a)||!int(a.program,0,127)?'Choose a device, channel and program (0–127).':null,
    writes:a=>[[`midi.${a.device}.${a.channel}.pc`,a.program]],
    bytes:a=>[[0xC0+a.channel-1,a.program]],
    describe:a=>`Send program ${a.program} on channel ${a.channel}`},
  'midi.note':{domain:'midi',kind:'oneshot',label:'MIDI note',
    check:a=>!text(a.device)||!channel(a)||!int(a.note,0,127)||!int(a.velocity,1,127)||!(Number.isFinite(a.length)&&a.length>0&&a.length<=60)?'Choose a device, channel, note, velocity and length.':null,
    writes:()=>[],
    bytes:a=>[[0x90+a.channel-1,a.note,a.velocity]],
    describe:a=>`Play MIDI note ${a.note} for ${a.length} seconds on channel ${a.channel}`},
  'marker.text':{domain:'structure',kind:'oneshot',label:'A note on the stage screen',
    check:a=>!text(a.text)?'Type the note to show.':null,
    writes:()=>[],
    describe:a=>`Show “${a.text}”`},
});

export const actionDef=action=>Object.hasOwn(ACTIONS,action?.type??'')?ACTIONS[action.type]:null;
/** Why this action cannot be used, in plain words, or null when it is fine. */
export function checkAction(action){
  const def=actionDef(action);
  if(!def)return `Chord Buddy doesn’t know how to do “${String(action?.type??'nothing')}”.`;
  return def.check(action);
}
export const describeAction=action=>actionDef(action)?.describe(action)??'Unknown action';
export const writesOf=action=>actionDef(action)?.writes(action)??[];
export const isOneShot=action=>actionDef(action)?.kind==='oneshot';
export const domainOf=action=>actionDef(action)?.domain??null;
/** Which control domain a property belongs to, for the override policy. */
export function domainOfProperty(property){
  if(property==='master'||property.startsWith('track.'))return 'tracks';
  if(property==='rate')return 'rate';
  if(property.startsWith('visual.'))return 'visuals';
  if(property.startsWith('midi.'))return 'midi';
  return 'structure';
}

/** The planned state with nothing changed: each property absent until something sets it, so "unset" and "default" stay different. */
export const emptyState=()=>({});
export function applyToState(state,action){
  const out={...state};
  for(const [property,value] of writesOf(action))out[property]=value;
  return out;
}
/** A mixer setting from a state. base: the mix the song starts from; properties the state never set keep base's value. */
export function mixFromState(state,base){
  const mix=structuredClone(base);
  STEM_ROLES.forEach((role,i)=>{
    if(state[`track.${role}.gain`]!==undefined)mix.gains[i]=state[`track.${role}.gain`];
    if(state[`track.${role}.mute`]!==undefined)mix.mutes[i]=state[`track.${role}.mute`];
    if(state[`track.${role}.solo`]!==undefined)mix.solos[i]=state[`track.${role}.solo`];
  });
  if(state.master!==undefined)mix.master=state.master;
  return mix;
}
