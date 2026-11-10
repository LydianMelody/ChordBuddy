// What can be planned at a flag in Prepare: the same categories and actions as MIDI setup (performance-commands.js), plus the things only a plan can do, like sending
// MIDI out or showing a note. An item is one row of the Actions list; it says which fields it has and how they become a saved action, and back again.
// What holds a value through the song (the mixer, the speed, the visual) becomes that kind of action, so a jump still lands on the right state.
// What's a moment (a move, a loop, a pause) is saved as a 'command', and happens as if a foot switch was pressed then. Pure.
import {ACTIONS,STEM_ROLES,applyToState,fadeMix,mixFromState,isKeyframe,domainOf} from './performance-actions.js';
import {COMMAND_GROUPS,commandById,paramsFor} from './performance-commands.js';
import {PRESETS,presetMix} from './mixer-rack.js';
import {defaultMix} from './pcm-mixer-core.js';

// The kinds of action, by flag color: [key, name, what it is].
export const LANES=Object.freeze([['tracks','Mixer','Mixer keyframes, mutes and volumes'],['control','Playback','Speed, pauses, moves and loops'],['visuals','Visuals','Change which visualization shows, or what it does'],['midi','MIDI','Send a message to a pedal or other device, like changing a preset'],['markers','Notes','Words for yourself at a spot, shown on the chart while this arrangement plays']]);
export const laneOf=action=>{const d=domainOf(action);return d==='tracks'?'tracks':d==='rate'||d==='control'?'control':d==='visuals'?'visuals':d==='midi'?'midi':'markers';};

// A new action of each saved type, ready to adjust.
export const NEW_ACTION={
  'track.set':()=>({type:'track.set',track:'lead',mute:true}),
  'master.set':()=>({type:'master.set',value:1,ramp:0}),
  'mix.set':({mix}={})=>keyframeFrom(mix||defaultMix()),
  'command':()=>({type:'command',command:'play-pause',params:{}}),
  'monitor.set':()=>({type:'monitor.set',part:'click',on:false}),
  'rate.set':()=>({type:'rate.set',percent:100}),
  'visual.scene':({scenes})=>({type:'visual.scene',scene:scenes[0]?.id||'abstract'}),
  'visual.switch':()=>({type:'visual.switch',name:'lyrics',value:true}),
  'visual.patch':()=>({type:'visual.patch',patch:'song'}),
  'visual.input':()=>({type:'visual.input',input:'',value:1,ramp:0}),
  'visual.trigger':()=>({type:'visual.trigger',input:''}),
  'midi.helix':({device})=>({type:'midi.helix',device:device||'Line 6 Helix',channel:1,snapshot:1}),
  'midi.cc':({device})=>({type:'midi.cc',device:device||'Line 6 Helix',channel:1,controller:1,value:127}),
  'midi.pc':({device})=>({type:'midi.pc',device:device||'Line 6 Helix',channel:1,program:0}),
  'midi.note':({device})=>({type:'midi.note',device:device||'Line 6 Helix',channel:1,note:60,velocity:100,length:.5}),
  'marker.text':()=>({type:'marker.text',text:'Note'}),
};

// The fields of each saved type. kind: number, optional, helixPreset, text, check, tristate, track, choice, scene, device, input.
const OVER=['ramp','optional','Over this many seconds',{min:0,max:600,step:.5}];
export const FIELDS={
  'track.set':[['track','track','Track'],['mute','tristate','Mute'],['solo','tristate','Solo'],['gain','optional','Level (0 to 1)',{min:0,max:1,step:.05}],OVER],
  'master.set':[['value','number','Overall volume (0 to 1)',{min:0,max:1,step:.05}],['ramp','optional','Over this many seconds (a fade)',{min:0,max:600,step:.5}]],
  'rate.set':[['percent','number','Speed (50 to 125%)',{min:50,max:125,step:5}]],
  'visual.scene':[['scene','scene','Visualization']],
  'visual.patch':[['patch','choice','Connections',{choices:[['song','This song’s own'],['usual','Your usual ones'],['default','The defaults']]}]],
  'visual.input':[['input','input','Part of the visualization',{wants:'level'}],['value','number','Value (0 to 1)',{min:0,max:1,step:.05}],OVER],
  'visual.trigger':[['input','input','Effect to fire',{wants:'trigger'}]],
  'midi.helix':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['setlist','optional','Setlist (1 to 8)',{min:1,max:8,step:1}],['preset','helixPreset','Preset (1A to 32D)',{hint:'Named the way the Helix shows them: bank 1 to 32, then A to D'}],['snapshot','optional','Snapshot (1 to 8)',{min:1,max:8,step:1}]],
  'midi.cc':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['controller','number','Controller',{min:0,max:127,step:1}],['value','number','Value',{min:0,max:127,step:1}]],
  'midi.pc':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['program','number','Program',{min:0,max:127,step:1}]],
  'midi.note':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['note','number','Note (60 is middle C)',{min:0,max:127,step:1}],['velocity','number','Velocity',{min:1,max:127,step:1}],['length','number','Length (seconds)',{min:.01,max:60,step:.05}]],
  'marker.text':[['text','text','Note to show']],
};

