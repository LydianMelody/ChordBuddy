// The patch bay's engine: which sounds and signals drive which parts of a visualization. Pure (no DOM), so it can be tested.
//
// A visualization can declare inputs in its default export: inputs:{key:{label, type, default (a source id, or null), help?}}, and reads them
// each frame as env.inputs.key. Each input's `default` is what the visualization did before it had a patch bay, so a visualization nobody
// has re-patched looks exactly the same. Visualizations without inputs are untouched.
//
// Types (the same names describeSignals() in midi-file.js gives your own MIDI):
//   trigger  a moment, like a drum hit: an array of the strengths (0..1) that fired this frame, usually empty
//   gate     on or off, like the sustain pedal: true or false
//   amount   a level from 0 to 1, like a stem's loudness or the mod wheel
//   bend     -1 to 1, centered at 0, like pitch bend
//   notes    a melody: {active:[{pitch, strength, velocity, start, end, progress…}], next, low, high}, as frame.notes has it, plus all:
//            every note of the melody in time order ({start, end, pitch, strength…}; the same list from frame to frame until the cable or the
//            mix changes), for visuals that plan ahead, like a path laid along the notes
//
// Sources have ids made of URI-encoded parts joined by '/': song/beat, stem/drums/hit, melody/vocal/notes, mine/<part>/cc64…
// A patch is {cables:[{from, to, …adapter settings}]}. A cable between different types converts (adapters below) instead of being refused,
// except that notes only connect to notes. Several cables into one input: triggers merge, gates are on if any is, amounts take the
// largest, bends the one furthest from center.
import {STEM_ORDER} from './visual-scene.js';

export const TYPES=['trigger','gate','amount','bend','notes'];
const SEEK=0.3;                                 // a jump longer than this (or backwards) is a seek: no triggers fire across it
const MAX_CABLES=64,INPUT_KEY=/^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const id=(...parts)=>parts.map(p=>encodeURIComponent(String(p))).join('/');
export const idParts=source=>String(source).split('/').map(p=>{try{return decodeURIComponent(p);}catch{return p;}});

const STEM_NAMES={bass:'Bass',drums:'Drums',other:'Other',vocals:'Vocals',piano:'Piano',lead:'Lead guitar',rhythm:'Rhythm guitar'};
const MELODY_NAMES={lead:'Lead melody',vocal:'Vocal melody',instrumental:'Instrumental melody',melody:'Combined melody'};
const SONG=[
  ['beat','Beat','trigger','Every beat: full strength on the first beat of a bar, about half on the others'],
  ['downbeat','Bar start','trigger','The first beat of every bar'],
  ['chord','Chord change','trigger','Whenever the chord changes'],
  ['section','Section change','trigger','Whenever a new section (verse, chorus…) starts'],
  ['loop-wrap','Loop restart','trigger','Each time a loop jumps back to its start'],
  ['playing','Playing','gate','On while the song plays, off while paused'],
  ['beat-phase','Through the beat','amount','Rises from 0 to 1 across every beat'],
  ['bar-phase','Through the bar','amount','Rises from 0 to 1 across every bar'],
  ['section-progress','Through the section','amount','Rises from 0 to 1 across the current section'],
  ['loop-progress','Through the loop','amount','Rises from 0 to 1 across the loop (0 with no loop)'],
];
const STEM_SIGNALS=[
  ['hit','hits','trigger','Each new hit or note attack in this stem'],
  ['level','loudness','amount','How loud this stem is right now (follows the mixer)'],
  ['brightness','brightness','amount','How bright (trebly) this stem sounds'],
  ['flux','change','amount','How fast this stem’s sound is changing'],
];
const MELODY_SIGNALS=[
  ['notes','notes','notes','The melody’s notes themselves, for visuals that draw a melody'],
  ['on','note starts','trigger','Each new note, as strong as it was sung or played'],
  ['held','note held','gate','On while any note of it sounds'],
  ['pitch','pitch','amount','How high the current note is within this melody’s range (holds between notes)'],
  ['strength','note strength','amount','How strongly the current notes were sung or played (0 between notes)'],
];

