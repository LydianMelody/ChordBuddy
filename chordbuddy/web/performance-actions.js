// Everything a performance can do by itself: one registry of actions, for the editor, the compiler and the engine alike.
// An action is plain data, {type, ...fields}. Imported files can only name actions from this list; they can never run code.
//   kind 'state'  sets a value that stays (a fader, a scene, a Helix snapshot). After a jump, the value there is worked out again and set.
//   kind 'oneshot' happens once when the music crosses it (a flash, a MIDI note, a marker). Skipped ones are never played to catch up.
// writes(action) lists the properties an action sets. A property is what a live change takes over: muting the guitar by hand blocks later
// planned guitar mutes, and nothing else. A Helix tone is one property, because changing its preset overwrites everything under it.
// Pure: no DOM, no clock.
import {commandById,describeCommand} from './performance-commands.js';

export const STEM_ROLES=Object.freeze(['bass','drums','other','vocals','piano','lead','rhythm']);        // the mixer's order
const STEM_NAMES={bass:'Bass',drums:'Drums',other:'Other',vocals:'Vocals',piano:'Piano',lead:'Lead guitar',rhythm:'Rhythm guitar'};
export const DOMAINS=Object.freeze(['tracks','visuals','midi','rate','structure','control']);
export const RATE_MIN=50,RATE_MAX=125;

const int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
/** The Helix's own name for a preset: four to a bank, so 1 is 1A, 4 is 1D, 5 is 2A, up to 128, which is 32D. */
export const helixPresetName=n=>`${Math.ceil(n/4)}${'ABCD'[(n-1)%4]}`;
const unit=v=>Number.isFinite(v)&&v>=0&&v<=1;
const text=(v,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00\r\n]/.test(v);
const ramp=a=>a.ramp===undefined||(Number.isFinite(a.ramp)&&a.ramp>=0&&a.ramp<=600);
const channel=a=>int(a.channel,1,16);
const percent=v=>`${Math.round(v*100)}%`;
const after=a=>a.ramp?` over ${a.ramp} seconds`:'';
const mixTrack=t=>t&&typeof t==='object'&&(t.gain===undefined||unit(t.gain))&&(t.mute===undefined||typeof t.mute==='boolean')&&(t.solo===undefined||typeof t.solo==='boolean');
/** A keyframe sets every track and the master; anything less changes only part of the mixer. */
export const isKeyframe=a=>a?.type==='mix.set'&&a.master!==undefined&&STEM_ROLES.every(r=>a.tracks?.[r]?.gain!==undefined&&a.tracks[r].mute!==undefined&&a.tracks[r].solo!==undefined);
const mixWrites=a=>{
  const out=[];
  for(const role of STEM_ROLES){const t=a.tracks?.[role];if(!t)continue;for(const k of ['gain','mute','solo'])if(t[k]!==undefined)out.push([`track.${role}.${k}`,t[k]]);}
  if(a.master!==undefined)out.push(['master',a.master]);
  return out;
};