/** A whole-mixer keyframe from a mix, changing at once unless told otherwise. */
export function keyframeFrom(mix,move='instant'){
  const tracks={};STEM_ROLES.forEach((role,i)=>{tracks[role]={gain:mix.gains[i],mute:!!mix.mutes[i],solo:!!mix.solos[i]};});
  return {type:'mix.set',tracks,master:mix.master,move};
}
/** The mixer a mix.set or an older track change leaves, starting from `base`. */
export const mixOf=(action,base=defaultMix())=>mixFromState(applyToState({},action),base);
/** What the plan has set by this frame of the song: the first time the music passes it. */
export function plannedStateAt(compiled,frame){
  const music=(compiled?.segments||[]).filter(s=>s.kind==='music');
  const segment=music.find(s=>s.start<=frame&&frame<s.end)||music.at(-1);
  if(!segment)return {};
  let state=segment.state||{};
  for(const a of segment.actions||[])if(!a.oneShot&&a.frame<=frame)state=applyToState(state,a.action);
  return state;
}
/** The plan's mix at a frame, partway through a fade if there's one under way. It's what the mixer shows there, and what a Mixer keyframe starts from. */
export function plannedMixAt(compiled,frame,base=defaultMix()){
  const music=(compiled?.segments||[]).filter(s=>s.kind==='music');
  const segment=music.find(s=>s.start<=frame&&frame<s.end);
  const fade=segment?.actions?.find(a=>a.glide&&a.frame<=frame&&frame<a.frame+a.action.frames);
  if(!fade)return mixFromState(plannedStateAt(compiled,frame),base);
  const before=plannedStateAt(compiled,fade.frame),from=mixFromState(before,base),to=mixFromState(applyToState(before,fade.action.target),base);
  return fadeMix(from,to,(frame-fade.frame)/fade.action.frames);
}

const MOVE=['move','choice','How it changes',{value:'instant',hint:'Fade: the mixer moves smoothly from the last mixer flag before this one, and gets here right at this flag. To fade over two bars, put the flag before it two bars back.',choices:[['instant','Instantly at this flag'],['glide','Fade from the last mixer flag']]}];
const ALWAYS=verb=>['mode','choice','What it does',{value:'on',choices:[['on',`Turn ${verb} on`],['off',`Turn ${verb} off`]]}];

function fromCommand(id){
  const c=commandById(id);
  return {id,group:c.group,label:c.label,help:c.help,fields:c.params||[],start:()=>paramsFor(id),values:a=>paramsFor(id,a.params),make:params=>({type:'command',command:id,params}),matches:a=>a.type==='command'&&a.command===id};
}
const native=(type,{id=type,group,label=ACTIONS[type].label,help})=>({id,group,label,help,fields:FIELDS[type],start:ctx=>NEW_ACTION[type](ctx),values:a=>a,make:v=>({...v,type}),matches:a=>a.type===type});
/** A mixer action with the same words as MIDI setup: it's saved as the part of the mixer it changes. */
function mixerChange(id,fields,build){
  const c=commandById(id),start={};for(const [key,,,o={}] of fields)start[key]=structuredClone(o.value);
  return {id,group:'mixer',label:c.label,help:c.help,fields,start:()=>structuredClone(start),values:a=>({...a.from.params,move:a.move||'instant'}),matches:a=>a.type==='mix.set'&&a.from?.command===id,
    make:({move,...params})=>({type:'mix.set',...build(params),move:move||'instant',from:{command:id,params}})};
}
const eachTrack=(list,fill)=>Object.fromEntries((list||[]).map(key=>[key,fill]));
const TRACKS=commandById('track-mute').params[0];
const LEVEL=['level','number','Volume (0 to 100%)',{value:50,min:0,max:100}];