/** Every source this song offers, for the patch bay: [{id, label, type, group, part, short, help}]. group: Song, Stems, Melodies, Your MIDI
 *  (later more, such as a DAW project); part: the track or melody it belongs to within its group (null for the song's own); short: its
 *  name within that part ("Hits"); label: the full name, used wherever it stands alone ("Drums hits"). There can be hundreds. */
export function sourceCatalog(scene){
  const out=[],cap=t=>t.charAt(0).toUpperCase()+t.slice(1);
  for(const [key,label,type,help] of SONG)out.push({id:id('song',key),label,type,group:'Song',part:null,short:label,help});
  for(const role of STEM_ORDER){
    for(const [key,what,type,help] of STEM_SIGNALS)out.push({id:id('stem',role,key),label:`${STEM_NAMES[role]} ${what}`,type,group:'Stems',part:STEM_NAMES[role],short:cap(what),help});
    if(role==='drums')out.push({id:id('stem','drums','kick'),label:'Kick drum',type:'trigger',group:'Stems',part:'Drums',short:'Kick drum',help:'Low, punchy drum hits (mostly the kick)'});
  }
  const melodies=['lead',...Object.keys(scene?.midi||{}).filter(n=>MELODY_NAMES[n])];
  for(const name of melodies)for(const [key,what,type,help] of MELODY_SIGNALS)
    out.push({id:id('melody',name,key),label:`${MELODY_NAMES[name]} ${what}`,type,group:'Melodies',part:MELODY_NAMES[name],short:cap(what),
      help:name==='lead'?help+'. The lead melody is the vocal, or the instrumental one while nobody sings':help});
  for(const part of scene?.extras||[]){
    const signals=part.signals||[],has=k=>signals.some(s=>s.key===k),add=(key,short,type,help)=>
      out.push({id:id('mine',part.name,key),label:`${part.name}: ${short}`,type,group:'Your MIDI',part:part.name,short,help});
    for(const s of signals)add(s.key,s.label,s.type,`From your MIDI file (${part.name})`);
    if(has('notes')){
      add('held','Note held','gate','On while any of its notes sounds');
      add('pitch','Pitch','amount','How high the current note is within this part’s range');
    }
  }
  return out;
}

const lastBy=(items,t)=>{let lo=0,hi=items.length-1,found=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(items[mid].start<=t){found=mid;lo=mid+1;}else hi=mid-1;}return found;};
// the strengths of the items starting after `from` and up to `to` (a frame's new ones), at most 8
function startedBetween(items,from,to){
  const out=[];for(let i=lastBy(items,from)+1;i<items.length&&items[i].start<=to&&out.length<8;i++)out.push(items[i].strength??1);return out;
}
// the lead melody: the vocal while it sings, else the instrumental (or combined) melody, else the vocal again (for its next note)
const leadName=frame=>frame.notes.vocal?.active.length?'vocal':frame.notes.instrumental?'instrumental':frame.notes.melody?'melody':'vocal';
const leadMelody=frame=>frame.notes[leadName(frame)]||null;
const leadTrack=(scene,frame)=>scene.midi[leadName(frame)]||null;
const pitchOf=notes=>{
  const top=notes?.active?.reduce((best,n)=>!best||n.pitch>best.pitch?n:best,null);
  if(!top||notes.low===null)return null;return Math.max(0,Math.min(1,(top.pitch-notes.low)/Math.max(12,notes.high-notes.low)));
};
const strongest=(list,k)=>list.reduce((m,n)=>Math.max(m,n[k]??0),0);
const furthest=(list,k)=>list.reduce((m,n)=>Math.abs(n[k]??0)>Math.abs(m)?n[k]:m,0);
export const EMPTY_NOTES=Object.freeze({active:Object.freeze([]),next:null,low:null,high:null,all:Object.freeze([])});
// a melody's whole note list (the lead melody: the vocal and the instrumental one together), without the vocal's notes while the mixer
// silences the vocals; kept per scene, so it stays the same list from frame to frame
const wholeLists=new WeakMap();
const nearAny=(starts,t)=>{const r=Math.round(t*50);return starts.has(r)||starts.has(r-1)||starts.has(r+1);};
function vocalStarts(scene){return wholeList(scene,'vocal-starts',false);}
function wholeList(scene,name,quiet){
  let byName=wholeLists.get(scene);if(!byName)wholeLists.set(scene,byName=new Map());
  const key=name+(quiet?'|quiet':'');if(byName.has(key))return byName.get(key);
  const midi=scene?.midi||{};let out;
  if(name==='vocal-starts')out=new Set((midi.vocal?.notes||[]).map(n=>Math.round(n.start*50)));
  else{
    out=name==='lead'?[...(midi.vocal?.notes||[]),...(midi.instrumental?.notes||midi.melody?.notes||[])].sort((a,b)=>a.start-b.start):(midi[name]?.notes||[]);
    if(quiet){const v=vocalStarts(scene);out=name==='vocal'?[]:out.filter(n=>!nearAny(v,n.start));}
  }
  byName.set(key,out);return out;
}
export const zero=type=>type==='trigger'?[]:type==='gate'?false:type==='notes'?EMPTY_NOTES:0;