export const ACTIONS=Object.freeze({
  'track.set':{domain:'tracks',kind:'state',label:'Change a track',
    check:a=>!STEM_ROLES.includes(a.track)?'Choose a track.':(a.gain===undefined&&a.mute===undefined&&a.solo===undefined)?'Choose what changes on this track.':(a.gain!==undefined&&!unit(a.gain))||(a.mute!==undefined&&typeof a.mute!=='boolean')||(a.solo!==undefined&&typeof a.solo!=='boolean')||!ramp(a)?'That track setting is out of range.':null,
    writes:a=>[['gain',a.gain],['mute',a.mute],['solo',a.solo]].filter(([,v])=>v!==undefined).map(([k,v])=>[`track.${a.track}.${k}`,v]),
    describe:a=>{const name=STEM_NAMES[a.track],parts=[];if(a.mute!==undefined)parts.push(a.mute?`mute ${name}`:`unmute ${name}`);if(a.solo!==undefined)parts.push(a.solo?`solo ${name}`:`stop soloing ${name}`);if(a.gain!==undefined)parts.push(`set ${name} to ${percent(a.gain)}${after(a)}`);const s=parts.join(', ');return s[0].toUpperCase()+s.slice(1);}},
  'master.set':{domain:'tracks',kind:'state',label:'Change the overall volume',
    check:a=>!unit(a.value)||!ramp(a)?'The overall volume is out of range.':null,
    writes:a=>[['master',a.value]],
    describe:a=>`${a.ramp?'Fade':'Set'} the overall volume to ${percent(a.value)}${after(a)}`},
  // The mixer at a moment: a keyframe sets all of it, or a change sets part of it. move 'glide' fades from the mixer's last planned change to arrive here;
  // otherwise it changes at once. `from` remembers the choice it was made from, so it reads and reopens that way.
  'mix.set':{domain:'tracks',kind:'state',label:'Mixer keyframe',
    check:a=>{
      if(a.move!==undefined&&!['instant','glide'].includes(a.move))return 'Choose how the mixer changes.';
      if(a.master!==undefined&&!unit(a.master))return 'The master volume is out of range.';
      for(const [role,t] of Object.entries(a.tracks||{}))if(!STEM_ROLES.includes(role)||!mixTrack(t))return 'A track setting is out of range.';
      return mixWrites(a).length?null:'Choose what changes in the mixer.';
    },
    writes:mixWrites,
    describe:a=>{const base=a.from?describeCommand(a.from.command,a.from.params):isKeyframe(a)?'Mixer keyframe':'Change the mixer';return a.move==='glide'?`${base}, fading from the last change`:base;}},
  // Does what a foot switch would do at this moment, by the same name: moves wait for the next bar line, as they do when you press them.
  'command':{domain:'control',kind:'oneshot',label:'Playback or navigation',
    check:a=>commandById(a.command)?null:'Chord Buddy doesn’t know that action.',
    writes:()=>[],
    describe:a=>describeCommand(a.command,a.params)},
  // The click and the cue track: only you hear them (monitor-out.js). A flag turns one off or back on from here on; the mixer's M still mutes it whatever the flags say.
  'monitor.set':{domain:'control',kind:'state',label:'Click or cue track on or off',
    check:a=>!['click','cue'].includes(a.part)||typeof a.on!=='boolean'?'Choose the click or the cue track, on or off.':null,
    writes:a=>[[`monitor.${a.part}`,a.on]],
    describe:a=>`Turn the ${a.part==='click'?'click':'cue track'} ${a.on?'on':'off'}`},
  'rate.set':{domain:'rate',kind:'state',label:'Change the speed',
    // a tempo flag is a speed too, worked out from the song's tempo where it was placed (base): it keeps its BPM to read and reopen as a tempo
    check:a=>Number.isFinite(a.bpm)&&!(Number.isFinite(a.base)&&a.base>0)?'This song’s tempo isn’t known yet, so a tempo can’t be set. Use a speed instead.':!(Number.isFinite(a.percent)&&a.percent>=RATE_MIN&&a.percent<=RATE_MAX)?(Number.isFinite(a.bpm)?`The song is at ${Math.round(a.base)} BPM here, so the speed can play it from ${Math.ceil(a.base*RATE_MIN/100)} to ${Math.floor(a.base*RATE_MAX/100)} BPM.`:`Speed must be between ${RATE_MIN}% and ${RATE_MAX}%.`):null,
    writes:a=>[['rate',a.percent]],
    describe:a=>Number.isFinite(a.bpm)?`Set the tempo to ${a.bpm} BPM`:`Set the speed to ${a.percent}%`},
  'visual.scene':{domain:'visuals',kind:'state',label:'Change the visualization',
    check:a=>!text(a.scene,40)?'Choose a visualization.':null,
    writes:a=>[['visual.scene',a.scene]],
    describe:a=>`Show the ${a.scene} visualization`},
  'visual.switch':{domain:'visuals',kind:'state',label:'Lyrics or calm mode',
    check:a=>!['lyrics','calm'].includes(a.name)||typeof a.value!=='boolean'?'Choose lyrics or calm mode, on or off.':null,
    writes:a=>[[`visual.${a.name}`,a.value]],
    describe:a=>`Turn ${a.name==='calm'?'calm mode':'the lyrics'} ${a.value?'on':'off'}`},
  'visual.patch':{domain:'visuals',kind:'state',label:'Use a saved set of connections',
    check:a=>!['song','usual','default'].includes(a.patch)?'Choose this song’s connections, your usual ones, or the defaults.':null,
    writes:a=>[['visual.patch',a.patch]],
    describe:a=>`Use ${a.patch==='song'?'this song’s':a.patch==='usual'?'your usual':'the default'} connections in the visuals`},
  'visual.input':{domain:'visuals',kind:'state',label:'Set a part of the visualization',
    check:a=>!text(a.input,40)||!unit(a.value)||!ramp(a)?'Choose a part of the visualization and a value from 0 to 1.':null,
    writes:a=>[[`visual.input.${a.input}`,a.value]],
    describe:a=>`Set “${a.input}” to ${percent(a.value)}${after(a)}`},
  'visual.trigger':{domain:'visuals',kind:'oneshot',label:'Fire a visual effect',
    check:a=>!text(a.input,40)?'Choose the effect to fire.':null,
    writes:()=>[],
    describe:a=>`Fire “${a.input}”`},
  'midi.helix':{domain:'midi',kind:'state',label:'Helix: setlist, preset or snapshot',
    check:a=>!text(a.device)||!channel(a)?'Choose a device and channel.':(a.setlist===undefined&&a.preset===undefined&&a.snapshot===undefined)?'Choose a setlist, preset or snapshot.':(a.setlist!==undefined&&!int(a.setlist,1,8))||(a.preset!==undefined&&!int(a.preset,1,128))||(a.snapshot!==undefined&&!int(a.snapshot,1,8))?'Setlists run 1–8, presets 1A–32D, snapshots 1–8.':null,
    writes:a=>[[`midi.${a.device}.tone`,{channel:a.channel,setlist:a.setlist,preset:a.preset,snapshot:a.snapshot}]],   // applyToState keeps what a flag leaves at No change
    // The documented order: bank (CC32), then Program Change, then snapshot (CC69). Wire values count from 0.
    bytes:a=>{const s=0xB0+a.channel-1,out=[];if(a.setlist!==undefined)out.push([s,32,a.setlist-1]);if(a.preset!==undefined)out.push([0xC0+a.channel-1,a.preset-1]);if(a.snapshot!==undefined)out.push([s,69,a.snapshot-1]);return out;},
    describe:a=>[a.setlist!==undefined&&`setlist ${a.setlist}`,a.preset!==undefined&&`preset ${helixPresetName(a.preset)}`,a.snapshot!==undefined&&`snapshot ${a.snapshot}`].filter(Boolean).join(', ').replace(/^./,c=>`Helix: ${c.toUpperCase()}`)},
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
  'marker.text':{domain:'structure',kind:'oneshot',label:'A note to yourself',
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
/** How loud each track really is under this mix's mutes and solos. */
export function audibleGains(mix){
  const soloing=mix.solos.some(Boolean);
  return mix.gains.map((g,i)=>mix.mutes[i]||(soloing&&!mix.solos[i])?0:g);
}
/** The mixer a fraction of the way through a fade. With the same mutes and solos at both ends, only the faders move. Otherwise a track going in or out of a mute or solo
 *  fades by how loud it really is, and the mute or solo lands at the end; one muted at both ends just stays muted. */
export function fadeMix(from,to,f){
  const mix=structuredClone(to);mix.master=from.master+(to.master-from.master)*f;
  const same=from.mutes.every((m,i)=>m===to.mutes[i])&&from.solos.every((s,i)=>s===to.solos[i]);
  if(same){mix.gains=to.gains.map((g,i)=>from.gains[i]+(g-from.gains[i])*f);return mix;}
  const low=audibleGains(from),high=audibleGains(to),stays=i=>from.mutes[i]&&to.mutes[i];
  mix.gains=high.map((g,i)=>stays(i)?to.gains[i]:low[i]+(g-low[i])*f);
  mix.mutes=to.mutes.map((_,i)=>stays(i));mix.solos=mix.solos.map(()=>false);
  return mix;
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
  if(property.startsWith('monitor.'))return 'control';
  return 'structure';
}

/** The planned state with nothing changed: each property absent until something sets it, so "unset" and "default" stay different. */
export const emptyState=()=>({});
export function applyToState(state,action){
  const out={...state};
  for(const [property,value] of writesOf(action)){
    // a Helix flag that leaves its setlist, preset or snapshot at No change keeps what came before
    if(property.endsWith('.tone')&&value&&typeof value==='object')out[property]={...out[property],...Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined))};
    else out[property]=value;
  }
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
