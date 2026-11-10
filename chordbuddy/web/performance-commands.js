// Everything a foot switch or button can be taught to do, and doing it. The same command works in practice and in a running show, the way a key does.
// Only performance and navigation live here: nothing edits a chart or notation. Pure: what it acts on arrives in ctx, so it can be tested without a page.
// ctx: {inShow, controller, view, transport, practice:{run(action), toggleLoop(kind,bars), barStarts(), song(direction)}, visual:{scenes(), current(), show(id,{override}), toggle(name), open()}, tapTempo(params)}.
import {PRESETS,STEM_INDEX,STRIPS,presetMix} from './mixer-rack.js';
import {targetSeconds} from './playback-keys.js';

const trackNames=list=>{const names=STRIPS.filter(s=>list?.includes(s.key)).map(s=>s.label);return names.length===STRIPS.length?'all tracks':names.join(', ')||'no tracks';};
const TRACKS=['tracks','tracks','Which tracks',{value:['vocals']}];
const onOff=verb=>['mode','choice','What it does',{value:'toggle',choices:[['toggle',`Switch ${verb} on or off`],['on',`Always ${verb}`],['off',`Always un-${verb}`]]}];
const wordsFor=(verb,p)=>{const big=verb[0].toUpperCase()+verb.slice(1);return `${p.mode==='on'?big:p.mode==='off'?`Un-${verb}`:`${big} or un-${verb}`} ${trackNames(p.tracks)}`;};
const OVERRIDE=['override','check','Override the set list’s visuals',{value:true,hint:'On: this visual stays until you choose Switch to song defaults. Off: the next visual planned for the song replaces it.'}];
const overrideWords=p=>p.override===false?' until the next planned visual':'';

const DIRECTION=['direction','choice','Direction',{value:1,choices:[[1,'Next'],[-1,'Previous']]}];
const nextOr=(p,what)=>`${p.direction<0?'Previous':'Next'} ${what}`;

export const COMMAND_GROUPS=Object.freeze([
  {id:'playback',label:'Playback',help:'Start and stop the music, and change its speed'},
  {id:'navigation',label:'Song navigation',help:'Move between songs, sections and bars'},
  {id:'looping',label:'Looping',help:'Repeat part of the song'},
  {id:'mixer',label:'Mixer',help:'Mute, solo and set volumes'},
  {id:'display',label:'Display',help:'Change what the visualizer shows'},
]);