/**
 * A source's raw value at this frame (its own type), or undefined when this song does not have it.
 * ctx: {frame, previous (the frame before, or null), events (frameEvents), scene, held (memory for values that hold between notes)}.
 * A stem the mixer has silenced (muted, another one soloed, or its fader down) sends nothing, and the vocal melody goes quiet with the
 * vocals: its cables stay plugged in, so soloing one stem shows just what it moves.
 */
export function sourceValue(source,ctx){
  const [kind,a,b]=idParts(source),{frame,events,scene}=ctx;
  const silent=role=>frame.tracks?.[role]?.gain===0;
  const fresh=!!ctx.previous&&frame.time>ctx.previous.time&&frame.time-ctx.previous.time<=SEEK;
  if(kind==='song'){
    switch(a){
      case 'beat':return events.beat?[events.beat.downbeat?1:0.55]:[];
      case 'downbeat':return events.beat?.downbeat?[1]:[];
      case 'chord':return events.chordChanged?[1]:[];
      case 'section':return events.sectionChanged?[1]:[];
      case 'loop-wrap':return events.loop?.wrapped?[1]:[];
      case 'playing':return !!frame.playing;
      case 'beat-phase':return frame.beat.bar===null?0:frame.beat.phase;
      case 'bar-phase':return frame.beat.bar===null?0:frame.beat.barPhase;
      case 'section-progress':return frame.section.index<0?0:frame.section.progress;
      case 'loop-progress':return frame.loop?.progress??0;
    }
    return undefined;
  }
  if(kind==='stem'){
    if(!STEM_ORDER.includes(a))return undefined;
    const t=frame.tracks[a];
    if(silent(a))return ['hit','kick'].includes(b)?[]:['level','brightness','flux'].includes(b)?0:undefined;
    if(b==='hit')return events.hits[a]||[];
    if(b==='kick')return a==='drums'&&t&&t.brightness<0.45?events.hits.drums||[]:[];
    if(b==='level'||b==='brightness'||b==='flux')return t?t[b]:0;
    return undefined;
  }
  if(kind==='melody'){
    if(a!=='lead'&&!scene.midi?.[a])return undefined;
    // with the vocals silenced, the vocal melody sends nothing and the combined and lead melodies leave its notes out
    const quiet=a!=='instrumental'&&silent('vocals');
    if(a==='vocal'&&quiet)return noteSignal(b,EMPTY_NOTES,[],ctx,source,fresh,EMPTY_NOTES.all);
    if(quiet){
      const name=a==='lead'?(frame.notes.instrumental?'instrumental':'melody'):a,v=vocalStarts(scene),notes=frame.notes[name];
      const kept=notes&&{...notes,active:notes.active.filter(n=>!nearAny(v,n.start)),next:notes.next&&!nearAny(v,frame.time+notes.next.in)?notes.next:null};
      const list=a==='lead'?wholeList(scene,name,false):wholeList(scene,a,true);
      return noteSignal(b,kept,list,ctx,source,fresh,wholeList(scene,a,true));
    }
    const notes=a==='lead'?leadMelody(frame):frame.notes[a];
    const track=a==='lead'?leadTrack(scene,frame):scene.midi[a];
    return noteSignal(b,notes,track?.notes,ctx,source,fresh,wholeList(scene,a,false));
  }
  if(kind==='mine'){
    const part=frame.midi?.[a],extra=(scene.extras||[]).find(x=>x.name===a);if(!part||!extra)return undefined;
    if(b==='hits')return fresh?startedBetween(extra.hits,ctx.previous.time,frame.time):[];
    if(b==='velocity'){const h=extra.hits[part.hitIndex];return h?h.strength:0;}
    if(b==='noteBend')return furthest(part.active,'bend');
    if(b==='notePressure')return strongest(part.active,'pressure');
    if(b==='noteSlide')return strongest(part.active,'slide');
    if(b==='polyPressure')return strongest(part.active,'pressure');
    if(['notes','held','pitch'].includes(b))return noteSignal(b,part,extra.track.notes,ctx,source,fresh,extra.track.notes);
    const sig=extra.signals.find(s=>s.key===b);if(!sig)return undefined;
    const v=part.values[b];return v===undefined?zero(sig.type):v;
  }
  return undefined;
}
function noteSignal(signal,notes,list,ctx,source,fresh,all){
  notes=notes||EMPTY_NOTES;
  switch(signal){
    case 'notes':return {...notes,all:all||[]};
    case 'on':return fresh&&list?startedBetween(list,ctx.previous.time,ctx.frame.time):[];
    case 'held':return notes.active.length>0;
    case 'strength':return strongest(notes.active,'strength');
    case 'pitch':{const p=pitchOf(notes);if(p!==null)ctx.held[source]=p;return ctx.held[source]??0;}
  }
  return undefined;
}

