// Connects the performance system to the app: opens the Prepare, Show and Perform pages, owns the one running show, and turns its reports into what the
// transport reports, so the chart and every visualizer follow along. Keys in a show come here first. app.js only asks this module two things:
// whether a show is running, and to handle a playback key.
import {ShowController} from './performance-controller.js';
import {loadEntry,loadSongGrid} from './performance-song.js';
import {mountPrepare,mountShow} from './performance-prepare.js';
import {mountPerform} from './performance-view.js';
import {createPathSession} from './pcm-path-session.js';
import {createVisualOut} from './performance-visuals.js';
import {createDeviceWatch,createMidiBridge,listenForInput} from './performance-midi.js';
import {playbackAction} from './playback-keys.js';
import {mixFromState} from './performance-actions.js';
import {compilePerformance} from './performance-compiler.js';
import {pathSeconds} from './performance-duration.js';
import {defaultMix} from './pcm-mixer-core.js';
import {loadVisualizations} from './visualizer-view.js';
import {readInputs} from './visual-patch.js';

const RATE=44100;
const RUNNING=['playing','paused','gap','waiting','buffering'];

/** deps: {api, token, transport, visuals, $, songs(), setlists(), currentSong(), showSong(id) (show this song in the app's views; never touches the music),
 *  chordNow(), showError, mappings(): saved MIDI input mappings} */