/** params: [key, kind, label, {value, ...}]. kind: tracks, number, choice, check, scene. */
export const COMMANDS=Object.freeze([
  {id:'play-pause',group:'playback',label:'Play / pause',help:'Starts the music, or pauses it if it’s playing.'},
  {id:'stop',group:'playback',label:'Stop',help:'Stops a running show. Outside a show, it pauses and goes back to the start of the song.'},
  {id:'restart',group:'playback',label:'Return to song start',help:'Goes to the beginning of this song. In a show, it goes at the next bar line.'},
  {id:'speed-set',group:'playback',label:'Set playback speed',help:'Plays at the speed you choose. The pitch stays the same.',params:[['percent','number','Speed (50 to 125%)',{value:75,min:50,max:125}]],describe:p=>`Set playback speed to ${p.percent}%`},
  {id:'tempo-set',group:'playback',label:'Set tempo (BPM)',help:'Plays at the tempo you choose, in beats per minute, by changing the speed. The pitch stays the same. In a song whose tempo moves, the speed comes from the tempo where the music is.',params:[['bpm','number','Tempo (BPM)',{value:80,min:20,max:300}]],describe:p=>`Set tempo to ${p.bpm} BPM`},
  {id:'speed-change',group:'playback',label:'Adjust playback speed',help:'Changes the speed a little with each press.',params:[['direction','choice','Direction',{value:-1,choices:[[-1,'Slower'],[1,'Faster']]}],['percent','number','How much each press (%)',{value:5,min:1,max:25}]],describe:p=>`${p.direction<0?'Slower':'Faster'} by ${p.percent}%`},
  {id:'speed-normal',group:'playback',label:'Reset playback speed',help:'Returns to 100% speed.'},
  {id:'tap-tempo',group:'playback',label:'Virtual tap tempo',help:'Taps a tempo into your Helix. Following the song sends only tempo changes, so you can still tap your own between them; press it again to go back to the song’s tempo.',params:[['mode','choice','Tempo',{value:'follow',choices:[['follow','Follow song’s tempo map'],['bpm','Set a BPM']]}],['bpm','number','BPM (40 to 240)',{value:120,min:40,max:240,when:p=>p.mode==='bpm'}]],describe:p=>p.mode==='bpm'?`Virtual tap tempo: ${p.bpm} BPM`:'Virtual tap tempo: follow song’s tempo map'},
  {id:'resume-automation',group:'playback',label:'Switch to song defaults',help:'During a show, undoes what you changed by hand, so the song goes back to what you planned for it.'},

  {id:'song-step',group:'navigation',label:'Next / previous song',help:'Next: in a show, goes to the next song at the next bar line, or starts it if the show is waiting for you. Outside a show, either direction opens that song in the list. Previous does nothing during a show, where the order is set.',params:[DIRECTION],describe:p=>nextOr(p,'song')},
  {id:'section-step',group:'navigation',label:'Next / previous section',help:'Goes to the start of the next section, or back to the start of this one, then the one before.',params:[DIRECTION],describe:p=>nextOr(p,'section')},
  {id:'bar-step',group:'navigation',label:'Next / previous bar',help:'Goes to the next bar, or back to the start of this one, then the one before.',params:[DIRECTION],describe:p=>nextOr(p,'bar')},
  {id:'jump-bars',group:'navigation',label:'Jump by bars',help:'Goes forward or back by the number of bars you choose.',params:[['direction','choice','Direction',{value:1,choices:[[1,'Forward'],[-1,'Back']]}],['bars','number','How many bars',{value:4,min:1,max:64}]],describe:p=>`Jump ${p.direction<0?'back':'forward'} ${p.bars} ${p.bars===1?'bar':'bars'}`},

  {id:'loop-bars',group:'looping',label:'Loop bars',help:'Repeats that many bars around where you are, as many times as you choose, or until you press again to leave the loop.',params:[['bars','number','How many bars',{value:4,min:1,max:64}],['plays','optional','How many times it plays',{min:2,max:64,step:1,placeholder:'Until you leave it',hint:'Leave it empty to loop until you press again (or leave the loop). 2 plays it twice: the time through, then once more. After the last one the music carries on.'}]],describe:p=>`Loop ${p.bars??4} ${(p.bars??4)===1?'bar':'bars'}${p.plays?`, ${p.plays} times`:''}`},
  {id:'loop-section',group:'looping',label:'Loop current section',help:'Repeats the section you’re in, as many times as you choose, or until you press again to leave the loop.',params:[['plays','optional','How many times it plays',{min:2,max:64,step:1,placeholder:'Until you leave it',hint:'Leave it empty to loop until you press again (or leave the loop). 2 plays it twice: the time through, then once more. After the last one the music carries on.'}]],describe:p=>`Loop the current section${p.plays?`, ${p.plays} times`:''}`},
  {id:'exit-loop',group:'looping',label:'Exit loop',help:'Stops repeating, whichever loop is on. In a show, it finishes the pass you’re in first.'},

  {id:'track-mute',group:'mixer',label:'Mute tracks',help:'Silences the tracks you choose.',params:[TRACKS,onOff('mute')],describe:p=>wordsFor('mute',p)},
  {id:'track-solo',group:'mixer',label:'Solo tracks',help:'Plays only the tracks you choose.',params:[TRACKS,onOff('solo')],describe:p=>wordsFor('solo',p)},
  {id:'track-volume',group:'mixer',label:'Set track volume',help:'Moves the tracks you choose to one volume.',params:[TRACKS,['level','number','Volume (0 to 100%)',{value:50,min:0,max:100}]],describe:p=>`Set ${trackNames(p.tracks)} to ${p.level}%`},
  {id:'mix-preset',group:'mixer',label:'Apply mix',help:'Switches to one of the mixer’s ready-made mixes. It puts every volume back to full first.',params:[['preset','choice','Which mix',{value:'full',choices:PRESETS.map(p=>[p.id,p.label])}]],describe:p=>`Apply the ${PRESETS.find(x=>x.id===p.preset)?.label??''} mix`},
  {id:'master-volume',group:'mixer',label:'Set master volume',help:'Moves the Master volume, which affects everything.',params:[['level','number','Volume (0 to 100%)',{value:100,min:0,max:100}]],describe:p=>`Set master volume to ${p.level}%`},

  {id:'visual-step',group:'display',label:'Next / previous visual',help:'Moves through the visualizations in your list.',params:[DIRECTION,OVERRIDE],describe:p=>`${nextOr(p,'visual')}${overrideWords(p)}`},
  {id:'visual-choose',group:'display',label:'Select visual',help:'Switches to the visualization you choose.',params:[['scene','scene','Which visual',{value:null}],OVERRIDE],describe:(p,scenes=[])=>`Show ${scenes.find(s=>s.id===p.scene)?.name??'a visual'}${overrideWords(p)}`},
  {id:'visual-lyrics',group:'display',label:'Toggle lyrics',help:'Shows or hides the lyrics on the visualizer.'},
  {id:'visual-calm',group:'display',label:'Toggle calm mode',help:'Switches the visualizer’s calmer, less flashy look.'},
  {id:'visual-open',group:'display',label:'Open visualizer',help:'Opens the visualizer in its own window.'},
]);