// ---- adapters ----
// The settings a cable from one type to another can have, with their ranges and defaults (the patch bay shows exactly these).
export const SETTINGS={
  decay:{label:'Fade',unit:'s',min:0.02,max:4,step:0.01,value:0.3,help:'How long a trigger’s glow takes to fade'},
  hold:{label:'Hold',unit:'s',min:0.02,max:4,step:0.01,value:0.2,help:'How long a trigger keeps it on'},
  threshold:{label:'Threshold',min:0,max:1,step:0.01,value:0.5,help:'It turns on above this level'},
  min:{label:'Min',min:0,max:1,step:0.01,value:0,help:'The lowest value it sends (when the source is at its lowest)'},
  max:{label:'Max',min:0,max:1,step:0.01,value:1,help:'The highest value it sends (when the source is at its highest)'},
  invert:{label:'Invert',boolean:true,value:false,help:'Flip it: high becomes low, on becomes off'},
  smooth:{label:'Smoothing',unit:'s',min:0,max:2,step:0.01,value:0,help:'Glide instead of jumping (0 follows instantly)'},
};
const levelish=t=>t==='amount'||t==='bend';
// Set from range. A cable from MIDI (your own parts, or the model's melodies) can carry `fit`: [low, high], the part of that signal to use
// as its full range, applied before everything else. Its units (fitUnit): MIDI note numbers for notes and pitch ('note'); 0..1 for strengths
// and levels, -1..1 for a bend ('level'). On/off signals have none.
//   notes    only the notes inside the range pass, and the range becomes the melody's bottom and top (so a keyboard part can be split)
//   pitch    where the current note sits within the range (it holds between notes)
//   trigger  each strength (velocity) is stretched from the range to 0..1
//   amount   stretched to 0..1;  bend: stretched to -1..1
// sourceRange() measures what a signal really does in this song; the patch bay's "Set from range" button stores that, and it can be typed.
// Outside the range (cable.outside): 'clip' holds a value past an edge at that edge; 'drop' leaves it out (a note or hit is ignored, a level
// reads as nothing). Notes leave out by default (a keyboard split), everything else clips.
// fitUnit says how the patch bay shows the range: 'note' (note names), 'midi' (0-127, as MIDI writes velocities, controllers and pressure;
// stored as 0..1 like every level), or 'level' (percent: bends, and the model's melodies, whose strengths are measured, not played).
export function fitUnit(source,type){
  const [kind,,key]=idParts(source);
  if((kind!=='mine'&&kind!=='melody')||type==='gate')return null;
  if(type==='notes'||key==='pitch')return 'note';
  return kind==='mine'&&type!=='bend'?'midi':'level';
}
export const outsideDefault=type=>type==='notes'?'drop':'clip';
function notesOf(source,scene){
  const [kind,name]=idParts(source);
  if(kind==='mine')return (scene?.extras||[]).find(x=>x.name===name)?.track?.notes||null;
  if(kind!=='melody')return null;
  if(name==='lead')return [...(scene?.midi?.vocal?.notes||[]),...(scene?.midi?.instrumental?.notes||scene?.midi?.melody?.notes||[])];
  return scene?.midi?.[name]?.notes||null;
}
/** The lowest and highest value a MIDI source reaches in this song ({low, high}, in its fitUnit), or null (not MIDI, on/off, or it never
 *  changes). */