export function createPerformanceApp(deps){
  const {api,token,transport,visuals,$,showError}=deps;
  const page=$('perform-page');
  let open=null,kind=null,controller=null,view=null,scenes=[],stopInput=null,previewing=false,bridge=null,deviceTimer=null;

  const scenesLoaded=loadVisualizations().then(r=>{scenes=r.scenes.map(s=>({id:s.id,name:s.name,inputs:readInputs(s)}));}).catch(()=>{});
  const devices=()=>['Line 6 Helix'];

  function closePage(){open?.dispose();open=null;kind=null;page.classList.add('hidden');document.body.classList.remove('preparing');}
  function show(k,mount){closePage();kind=k;page.classList.remove('hidden');document.body.classList.add('preparing');open=mount(page);}

  // ---- the running show
  /** When the engine will sound an output frame, in ms on the epoch clock every window shares. */
  function epochOf(atPlayed){
    const m=controller?.lastReport;
    if(!m)return Date.now();
    const rate=(controller.runner?.rate??100)/100,heard=m.heardPlayed??m.played;
    return performance.timeOrigin+m.at+((atPlayed-heard)/RATE/rate+(m.latency||0))*1000;
  }
  function makeController({sendMidi=true}={}){
    const visual=createVisualOut({timeOf:epochOf,post:message=>visuals.perform(message)});
    visuals.setPerformState(visual.current);
    const midi=createMidiBridge({api,timeOfPlayed:p=>(epochOf(p)-performance.timeOrigin)/1000,allow:()=>sendMidi,onLog:entry=>c?.note?.('midi',entry)});
    midi.calibrate().catch(()=>{});
    bridge=midi;
    const c=new ShowController({
      createSession:handlers=>createPathSession({token,...handlers}),
      loadEntry:entry=>loadEntry(api,entry),
      now:()=>performance.now()/1000,
      out:event=>{visual.event(event);midi.event(event);},
      onChange:snapshot=>report(snapshot),
      onSong:id=>deps.showSong(id),
      power:{acquire:()=>api('/api/power/acquire',{holder:'show'}).then(r=>{c.check&&(c.check.keepAwake=r.awake);if(!r.awake)c.check?.notes.push('This computer may still go to sleep during the show: keeping it awake didn’t work.');}).catch(()=>{}),release:()=>api('/api/power/release',{holder:'show'}).catch(()=>{})},
    });
    c.epochNow=()=>Date.now();
    c.checkpoint={save:value=>deps.prefs.set('cb-show-running',JSON.stringify(value)),load:()=>{try{return JSON.parse(deps.prefs.get('cb-show-running','null'));}catch{return null;}},clear:()=>deps.prefs.set('cb-show-running','null')};
    return c;
  }
  /** What every view reads: the same values a practice stream would report. */
  function report(snapshot){
    const r=controller?.runner;if(!controller||!r)return;
    const clockDevice=controller.show?.midiClock?.device;
    if(clockDevice&&bridge){if(snapshot.status==='playing')bridge.clock(r,clockDevice);else if(['stopped','finished','error'].includes(snapshot.status))bridge.stopClock(clockDevice);}
    const now=snapshot.song,planned=r.withOverrides(r.plannedThrough(r.played)),mix=mixFromState(planned,defaultMix()),m=controller.lastReport;
    const looped=now?.loop||(r.current?.regionId?{start:r.current.start,end:r.current.end,kind:r.current.family}:null);
    const playing=snapshot.status==='playing';
    const visualMix=controller.show?.keepVisualsWhenMuted?{...mix,mutes:mix.mutes.map(()=>false),solos:mix.solos.map(()=>false)}:null;
    transport.performerReport({seconds:(now?.source??0)/RATE,playing,playIntent:RUNNING.includes(snapshot.status)&&snapshot.status!=='paused',buffering:snapshot.status==='buffering',
      loop:looped?{enabled:true,start:looped.start/RATE,end:looped.end/RATE,implicit:true,kind:looped.kind||'bars'}:{enabled:false,start:null,end:null,implicit:false},
      mix,visualMix,rate:r.rate,levels:playing&&Array.isArray(m?.levels)?m.levels:null,duration:(r.grid.frames)/RATE,ready:true});
    if(snapshot.status==='finished'||snapshot.status==='stopped'||snapshot.status==='error')release();
  }
  function release(){
    clearInterval(deviceTimer);
    if(!transport.performer)return;
    stopInput?.();stopInput=null;previewing=false;
    transport.detachPerformer();visuals.setPerformState(null);
  }
  const isRunning=()=>!!controller&&(RUNNING.includes(controller.status)||controller.status==='armed');

  async function armShow(showBody){
    if(controller&&RUNNING.includes(controller.status))throw Error('A show is already running. Stop it first.');
    await scenesLoaded;
    controller=makeController();
    const used=new Set(),devicesNeeded=new Set();
    const check=await controller.arm(showBody,{});
    for(const item of controller.loaded.values())for(const s of item.compiled?.segments||[])for(const a of s.actions||[]){if(a.action.type==='visual.scene')used.add(a.action.scene);if(a.action.device)devicesNeeded.add(a.action.device);}
    for(const d of showBody.devices||[])if(d.critical)devicesNeeded.add(d.name);
    const missingScenes=[...used].filter(id=>!scenes.some(s=>s.id===id));
    const connections=[];
    for(const name of devicesNeeded){const r=await api('/api/midi/connect',{name}).catch(()=>null);connections.push({name,connected:!!r?.output,critical:!!showBody.devices?.find?.(d=>d.name===name&&d.critical)});}
    void check;
    const awake=await api('/api/power').then(r=>r.supported).catch(()=>false);
    const items=[...controller.entries].map(e=>controller.loaded.get(e.id));
    const {preflight}=await import('./performance-controller.js');
    controller.check=preflight(items,{devices:connections,missingScenes,keepAwake:awake?null:false});
    controller.status=controller.check.ready?'armed':'preparing';
    transport.attachPerformer(controller);
    stopInput=listenForInput({api,mappings:deps.mappings,onCommand:runCommand});
    // a device unplugged during the show: say so, stop only if the show can't do without it; back again: it gets where things stand, not what it missed
    const running=controller,needed=connections.map(c=>({name:c.name,critical:c.critical}));
    const watch=createDeviceWatch({api,devices:()=>needed,onLost:(name,critical)=>running.deviceLost(name,critical),
      onBack:name=>{running.deviceBack(name);const r=running.runner;if(r)bridge?.chase(r.withOverrides(r.plannedThrough(r.played)),name).catch(()=>{});}});
    if(needed.length){clearInterval(deviceTimer);deviceTimer=setInterval(()=>{if(controller===running&&RUNNING.includes(running.status))watch.check();},4000);}
    return controller.check;
  }
  function runCommand(command){
    if(!controller)return;
    const map={'play-pause':()=>view?view.act('toggle'):controller.togglePlay(),stop:()=>controller.stop(),'loop-bars':()=>controller.pressLoop('bars'),'loop-section':()=>controller.pressLoop('section'),'exit-loop':()=>controller.exitLoop(),'next-song':()=>controller.nextSong(),'next-bar':()=>controller.stepBars(1),'previous-bar':()=>controller.stepBars(-1),'next-section':()=>controller.stepSections(1),'previous-section':()=>controller.stepSections(-1),'resume-automation':()=>controller.release({})};
    map[command]?.();
  }

  // ---- pages
  async function openPrepare(){
    const song=deps.currentSong();
    if(!song){showError(Error('Open a song first, then choose Prepare.'));return;}
    let grid;try{grid=await loadSongGrid(api,song.id);}catch(error){showError(error);return;}
    await scenesLoaded;
    show('prepare',root=>mountPrepare(root,{api,songId:song.id,grid,scenes:()=>scenes,devices,showError,onClose:closePage,
      previewing:()=>previewing,
      onStopPreview:()=>{controller?.stop();release();},
      onPreview:(performance,fromSeconds,sendMidi)=>startPreview(song.id,performance,fromSeconds,sendMidi,grid).catch(showError)}));
  }
  async function startPreview(songId,performance,fromSeconds,sendMidi,grid){
    if(controller&&RUNNING.includes(controller.status))controller.stop();
    release();
    controller=makeController({sendMidi});
    const entry={id:'preview',songId,performanceId:null};
    controller.loadEntry=async()=>({song:grid.song,performance,compiled:compilePerformance(performance,{measures:grid.measures,frames:grid.frames}),grid:{measures:grid.measures,frames:grid.frames},sections:grid.sections,manifest:grid.manifest,trim:grid.trim,baseMix:defaultMix()});
    const check=await controller.arm({id:'preview',name:'Preview',entries:[entry]},{});
    if(!check.ready){showError(Error(check.blocking[0]));return;}
    transport.attachPerformer(controller);previewing=true;
    await controller.start({from:Math.round(fromSeconds*RATE)});
    open?.paint();
  }
  function openShow(){
    show('show',root=>mountShow(root,{api,songs:deps.songs,setlists:deps.setlists,showError,onClose:closePage,mappings:deps.mappings,saveMappings:deps.saveMappings,
      entryLength:async entry=>{const item=await loadEntry(api,entry);return {segments:item.compiled.segments,music:pathSeconds(item.compiled.segments).music,live:item.compiled.requiresLiveControl};},
      onPerform:async body=>{try{await armShow(body);openPerform();}catch(error){showError(error);}}}));
  }
  function openPerform(){
    if(!controller){openShow();return;}
    show('perform',root=>{
      view=mountPerform(root,{controller,onClose:closePage,chordAt:()=>deps.chordNow(),catalog:deps.songs});
      return {dispose(){view?.dispose();view=null;}};
    });
  }

  // ---- keys: the same keys as ever, the show's way
  function handleKey(event){
    if(!controller||!RUNNING.includes(controller.status)&&!(controller.status==='armed'&&kind==='perform'))return false;
    const action=playbackAction(event);
    if(!action)return false;
    event.preventDefault();event.stopPropagation();
    if(action.repeat)return true;
    if(action.type==='toggle'){if(view)view.act('toggle');else controller.togglePlay();}
    else if(action.type==='loop')controller.pressLoop(action.kind==='bars'?'bars':'section');
    else if(action.type==='bar')controller.stepBars(action.direction);
    else if(action.type==='section')controller.stepSections(action.direction);
    view?.paint();
    return true;
  }
  document.addEventListener('keydown',event=>{if(!document.querySelector('dialog[open]'))handleKey(event);},true);

  $('perform-prepare').onclick=()=>{$('perform-menu').open=false;openPrepare();};
  $('perform-shows').onclick=()=>{$('perform-menu').open=false;openShow();};
  $('perform-stage').onclick=()=>{$('perform-menu').open=false;openPerform();};
  return {
    isRunning,closePage,
    get controller(){return controller;},
    get page(){return kind;},
    /** The song the running show is on, or null: nothing else can be opened while it plays. */
    ownsSong:()=>controller&&RUNNING.includes(controller.status)?controller.current?.songId??null:null,
  };
}