// Switches taught before next and previous became one action.
const OLD_COMMANDS={'next-song':['song-step',1],'previous-song':['song-step',-1],'next-section':['section-step',1],'previous-section':['section-step',-1],'next-bar':['bar-step',1],'previous-bar':['bar-step',-1],'visual-next':['visual-step',1],'visual-previous':['visual-step',-1]};
/** A saved switch, in today's terms. */
export function currentMapping(mapping){
  const old=OLD_COMMANDS[mapping?.command];
  return old?{...mapping,command:old[0],params:{...mapping.params,direction:old[1]}}:mapping;
}

export const commandById=id=>COMMANDS.find(c=>c.id===id)||null;
/** The settings a command starts with, with anything saved laid over them. */
export function paramsFor(command,saved={}){
  const out={};for(const [key,,,o={}] of commandById(command)?.params||[])out[key]=saved?.[key]??structuredClone(o.value);
  return out;
}
/** A command with its settings, in words: "Loop 8 bars". */
export function describeCommand(command,params,scenes=[]){
  const c=commandById(command);if(!c)return 'Something this version doesn’t know';
  return c.describe?c.describe(paramsFor(command,params),scenes):c.label;
}
/** Commands whose name, help or group holds every word typed. Empty shows them all. */
export function searchCommands(text=''){
  const words=String(text).toLowerCase().split(/\s+/).filter(Boolean);
  return COMMANDS.filter(c=>{const hay=[c.label,c.help,COMMAND_GROUPS.find(g=>g.id===c.group)?.label].join(' ').toLowerCase();return words.every(w=>hay.includes(w));});
}

/** Runs what a performance has planned, at the moment it's heard. The runner sends it ahead of time, so it waits; a pause keeps it waiting, and a change of plan takes it back. */
export function createCommandOut({timeOf,run,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}){
  const waiting=new Set();
  const wait=item=>{
    const left=timeOf(item.atPlayed)-(item.leadMs||0)-now();
    if(left>20){item.timer=setTimer(()=>wait(item),Math.min(left,250));return;}
    waiting.delete(item);run(item.action,{frame:item.frame});
  };
  return {
    event(e){
      if(e.type==='oneshot'&&e.action?.type==='command'){const item={atPlayed:e.atPlayed,leadMs:e.leadMs,action:e.action,frame:e.frame};waiting.add(item);wait(item);}
      else if(e.type==='withdrawn'){for(const item of waiting)if(item.atPlayed>=e.atPlayed){clearTimer(item.timer);waiting.delete(item);}}
      else if(e.type==='cleanup'){for(const item of waiting)clearTimer(item.timer);waiting.clear();}
    },
    get waiting(){return waiting.size;},
  };
}

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function changeMix(transport,edit){const mix=transport.getSnapshot().mix;edit(mix);transport.setMix(mix);}
function flag(list,params){
  const indexes=(params.tracks||[]).map(k=>STEM_INDEX[k]).filter(Number.isInteger);
  // switching a group follows the first one, so a group never ends up half on and half off
  const value=params.mode==='on'?true:params.mode==='off'?false:!list[indexes[0]];
  for(const i of indexes)list[i]=value;
}
function stepVisual(ctx,direction,params){
  const list=ctx.visual.scenes();if(!list.length)return;
  const at=list.findIndex(s=>s.id===ctx.visual.current());
  const next=at<0?(direction>0?0:list.length-1):(at+direction+list.length)%list.length;
  ctx.visual.show(list[next].id,{override:params.override!==false});
}