export function sourceRange(source,scene){
  const [kind,name,key]=idParts(source);if(kind!=='mine'&&kind!=='melody')return null;
  const part=kind==='mine'?(scene?.extras||[]).find(x=>x.name===name):null;if(kind==='mine'&&!part)return null;
  let values;
  if(key==='notes'||key==='pitch')values=(notesOf(source,scene)||[]).map(n=>n.pitch);
  else if(kind==='melody'){if(key!=='on'&&key!=='strength')return null;values=(notesOf(source,scene)||[]).map(n=>n.strength);}
  else if(key==='velocity'||key==='hits')values=part.hits.map(h=>h.strength);
  else if(['notePressure','noteSlide','noteBend','polyPressure'].includes(key)){
    const curve={notePressure:'pressure',noteSlide:'slide',noteBend:'bend',polyPressure:'pressure'}[key];
    values=part.track.notes.flatMap(n=>(n[curve]||[]).map(p=>p.value));
  }else{
    const sig=part.signals.find(s=>s.key===key);if(!sig||!['amount','bend'].includes(sig.type))return null;
    values=(part.controls[key]||[]).map(p=>p.value);
  }
  values=values.filter(Number.isFinite);if(!values.length)return null;
  const low=Math.min(...values),high=Math.max(...values);
  return high-low>1e-3?{low,high}:null;
}
// A cable's fit applied to its source's raw value (the patch bay keeps `s`, the cable's memory, for a pitch held between notes).
function applyFit(cable,type,raw,s,ctx){
  const [lo,hi]=cable.fit,k=v=>Math.max(0,Math.min(1,(v-lo)/(hi-lo))),key=idParts(cable.from)[2];
  const drop=(cable.outside||outsideDefault(type))==='drop',inside=v=>v>=lo&&v<=hi,edge=v=>Math.max(lo,Math.min(hi,v));
  if(type==='notes'){
    // the whole list too, worked out once (not every frame) while the melody and the range stay the same
    const all=raw.all||[];
    if(s.fitAll?.from!==all||s.fitAll.lo!==lo||s.fitAll.hi!==hi||s.fitAll.drop!==drop)
      s.fitAll={from:all,lo,hi,drop,list:drop?all.filter(n=>inside(n.pitch)):all.map(n=>({...n,pitch:edge(n.pitch)}))};
    if(drop)return {...raw,active:raw.active.filter(n=>inside(n.pitch)),next:raw.next&&inside(raw.next.pitch)?raw.next:null,low:lo,high:hi,all:s.fitAll.list};
    return {...raw,active:raw.active.map(n=>({...n,pitch:edge(n.pitch)})),next:raw.next&&{...raw.next,pitch:edge(raw.next.pitch)},low:lo,high:hi,all:s.fitAll.list};
  }
  if(key==='pitch'){
    const notes=sourceValue(cable.from.replace(/[^/]*$/,'notes'),ctx);
    const top=notes?.active?.filter(n=>!drop||inside(n.pitch)).reduce((best,n)=>!best||n.pitch>best.pitch?n:best,null);
    if(top)s.fitPitch=k(top.pitch);return s.fitPitch??0;
  }
  if(type==='trigger')return (drop?raw.filter(inside):raw).map(k);
  if(drop&&!inside(raw))return 0;                                   // a level outside the range reads as nothing (a bend: centered)
  if(type==='bend')return k(raw)*2-1;
  return type==='amount'?k(raw):raw;
}
/** Which settings a cable from `from` to `to` uses; null when they cannot connect (notes only connect to notes). */
export function adapterSettings(from,to){
  if(!TYPES.includes(from)||!TYPES.includes(to))return null;
  if((from==='notes')!==(to==='notes'))return null;
  if(from==='notes')return [];
  if(to==='trigger')return from==='trigger'||from==='gate'?[]:['threshold'];
  if(to==='gate')return from==='trigger'?['hold']:from==='gate'?['invert']:['threshold','invert'];
  return [...(from==='trigger'?['decay']:[]),'min','max','invert','smooth'];   // to an amount or a bend
}
export const canConnect=(from,to)=>adapterSettings(from,to)!==null;