export const PLAN_GROUPS=Object.freeze([...COMMAND_GROUPS,{id:'midi',label:'Send MIDI',help:'Send a message to a pedal or other device, like changing a preset'},{id:'notes',label:'Notes',help:'Show yourself a note during the show'}]);

export const PLAN_ITEMS=Object.freeze([
  fromCommand('play-pause'),fromCommand('stop'),fromCommand('restart'),
  // a tempo: saved as the speed that plays it there (see rate.set), so jumps, previews and shows treat it as any speed. Listed before speed so a tempo flag opens as one.
  {id:'tempo-set',group:'playback',label:commandById('tempo-set').label,help:commandById('tempo-set').help,fields:commandById('tempo-set').params,
   start:ctx=>({bpm:Number.isFinite(ctx.tempo)?Math.round(ctx.tempo):80,base:ctx.tempo??null}),values:a=>({bpm:a.bpm,base:a.base}),
   make:({bpm,base})=>({type:'rate.set',percent:Number.isFinite(base)&&base>0?Math.round(bpm/base*1000)/10:NaN,bpm,base}),matches:a=>a.type==='rate.set'&&Number.isFinite(a.bpm)},
  native('rate.set',{id:'speed-set',group:'playback',label:commandById('speed-set').label,help:commandById('speed-set').help}),
  fromCommand('speed-change'),
  {id:'speed-normal',group:'playback',label:commandById('speed-normal').label,help:commandById('speed-normal').help,fields:[],start:()=>({}),values:()=>({}),make:()=>({type:'rate.set',percent:100}),matches:()=>false},
  {id:'monitor-click',group:'playback',label:'Click on or off',help:'Turns the click on or off from here on. Only you hear the click. The Click fader in the mixer sets how loud it is, and its M mutes it whatever the flags say.',fields:[['on','check','On']],start:()=>({on:false}),values:a=>({on:a.on}),make:v=>({type:'monitor.set',part:'click',on:!!v.on}),matches:a=>a.type==='monitor.set'&&a.part==='click'},
  {id:'monitor-cue',group:'playback',label:'Cue track on or off',help:'Turns this song’s cue track on or off from here on. Only you hear it. It keeps its place while it’s off, so it comes back in time.',fields:[['on','check','On']],start:()=>({on:false}),values:a=>({on:a.on}),make:v=>({type:'monitor.set',part:'cue',on:!!v.on}),matches:a=>a.type==='monitor.set'&&a.part==='cue'},
  fromCommand('tap-tempo'),fromCommand('resume-automation'),
  fromCommand('song-step'),fromCommand('section-step'),fromCommand('bar-step'),fromCommand('jump-bars'),
  // a loop added here becomes a planned loop (the purple band over its bars), with a count you can click to change it or give one pass its own actions
  {...fromCommand('loop-bars'),help:'Loops this many bars, from the start of this bar, as many times as you choose, or until you leave it. It shows as a purple band over the bars. During a show, L keeps it going round until you leave it, R loops the whole section instead, the same key again leaves after the pass you’re in, and once more goes back to the plan.'},
  {...fromCommand('loop-section'),help:'Loops the whole section this flag is in, from its first bar, as many times as you choose, or until you leave it. It shows as a purple band over the bars. During a show, L keeps it going round until you leave it, R loops the whole section instead, the same key again leaves after the pass you’re in, and once more goes back to the plan.'},
  fromCommand('exit-loop'),
  {id:'mix-keyframe',group:'mixer',label:'Mixer keyframe',help:'Sets the whole mixer, every fader, mute and solo, at this flag. It starts from how the mixer stands here, so change only what you want.',mixer:true,fields:[MOVE],start:ctx=>keyframeFrom(ctx.mix),values:a=>a,make:v=>({...v,type:'mix.set'}),matches:a=>isKeyframe(a)&&!a.from},
  fromCommand('visual-step'),
  native('visual.scene',{id:'visual-choose',group:'display',label:commandById('visual-choose').label,help:commandById('visual-choose').help}),
  {id:'visual-lyrics',group:'display',label:'Lyrics on or off',help:'Shows or hides the lyrics on the visualizer.',fields:[['value','check','On']],start:()=>({value:true}),values:a=>({value:a.value}),make:v=>({type:'visual.switch',name:'lyrics',value:!!v.value}),matches:a=>a.type==='visual.switch'&&a.name==='lyrics'},
  {id:'visual-calm',group:'display',label:'Calm mode on or off',help:'Switches the visualizer’s calmer, less flashy look.',fields:[['value','check','On']],start:()=>({value:true}),values:a=>({value:a.value}),make:v=>({type:'visual.switch',name:'calm',value:!!v.value}),matches:a=>a.type==='visual.switch'&&a.name==='calm'},
  fromCommand('visual-open'),
  native('visual.patch',{group:'display',help:'Changes which saved connections drive the visualization.'}),
  native('visual.input',{group:'display',help:'Moves one part of a visualization to a value.'}),
  native('visual.trigger',{group:'display',help:'Fires one effect of a visualization, once.'}),
  native('midi.helix',{group:'midi',help:'Changes the Helix’s setlist, preset or snapshot.'}),
  native('midi.cc',{group:'midi',help:'Sends a controller value, the message most pedals and switches answer to.'}),
  native('midi.pc',{group:'midi',help:'Asks a device to change its program, or preset.'}),
  native('midi.note',{group:'midi',help:'Plays one note on a device.'}),
  native('marker.text',{group:'notes',help:'Words for yourself at this spot, like a cue on the chart, but only in this arrangement. They show beside the flag here, and on the chart while this arrangement plays (in a show, or with Play on this tab), lit when the music gets there; a show’s Coming up line lists them before that. For a cue every time you play the song, use the Chart tab’s Cue tool.'}),
]);
// Flags saved before keyframes keep working and can still be opened, but aren't offered for new ones.
// Mute, solo, volume, mix and Master flags from before Mixer keyframe became the one mixer action: still played, still opened, and each can become a keyframe.
const OLDER=[...[mixerChange('track-mute',[TRACKS,ALWAYS('mute'),MOVE],p=>({tracks:eachTrack(p.tracks,{mute:p.mode==='on'})})),mixerChange('track-solo',[TRACKS,ALWAYS('solo'),MOVE],p=>({tracks:eachTrack(p.tracks,{solo:p.mode==='on'})})),mixerChange('track-volume',[TRACKS,LEVEL,MOVE],p=>({tracks:eachTrack(p.tracks,{gain:p.level/100})})),mixerChange('mix-preset',[commandById('mix-preset').params[0],MOVE],p=>{const {tracks}=keyframeFrom(presetMix(defaultMix(),p.preset));return {tracks};}),mixerChange('master-volume',[commandById('master-volume').params[0],MOVE],p=>({master:p.level/100}))].map(i=>({...i,help:`${i.help} An older kind of mixer flag: it still plays, and you can turn it into a mixer keyframe.`})),native('track.set',{group:'mixer',help:'A flag from before mixer keyframes. It still works, and you can turn it into a keyframe.'}),native('master.set',{group:'mixer',help:'A flag from before mixer keyframes. It still works, and you can turn it into a keyframe.'})];

export const planItem=id=>PLAN_ITEMS.find(i=>i.id===id)||null;
/** The Actions row a saved action belongs to. */
export const itemFor=action=>PLAN_ITEMS.find(i=>i.matches(action))||OLDER.find(i=>i.matches(action))||null;
export const isOlderMixerFlag=action=>action?.type==='track.set'||action?.type==='master.set'||(action?.type==='mix.set'&&!!action.from);
/** The keyframe an older mixer flag becomes: the whole mix just after it, with its own change in, set to move the way it did. */
export function keyframeForFlag(compiled,frame,action){
  return keyframeFrom(mixFromState(applyToState(plannedStateAt(compiled,frame),action),defaultMix()),action.move||'instant');
}
/** Items whose name, help or category holds every word typed. */
export function searchPlan(text=''){
  const words=String(text).toLowerCase().split(/\s+/).filter(Boolean);
  return PLAN_ITEMS.filter(i=>{const hay=[i.label,i.help,PLAN_GROUPS.find(g=>g.id===i.group)?.label].join(' ').toLowerCase();return words.every(w=>hay.includes(w));});
}
export {PRESETS};