/** Does a command. Anything that can't happen here simply doesn't: a pedal press mid-song should never put up a dialog, apart from a real error through the catch by the caller. */
export function runCommand(command,saved,ctx){
  const c=ctx.controller,show=ctx.inShow,t=ctx.transport,p=paramsFor(command,saved);
  switch(command){
    case 'play-pause':if(show){if(ctx.view)ctx.view.act('toggle');else c.togglePlay();}else ctx.practice.run({type:'toggle'});break;
    case 'stop':if(show)c.stop();else{t.pause();t.seek(0)?.catch?.(()=>{});}break;
    case 'restart':if(show)c.navigate(0);else t.seek(0)?.catch?.(()=>{});break;
    case 'bar-step':if(show)c.stepBars(p.direction);else ctx.practice.run({type:'bar',direction:p.direction});break;
    case 'section-step':if(show)c.stepSections(p.direction);else ctx.practice.run({type:'section',direction:p.direction});break;
    case 'jump-bars':{
      if(show){for(let i=0;i<p.bars;i++)c.stepBars(p.direction);break;}
      const starts=ctx.practice.barStarts();let to=t.getSnapshot().seconds,moved=false;
      for(let i=0;i<p.bars;i++){const n=targetSeconds(starts,to,p.direction);if(n===null)break;to=n;moved=true;}
      if(moved)t.seek(to)?.catch?.(()=>{});break;
    }
    case 'song-step':if(!show)ctx.practice.song(p.direction);else if(p.direction>0)c.nextSong();break;
    // a number of plays counts in a show and in a preview; in practice a loop runs until you leave it
    // ctx.frame: a flag's place in the song, so its loop is measured from the flag, not from what's heard a moment before it
    case 'loop-bars':if(show)c.pressLoop('bars',{bars:p.bars,plays:p.plays,at:ctx.frame});else ctx.practice.toggleLoop('bars',p.bars);break;
    case 'loop-section':if(show)c.pressLoop('section',{plays:p.plays,at:ctx.frame});else ctx.practice.toggleLoop('section');break;
    case 'exit-loop':if(show)c.exitLoop();else t.setLoop(null)?.catch?.(()=>{});break;
    case 'track-mute':changeMix(t,mix=>flag(mix.mutes,p));break;
    case 'track-solo':changeMix(t,mix=>flag(mix.solos,p));break;
    case 'track-volume':changeMix(t,mix=>{for(const k of p.tracks||[])mix.gains[STEM_INDEX[k]]=clamp(p.level,0,100)/100;});break;
    case 'mix-preset':{const mix=t.getSnapshot().mix;t.setMix(presetMix(mix,p.preset));break;}
    case 'master-volume':changeMix(t,mix=>{mix.master=clamp(p.level,0,100)/100;});break;
    case 'speed-set':t.setRate(clamp(p.percent,50,125))?.catch?.(()=>{});break;
    case 'speed-change':t.setRate(clamp((t.getSnapshot().rate??100)+p.direction*p.percent,50,125))?.catch?.(()=>{});break;
    case 'speed-normal':t.setRate(100)?.catch?.(()=>{});break;
    // the page says what the song's tempo is where the music is (ctx.speedForBpm); a tempo the speed can't reach says why
    case 'tempo-set':{const r=ctx.speedForBpm?.(p.bpm);if(!r)break;if(r.error)throw Error(r.error);t.setRate(r.percent)?.catch?.(()=>{});break;}
    case 'visual-step':stepVisual(ctx,p.direction,p);break;
    case 'visual-choose':if(p.scene)ctx.visual.show(p.scene,{override:p.override!==false});break;
    case 'visual-lyrics':ctx.visual.toggle('lyrics');break;
    case 'visual-calm':ctx.visual.toggle('calm');break;
    case 'visual-open':ctx.visual.open();break;
    case 'resume-automation':if(show)c.release({});break;
    case 'tap-tempo':ctx.tapTempo?.(p);break;
    default:return false;
  }
  return true;
}