// ---- patches ----
const num=(value,{min,max,value:fallback})=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
/** A saved patch made safe (it comes from a file): {cables:[…], inputs?:[the visualization's inputs when it was saved]} with known
 *  settings in range, or null for none. */
export function cleanPatch(raw){
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.cables))return null;
  const cables=[],seen=new Set();
  for(const c of raw.cables.slice(0,MAX_CABLES)){
    if(!c||typeof c.from!=='string'||typeof c.to!=='string'||c.from.length>300||c.to.length>80||!c.from||!c.to)continue;
    const key=c.from+'>'+c.to;if(seen.has(key))continue;seen.add(key);
    const cable={from:c.from,to:c.to};
    for(const [name,spec] of Object.entries(SETTINGS))if(name in c)cable[name]=spec.boolean?c[name]===true:num(c[name],spec);
    if(Array.isArray(c.fit)&&c.fit.length===2&&c.fit.every(v=>Number.isFinite(v)&&v>=-1&&v<=127)&&c.fit[1]-c.fit[0]>1e-3)cable.fit=[c.fit[0],c.fit[1]];
    if(c.outside==='clip'||c.outside==='drop')cable.outside=c.outside;
    cables.push(cable);
  }
  if(!Array.isArray(raw.inputs))return {cables};
  return {cables,inputs:[...new Set(raw.inputs.filter(k=>typeof k==='string'&&INPUT_KEY.test(k)))].slice(0,MAX_CABLES)};
}
/** A visualization's inputs made safe: [{key, label, type, default, help}] (an input with an unknown type is left out). */
export function readInputs(definition){
  const out=[];
  for(const [key,spec] of Object.entries(definition?.inputs||{})){
    if(!INPUT_KEY.test(key)||!spec||!TYPES.includes(spec.type))continue;
    out.push({key,label:String(spec.label||key).slice(0,60),type:spec.type,default:typeof spec.default==='string'?spec.default:null,help:spec.help?String(spec.help).slice(0,200):''});
  }
  return out;
}
/** The cables a visualization starts with: each input from its default source. */
export const defaultPatch=inputs=>({cables:inputs.filter(i=>i.default).map(i=>({from:i.default,to:i.key}))});
/** The patch in use: the song's own, else the usual one for this visualization, else the defaults. An input the visualization gained
 *  after the patch was saved starts on its default cable instead of unplugged (a patch from before patches listed their inputs knows
 *  the ones it has cables to; with no cables at all, everything was unplugged on purpose). It lists every input it now knows. */
export function choosePatch(inputs,{song=null,usual=null}={}){
  const saved=cleanPatch(song)||cleanPatch(usual);if(!saved)return defaultPatch(inputs);
  const known=new Set(saved.inputs||(saved.cables.length?saved.cables.map(c=>c.to):inputs.map(i=>i.key)));
  const added=inputs.filter(i=>i.default&&!known.has(i.key)).map(i=>({from:i.default,to:i.key}));
  return {cables:[...saved.cables,...added].slice(0,MAX_CABLES),inputs:[...new Set([...known,...inputs.map(i=>i.key)])].slice(0,MAX_CABLES)};
}

/** Runs a patch frame after frame (adapters remember things: a fading glow, a held gate, a smoothed level). */
export class Patcher{
  constructor(){this.state=new Map();this.held={};}
  /**
   * inputs: readInputs(definition); patch: choosePatch(); ctx: {frame, previous, events, scene, dt}. Returns {inputKey: value} for every
   * input, plus `this.live` (the cables that are connected and have a source in this song) for the patch bay to show.
   */
  run(inputs,patch,ctx){
    const out={},types=Object.fromEntries(inputs.map(i=>[i.key,i.type])),full={...ctx,held:this.held};
    const types0=new Map(),live=[],used=new Set();
    const typeOf=src=>{if(!types0.has(src))types0.set(src,ctx.catalog?.get(src)?.type??null);return types0.get(src);};
    for(const cable of patch?.cables||[]){
      const to=types[cable.to];if(!to)continue;
      const raw=sourceValue(cable.from,full);if(raw===undefined)continue;
      const from=typeOf(cable.from)||guessType(raw);if(!canConnect(from,to))continue;
      const value=cable.fit&&fitUnit(cable.from,from)?applyFit(cable,from,raw,this.memory(cable),full):raw;
      out[cable.to]=combine(to,out[cable.to],this.adapt(cable,from,to,value,ctx.dt||0));live.push(cable);used.add(cable.to);
    }
    // an input whose cables all lead to sources this song does not have: its default, so it still does what it always did
    for(const input of inputs){
      if(used.has(input.key)||!input.default)continue;
      if((patch?.cables||[]).some(c=>c.to===input.key)){
        const raw=sourceValue(input.default,full);
        if(raw!==undefined)out[input.key]=this.adapt({from:input.default,to:input.key},input.type,input.type,raw,ctx.dt||0);
      }
    }
    for(const input of inputs)if(!(input.key in out))out[input.key]=zero(input.type);
    this.live=live;
    // forget the memory of cables that went away
    if(this.state.size>live.length+inputs.length+8){const keep=new Set(live.map(c=>c.from+'>'+c.to));for(const k of this.state.keys())if(!keep.has(k))this.state.delete(k);}
    return out;
  }
  memory(cable){const key=cable.from+'>'+cable.to;let s=this.state.get(key);if(!s){s={};this.state.set(key,s);}return s;}
  adapt(cable,from,to,raw,dt){
    const s=this.memory(cable);
    const opt=name=>name in cable?cable[name]:SETTINGS[name].value;
    if(from==='notes')return raw;
    if(to==='trigger'){
      if(from==='trigger')return raw;
      if(from==='gate'){const fire=raw&&!s.was;s.was=raw;return fire?[1]:[];}
      const a=from==='bend'?(raw+1)/2:raw,th=opt('threshold'),fire=a>th&&!(s.last>th);s.last=a;return fire?[a]:[];
    }
    if(to==='gate'){
      let on;
      if(from==='trigger'){s.until=raw.length?opt('hold'):(s.until||0)-dt;on=s.until>0;}
      else if(from==='gate')on=raw;
      else{const a=from==='bend'?(raw+1)/2:raw,th=opt('threshold');on=s.on?a>th-0.02:a>th;s.on=on;}   // a little hysteresis: no flicker
      return opt('invert')?!on:on;
    }
    // to an amount or a bend
    let a;
    if(from==='trigger'){const top=raw.length?Math.max(...raw):0;s.env=Math.max((s.env||0)*Math.exp(-dt/Math.max(0.02,opt('decay'))),top);a=s.env;}
    else if(from==='gate')a=raw?1:0;
    else if(from==='bend')a=(raw+1)/2;
    else a=raw;
    if(opt('invert'))a=1-a;
    a=opt('min')+(opt('max')-opt('min'))*a;
    const smooth=opt('smooth');
    if(smooth>0&&Number.isFinite(s.smoothed))a=s.smoothed+(a-s.smoothed)*Math.min(1,dt/smooth);
    s.smoothed=a;
    return to==='bend'?a*2-1:a;
  }
}
function guessType(raw){return Array.isArray(raw)?'trigger':typeof raw==='boolean'?'gate':raw&&typeof raw==='object'?'notes':'amount';}
function combine(type,before,value){
  if(before===undefined)return value;
  if(type==='trigger')return [...before,...value];
  if(type==='gate')return before||value;
  if(type==='amount')return Math.max(before,value);
  if(type==='bend')return Math.abs(value)>Math.abs(before)?value:before;
  return before;                                 // notes: the first cable wins
}
/** The catalog as a Map by id, for Patcher.run's ctx.catalog. */
export const catalogMap=catalog=>new Map(catalog.map(s=>[s.id,s]));
