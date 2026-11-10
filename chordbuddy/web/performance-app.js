// Connects the performance system to the app: opens the Prepare page and the show controls, keeps the set list's details for the sidebar, owns the one running show, and turns its reports into what the
// transport reports, so the chart and every visualizer follow along. Keys in a show come here first. app.js only asks this module two things:
// whether a show is running, and to handle a playback key.
import {ShowController} from './performance-controller.js';
import {loadEntry,loadSongGrid} from './performance-song.js';
import {mountPrepare} from './performance-prepare.js';
import {createSetlistPanel} from './performance-setlist.js';
import {mountPerform} from './performance-view.js';
import {createPathSession} from './pcm-path-session.js';
import {createVisualOut} from './performance-visuals.js';
import {canTapTempo,createDeviceWatch,createMidiBridge,createTempoTap,listenForInput,speedForTempo,tempoAt} from './performance-midi.js';
import {createCommandOut,runCommand} from './performance-commands.js';
import {openMidiSetup} from './midi-setup.js';
import {showStretches} from './monitor-out.js';
import {songCount} from './monitor-strips.js';
import {playbackAction} from './playback-keys.js';
import {desktopWindow} from './visual-bridge.js';
import {mixFromState} from './performance-actions.js';
import {compilePerformance} from './performance-compiler.js';
import {plannedMixAt,plannedStateAt} from './performance-plan.js';
import {pathSeconds} from './performance-duration.js';
import {defaultMix} from './pcm-mixer-core.js';
import {loadVisualizations} from './visualizer-view.js';
import {readInputs} from './visual-patch.js';

const RATE=44100;
const RUNNING=['playing','paused','gap','waiting','buffering'];

/** deps: {api, token, transport, visuals, $, songs(), setlists(), currentSong(), showSong(id) (show this song in the app's views; never touches the music),
 *  onShow(): a show's controls opened, or it started (app.js opens the sound window for OBS); copyObsAddress(): copies the visualizer's OBS address, resolves true if copied,
 *  chordNow(), showError, mappings(): saved MIDI input mappings, saveMappings(list),
 *  tapDevice(): the device that follows each song's tempo map by virtual tap, or nothing; setTapDevice(name),
 *  practice: what a taught switch does outside a show (run(action), toggleLoop(kind,bars), barStarts(), songTempo(), song(direction), currentVisual(), showVisual(id), toggleVisual(name), visualSwitch(name))} */
export function createPerformanceApp(deps){
  const {api,token,transport,visuals,$,showError}=deps;
  const page=$('perform-page');
  let open=null,kind=null,controller=null,view=null,scenes=[],previewing=false,bridge=null,deviceTimer=null,controllerVisual=null;

  const scenesLoaded=loadVisualizations().then(r=>{scenes=r.scenes.map(s=>({id:s.id,name:s.name,inputs:readInputs(s)}));}).catch(()=>{});
  const devices=()=>['Line 6 Helix'];

  /** keepShow: only the page is being redrawn, so an armed show stays armed. */
  function closePage({keepShow=false}={}){
    if(kind==='prepare'){transport.planPlay=null;planned=null;previewTurn++;clearTimeout(planTimer);}
    if(kind==='prepare'&&previewing){controller?.stop();release();}
    if(kind==='prepare')letGoOfPlanView();
    // a show that was never started lets go of the music, so practice playback works again; come back through Perform
    if(!keepShow&&kind==='perform'&&controller&&['armed','preparing'].includes(controller.status)){release();controller=null;}
    const wasPerform=kind==='perform',wasPrepare=kind==='prepare';
    open?.dispose();open=null;kind=null;page.classList.add('hidden');document.body.classList.remove('preparing','performing');
    if(wasPerform)deps.redrawLibrary?.();
    deps.onPageChange?.();
    if(wasPrepare)setlist.reloadFacts();   // its arrangements may have changed
  }
  // Prepare sits beside the mixer, so what a plan changes can be seen changing; the show controls sit above the chart and the mixer.
  function show(k,mount){closePage({keepShow:k==='perform'});kind=k;if(k==='prepare')$('workspace').querySelector('.stage').before(page);else $('work').before(page);page.classList.remove('hidden');document.body.classList.toggle('preparing',k!=='perform');document.body.classList.toggle('performing',k==='perform');open=mount(page);deps.onPageChange?.();}
  /** The Perform tab says so while a show runs, wherever you are. */
  let tabSaidRunning=false;
  const showRunning=()=>!!controller&&RUNNING.includes(controller.status)&&!previewing;
  function paintRunning(){
    if(showRunning()!==tabSaidRunning){tabSaidRunning=showRunning();if(tabSaidRunning)deps.onShow?.();deps.onPageChange?.();}   // a show that has just started: the sound window for OBS is opened if it isn't
  }

  // ---- the running show
  /** When the engine will sound an output frame, in ms on the epoch clock every window shares. */
  function epochOf(atPlayed){
    const m=controller?.lastReport;
    if(!m)return Date.now();
    const rate=(controller.runner?.rate??100)/100,heard=m.heardPlayed??m.played;
    return performance.timeOrigin+m.at+((atPlayed-heard)/RATE/rate+(m.latency||0))*1000;
  }
  /** What the click and the cue track follow in a show. */
  function monitorSource(){
    const c=controller,r=c?.runner,m=c?.lastReport;
    if(!c||transport.performer!==c||!r||!m||!Number.isFinite(m.heardAt))return null;
    const song=c.current?.songId,speed=(r.rate??100)/100;
    if(m.slot!==c.slot)return {song,measures:r.measures,stretches:()=>[],waiting:true};   // a new song, not yet heard from
    // when a place in this segment is heard, reckoned from what's being heard now. For a moment after a jump what's heard is still the old place, so that report says nothing.
    const timeOf=frame=>m.heardAt+(m.gap||0)/RATE+(frame-m.heardFrame)/RATE/speed;
    // ... and a first report can come before the count-in's silence has begun, when it would say the music is about to start
    const settled=r.current&&m.heardFrame>=r.current.start&&m.heardFrame<=r.current.end&&!(c.status==='gap'&&!m.gap);
    // what the plan says about the click or the cue track at a place in a stretch
    const segmentOf=s=>s.cycle===r.traversal?r.current:r.boundary?.segment;
    const flagged=(part,s,frame)=>{const segment=segmentOf(s);let on=(segment?.state??r.planned)?.[`monitor.${part}`];
      for(const a of segment?.actions||[])if(a.action.type==='monitor.set'&&a.action.part===part&&a.frame<=frame)on=a.action.on;
      return on;};
    const count=c.countInFor(c.current,c.countFrom||0),counting=count.beats>0&&(c.status==='gap'||r.source<count.target*RATE);
    return {song,measures:r.measures,stretches:()=>settled?showStretches(r,timeOf):[],waiting:c.status==='gap',next:c.next?.songId??null,
      countIn:counting?count.clicks.map((k,i)=>({k:`${c.countRun}:${i}`,at:timeOf(k.at*RATE),accent:k.accent})):[],
      // under a count-in, a pickup bar's own beats would click over the count
      clickOn:(s,frame)=>!(counting&&frame<count.target*RATE)&&flagged('click',s,frame)!==false,
      cueFlags:(stretches,now)=>stretches.flatMap(s=>{
        const whenOf=frame=>s.at+(frame-s.from)/RATE/s.speed,start=flagged('cue',s,s.from)!==false;
        const flags=[{key:`cue-start:${s.cycle}`,at:Math.max(now+.02,whenOf(s.from)),on:start}];
        for(const a of segmentOf(s)?.actions||[])if(a.action.type==='monitor.set'&&a.action.part==='cue'&&a.frame>=s.from&&a.frame<s.to&&whenOf(a.frame)>now&&whenOf(a.frame)<=now+.4)flags.push({key:`cue-flag:${s.cycle}:${a.id}`,at:whenOf(a.frame),on:a.action.on});
        return flags;
      })};
  }
  // What each MIDI device was last sent while previewing. A jump or a click on a bar keeps it, so the Helix isn't sent a preset it's already on;
  // letting go of the preview (moving the playhead while paused, leaving the tab) and a new show forget it, so the next start sends everything.
  let midiSent={};
  /** The speed that plays a tempo where the music is now, for Set tempo: {percent} or {error}. */
  const speedForBpm=bpm=>speedForTempo(bpm,tempoAt(deps.practice.songTempo(),transport.getSnapshot().seconds));
  function makeController(){
    const visual=createVisualOut({timeOf:epochOf,post:message=>visuals.perform(message)});
    visuals.setPerformState(visual.current);controllerVisual=visual;
    const planned=createCommandOut({timeOf:epochOf,run:(action,{frame}={})=>{try{runCommand(action.command,action.params,{inShow:true,frame,controller:c,view,transport,practice:deps.practice,speedForBpm,visual:visualCtx,tapTempo:params=>tapNow(null,params)});view?.paint?.();}catch(error){showError(error);}}});
    const midi=createMidiBridge({api,timeOfPlayed:p=>(epochOf(p)-performance.timeOrigin)/1000,onLog:entry=>c?.note?.('midi',entry),known:midiSent});
    midi.calibrate().catch(()=>{});
    bridge=midi;
    const c=new ShowController({
      createSession:handlers=>createPathSession({token,...handlers}),
      loadEntry:entry=>loadEntry(api,entry),
      now:()=>performance.now()/1000,
      out:event=>{visual.event(event);midi.event(event);planned.event(event);},
      onChange:snapshot=>{if(c===controller)report(snapshot);},   // one that has been replaced or stopped says nothing more to the page
      onSong:id=>deps.showSong(id),
      power:{acquire:()=>api('/api/power/acquire',{holder:'show'}).then(r=>{c.check&&(c.check.keepAwake=r.awake);if(!r.awake)c.check?.notes.push('This computer may still go to sleep during the show: keeping it awake didn’t work.');}).catch(()=>{}),release:()=>api('/api/power/release',{holder:'show'}).catch(()=>{})},
    });
    c.epochNow=()=>Date.now();c.songCount=id=>songCount(deps.prefs,id);
    c.checkpoint={save:value=>deps.prefs.set('cb-show-running',JSON.stringify(value)),load:()=>{try{return JSON.parse(deps.prefs.get('cb-show-running','null'));}catch{return null;}},clear:()=>deps.prefs.set('cb-show-running','null')};
    return c;
  }
  /** What every view reads: the same values a practice stream would report. */
  function report(snapshot){
    const r=controller?.runner;if(!controller||!r)return;
    const clockDevice=controller.show?.midiClock?.device;
    if(clockDevice&&bridge){if(snapshot.status==='playing')bridge.clock(r,clockDevice);else if(['stopped','finished','error'].includes(snapshot.status))bridge.stopClock(clockDevice);}
    const now=snapshot.song,planned=r.withOverrides(r.plannedThrough(r.played)),m=controller.lastReport,mix=r.fadingMix(m?.heardPlayed??r.played)??mixFromState(planned,defaultMix());   // the faders move through a fade
    const leaving=r.pendingLoop?.type==='exit';   // pressed to leave: the loop stops showing at once, so the press is seen, though the pass plays out
    const looped=leaving?null:now?.loop||(r.current?.regionId?{start:r.current.start,end:r.current.end,kind:r.current.family}:null);
    const playing=snapshot.status==='playing';
    if(transport.performer!==controller){paintRunning();return;}   // not attached to the player (still getting ready): its place isn't the player's yet
    const visualMix=controller.show?.keepVisualsWhenMuted?{...mix,mutes:mix.mutes.map(()=>false),solos:mix.solos.map(()=>false)}:null;
    transport.performerReport({seconds:(now?.source??0)/RATE,playing,playIntent:RUNNING.includes(snapshot.status)&&snapshot.status!=='paused',buffering:snapshot.status==='buffering',
      loop:looped?{enabled:true,start:looped.start/RATE,end:looped.end/RATE,implicit:true,kind:looped.kind||'bars',left:r.loopShown?.()?.left??null}:{enabled:false,start:null,end:null,implicit:false},
      mix,visualMix,rate:r.rate,levels:playing&&Array.isArray(m?.levels)?m.levels:null,duration:(r.grid.frames)/RATE,ready:true});
    paintRunning();deps.onMonitorPlan?.(planned);notesChanged();
    if(snapshot.status==='finished')transport.ranOut=true;   // Play starts it over
    if(snapshot.status==='finished'||snapshot.status==='stopped'||snapshot.status==='error')release();
  }
  /** The notes (Note actions) of the arrangement playing now, for the chart: [{id,start (seconds),text,plan (its name)}], and the song they're for. */
  function planNotes(){
    const r=controller&&(previewing||showRunning())?controller.runner:null;if(!r)return null;
    const seen=new Set(),notes=[];
    for(const s of r.compiled?.segments||[])for(const a of s.actions||[])if(a.action?.type==='marker.text'&&a.action.text){
      const key=a.frame+'|'+a.action.text;if(seen.has(key))continue;seen.add(key);notes.push({id:'plan:'+key,start:a.frame/RATE,text:a.action.text,plan:r.performance?.name||'this arrangement'});
    }
    return {songId:controller.current?.songId??null,notes};
  }
  let notesKey='';
  function notesChanged(){const now=planNotes(),key=now?JSON.stringify(now):'';if(key!==notesKey){notesKey=key;deps.onPlanNotes?.();}}
  function release(){
    clearInterval(deviceTimer);
    if(!transport.performer)return;
    previewing=false;planKey=null;planVisual=null;
    transport.detachPerformer();visuals.setPerformState(null);paintRunning();deps.onMonitorPlan?.(null);notesKey='';deps.onPlanNotes?.();
  }
  const isRunning=()=>!!controller&&(RUNNING.includes(controller.status)||controller.status==='armed');

  async function armShow(showBody){
    await scenesLoaded;
    midiSent={};controller=makeController();
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
    controller.connections=connections;
    controller.status=controller.check.ready?'armed':'preparing';
    transport.attachPerformer(controller);
    {const mine=controller;mine.playPressed=()=>{if(controller!==mine)return;if(view)view.act('toggle');else if(mine.status==='armed')mine.start().catch(showError);else if(mine.status==='waiting')mine.nextSong();else mine.togglePlay();};}
    // a device unplugged during the show: say so, stop only if the show can't do without it; back again: it gets where things stand, not what it missed
    const running=controller,needed=connections.map(c=>({name:c.name,critical:c.critical}));
    const watch=createDeviceWatch({api,devices:()=>needed,onLost:(name,critical)=>running.deviceLost(name,critical),
      onBack:name=>{running.deviceBack(name);const r=running.runner;if(r)bridge?.chase(r.withOverrides(r.plannedThrough(r.played)),name).catch(()=>{});}});
    if(needed.length){clearInterval(deviceTimer);deviceTimer=setInterval(()=>{if(controller===running&&RUNNING.includes(running.status))watch.check();},4000);}
    return controller.check;
  }
  // ---- taught switches: they work anywhere, in a show or in practice
  const inShow=()=>!!controller&&transport.performer===controller;
  const visualCtx={
    scenes:()=>scenes,
    current:()=>(inShow()?controllerVisual?.current().state.scene:null)??deps.practice.currentVisual(),
    show(id,{override=true}={}){
      if(inShow()){if(override)controller.setLive('visual.scene',id);else controller.nudge('visual.scene',id);}
      else deps.practice.showVisual(id);
    },
    toggle(name){
      if(!inShow()){deps.practice.toggleVisual(name);return;}
      const state=controllerVisual?.current().state;
      controller.setLive(`visual.${name}`,!(state?.[name]??deps.practice.visualSwitch(name)));
    },
    open:()=>$('visualizer-window').click(),
  };
  /** A press from a taught switch. While MIDI setup is open it only lights up its row there, so you can test a switch without setting anything off. */
  function pressed(command,mapping){
    if(setupOpen)return;
    try{runCommand(command,mapping?.params,{inShow:inShow(),controller,view,transport,practice:deps.practice,speedForBpm,visual:visualCtx,tapTempo:params=>tapNow(mapping,params)});view?.paint?.();}catch(error){showError(error);}
  }
  let setupOpen=false,heard=null;
  const letGo=new Set();
  listenForInput({api,mappings:deps.mappings,onCommand:pressed,onEvent:(event,result)=>heard?.(event,result)});
  if(globalThis.__cbTestHooks)globalThis.__cbTestHooks.perform={controller:()=>controller,previewing:()=>previewing,transport};   // only when a test asks for it, before the page loads
  /** Every device a switch was taught on is opened at launch and again when it's plugged back in, unless you let go of it in MIDI setup. Opening sends nothing. */
  async function keepDevicesOpen(){
    const wanted=new Set(deps.mappings().map(m=>m.device));if(deps.tapDevice())wanted.add(deps.tapDevice());if(!wanted.size)return;
    let ports;try{ports=await api('/api/midi/ports');}catch{return;}
    if(!ports?.available)return;
    for(const name of wanted){
      if(letGo.has(name))continue;
      const input=ports.inputs.find(p=>p.name===name);
      if(input&&!input.open)await api('/api/midi/connect',{name}).catch(()=>{});
    }
  }
  keepDevicesOpen();setInterval(keepDevicesOpen,5000);
  const tempoTap=createTempoTap({api,device:()=>deps.tapDevice(),song:()=>deps.practice.songTempo(),onError:showError});
  transport.subscribe(snapshot=>tempoTap.tick(snapshot));
  /** Where a Virtual tap tempo goes: the device set in MIDI setup, or else the Helix the switch is on. */
  const tapNow=(mapping,params)=>{const name=deps.tapDevice()||(canTapTempo(mapping?.device)?mapping.device:null);return params?.mode==='bpm'?tempoTap.setBpm(name,params.bpm):tempoTap.follow(name,transport.getSnapshot());};

  // ---- pages
  async function openPrepare(){
    const song=deps.currentSong();
    if(!song){showError(Error('Open a song first, then choose Prepare.'));return;}
    let grid;try{grid=await loadSongGrid(api,song.id);}catch(error){showError(error);return;}
    await scenesLoaded;
    show('prepare',root=>mountPrepare(root,{api,songId:song.id,grid,scenes:()=>scenes,devices,showError,onClose:closePage,onHistory:()=>deps.onHistory?.(),onStepped:step=>deps.onStepped?.(step),currentMix:()=>transport.getSnapshot().mix,onMidiSetup:()=>midiSetup(),
      performSet:{name:()=>deps.setlists().find(l=>l.id===setlist.listId)?.name??null,run:performChosen},
      playhead:()=>transport.getSnapshot().seconds,playing:()=>transport.getSnapshot().playIntent,loopShown:()=>controller&&(previewing||showRunning())?controller.runner?.loopShown?.()??null:null,liveChanges:()=>previewing?controller?.runner?.overrides?.size??0:0,releaseLive:()=>{if(previewing)controller?.release({});},seek:seconds=>transport.seek(seconds)?.catch?.(showError),onPlanChange:planChanged}));
    planned={songId:song.id,grid};
    beforePrepare={songId:song.id,mix:transport.getSnapshot().mix,rate:transport.getSnapshot().rate};planKey=null;planShown=false;
    showPlanHere();
    transport.planPlay=seconds=>{if(!open?.plan?.())return false;playPlan(seconds,{countIn:true});return true;};   // Play itself, so it counts in
  }
  // ---- playing in Prepare: Play follows the arrangement, flags and all. It's a one-song show the page never mentions.
  let planned=null,previewWork=Promise.resolve(),previewTurn=0,planTimer=null;
  /** Start from here. The latest request wins. The player takes the new preview at once (it says Pause, so a second press pauses), and
   *  the old one stops at once; only getting the audio ready waits its turn, so two can never be going. */
  function playPlan(fromSeconds,{countIn=false}={}){
    const turn=++previewTurn;
    const mine=beginPreview(fromSeconds);if(!mine)return;
    previewWork=previewWork.then(()=>turn===previewTurn&&controller===mine&&kind==='prepare'?startPreview(mine,fromSeconds,{countIn}):null).catch(showError);
  }
  function beginPreview(fromSeconds){
    const performance=open?.plan?.(),{grid}=planned||{};if(kind!=='prepare'||!performance||!grid)return null;
    if(controller&&(previewing||RUNNING.includes(controller.status)))controller.stop();
    release();
    const mine=controller=makeController();
    // moving the playhead here is at once, as it is in practice: not at the next bar line, as in a show
    mine.navigate=frame=>{if(mine.status==='paused')letGoOfPlan(frame/RATE);else playPlan(frame/RATE);return null;};
    // Pause while it is still getting going: it never starts, and the playhead stays where you asked it to play from
    {const pause=mine.pause.bind(mine);mine.pause=()=>{if(['idle','armed','preparing'].includes(mine.status)){if(controller===mine)letGoOfPlan(fromSeconds);}else{previewTurn++;pause();}};}   // and a jump still queued to start is called off: Pause is the latest thing you asked for
    transport.attachPerformer(mine);previewing=true;transport.performerReport({playIntent:true,seconds:fromSeconds});
    return mine;
  }
  async function startPreview(mine,fromSeconds,{countIn=false}={}){
    const performance=open?.plan?.(),{songId,grid}=planned||{};if(!performance||!grid){letGoOfPlan(fromSeconds);return;}
    // Play on the Perform tab counts in with the arrangement's count-in, like a show; moving the playhead while it plays doesn't count in again
    const entry={id:'preview',songId,performanceId:null,transition:countIn?null:{kind:'immediate',seconds:0,countBars:0}};
    mine.loadEntry=async()=>({song:grid.song,performance,compiled:compilePerformance(performance,{measures:grid.measures,frames:grid.frames}),grid:{measures:grid.measures,frames:grid.frames},sections:grid.sections,manifest:grid.manifest,trim:grid.trim,baseMix:defaultMix()});
    const check=await controller.arm({id:'preview',name:'Preview',entries:[entry]},{});
    if(controller!==mine||check.stopped)return;   // let go of while it loaded
    if(!check.ready){letGoOfPlan(fromSeconds);showError(Error(check.blocking[0]));return;}
    // flags send, as in a show (a flag's own On switch is how to leave one out); the devices they use are opened first, as a show does: a message to a device that isn't open goes nowhere
    {
      const devices=new Set();for(const item of controller.loaded.values())for(const s of item.compiled?.segments||[])for(const a of s.actions||[])if(a.action.device)devices.add(a.action.device);
      for(const name of devices){const r=await api('/api/midi/connect',{name}).catch(()=>null);if(!r?.output)showError(Error(r?.error||`${name} isn’t connected, so its flags can’t be sent.`));}
    }
    if(controller!==mine)return;
    try{await controller.start({from:Math.round(fromSeconds*RATE)});}
    catch(error){if(controller===mine)letGoOfPlan(fromSeconds);throw error;}   // it couldn't start: the player lets go of it, rather than waiting on it
  }
  /** Back to no plan playing, with the playhead at `seconds`. */
  function letGoOfPlan(seconds){
    previewTurn++;midiSent={};   // a start still waiting its turn is called off too: it would play after you'd stopped
    if(previewing){controller?.stop();release();controller=null;}
    transport.seek(seconds)?.catch?.(showError);
  }
  /** The plan changed, or it's a different arrangement: what's playing follows it, and what's paused picks it up at the next Play. */
  function planChanged(){
    planVersion++;showPlanHere();
    clearTimeout(planTimer);
    planTimer=setTimeout(()=>{
      if(kind!=='prepare')return;
      const at=transport.getSnapshot().seconds,plan=open?.plan?.();
      if(previewing){
        const paused=controller.status==='paused';
        if(plan&&!paused)playPlan(at);
        else{letGoOfPlan(at);if(!paused)transport.play().catch(showError);}
      }
      else if(plan&&!transport.performer&&transport.getSnapshot().playIntent)playPlan(at);
    },400);
  }
  // ---- standing still in Prepare: the mixer, the speed and the visuals show what the plan has set where the playhead is, so a change can be checked without playing it
  let beforePrepare=null,planKey=null,planShown=false,planVersion=0,planVisual=null;
  function showPlanHere(){
    if(kind!=='prepare'||!planned||transport.performer)return;
    const s=transport.getSnapshot();
    if(s.songId!==planned.songId||s.playIntent)return;
    const plan=open?.plan?.();
    if(!plan){letGoOfPlanView({keepSong:true});return;}
    const key=`${s.seconds}|${planVersion}`;if(key===planKey)return;planKey=key;planShown=true;
    const compiled=compilePerformance(plan,{measures:planned.grid.measures,frames:planned.grid.frames}),frame=Math.round(s.seconds*RATE),state=plannedStateAt(compiled,frame);
    const mix=plannedMixAt(compiled,frame),rate=state.rate??100;
    if(JSON.stringify(mix)!==JSON.stringify(s.mix))transport.setMix(mix);
    if(rate!==s.rate)transport.setRate(rate).catch(showError);
    if(!planVisual){planVisual=createVisualOut({timeOf:()=>Date.now(),post:message=>visuals.perform(message)});visuals.setPerformState(planVisual.current);}
    planVisual.event({type:'state',atPlayed:0,state});deps.onMonitorPlan?.(state);
  }
  /** Back to the mix and speed you had before: leaving Prepare, or no plan to show. */
  function letGoOfPlanView({keepSong=false}={}){
    if(planVisual){planVisual.event({type:'cleanup'});visuals.setPerformState(null);planVisual=null;}
    if(planShown&&beforePrepare&&transport.getSnapshot().songId===beforePrepare.songId&&!transport.performer){transport.setMix(beforePrepare.mix);transport.setRate(beforePrepare.rate).catch(showError);}
    planShown=false;planKey=null;deps.onMonitorPlan?.(null);
    if(!keepSong)beforePrepare=null;
  }
  // another song chosen in the sidebar: Prepare moves to it once it's ready to play. One that isn't analyzed stays on the chart, which says what it needs.
  let followUntil=0;
  transport.subscribe(snapshot=>{
    if(!kind&&followUntil&&snapshot.ready&&snapshot.songId===deps.currentSong()?.id){
      const inTime=Date.now()<followUntil;followUntil=0;if(inTime)openPrepare();return;
    }
    if(kind!=='prepare'||!planned)return;
    if(snapshot.songId!==planned.songId&&!transport.performer){followUntil=Date.now()+8000;closePage();return;}
    showPlanHere();
  });

  function midiSetup(onClose){
    if(setupOpen)return;
    setupOpen=true;
    openMidiSetup({api,mappings:deps.mappings,saveMappings:deps.saveMappings,showError,scenes:()=>scenes,letGo,listen:fn=>{heard=fn;},tapDevice:deps.tapDevice,setTapDevice:deps.setTapDevice,tapNow:name=>tempoTap.follow(name,transport.getSnapshot()),tapSync:name=>tempoTap.sync(name,transport.getSnapshot()),
      onClose:()=>{setupOpen=false;heard=null;onClose?.();}});
  }
  /** A show that's running, or armed with its controls open: Perform goes back to it, and never starts another on top. */
  const showInHand=()=>!!controller&&!previewing&&(RUNNING.includes(controller.status)||(kind==='perform'&&['armed','preparing'].includes(controller.status)));
  /** A set list's Perform: get it ready to start, or if a show is already running, go back to that show. */
  async function performShow(body){
    if(showInHand()){openPerform();return;}
    try{
      await armShow(body);
      if(controller.entries[0])deps.showSong(controller.entries[0].songId);
      openPerform();
    }catch(error){showError(error);}
  }
  const setlist=createSetlistPanel({api,scenes:()=>scenes,setlists:deps.setlists,refresh:deps.refresh,redraw:()=>deps.redrawLibrary?.(),showError,onMidiSetup:midiSetup,onPerform:performShow,
    entryLength:async entry=>{const item=await loadEntry(api,entry);return {segments:item.compiled.segments,measures:item.grid?.measures,countBars:item.performance?.countBars??songCount(deps.prefs,entry.songId),music:pathSeconds(item.compiled.segments).music,live:item.compiled.requiresLiveControl};}});
  function performChosen(){
    if(showInHand()){openPerform();return;}
    if(setlist.listId)setlist.perform();else showError(Error('Choose a set list in the sidebar first, then Perform.'));
  }
  function openPerform(){
    if(!controller){performChosen();return;}
    deps.onShow?.();   // the show controls are opening for a show: it needs the sound window for OBS (desktop app)
    show('perform',root=>{
      view=mountPerform(root,{controller,onClose:closePage,chordAt:()=>deps.chordNow(),catalog:deps.songs,
        onShows:()=>closePage(),setHost:()=>deps.setHost?.(),onReleaseSet:()=>{},onError:showError,
        onAgain:async()=>{const body=controller.show;release();try{await armShow(body);openPerform();}catch(error){showError(error);}},
        fullscreen:()=>{const api=desktopWindow();if(api)api.toggle_fullscreen();else if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen().catch(()=>{});},
        openVisualizer:()=>$('visualizer-window').click(),
        copyObsAddress:deps.copyObsAddress||null,
        visualizerOpen:()=>visuals.listening,
        audioSeconds:()=>(controller?.lastReport?.queuedFrames??0)/RATE});
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
  document.addEventListener('keydown',event=>{
    if(document.querySelector('dialog[open]'))return;
    if(handleKey(event))return;
    if(kind==='prepare')open?.keydown?.(event);
    if(kind&&!event.defaultPrevented)keepFromHiddenPages(event);
  },true);
  // The chart is still there, hidden under these pages. Its letter keys must not change it unseen. L, R, Y and C mean what they always do.
  function keepFromHiddenPages(event){
    if(event.ctrlKey||event.metaKey||event.altKey||String(event.key).length!==1)return;
    const t=event.target;if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||'')))return;
    if(/^[a-z]$/i.test(event.key)&&!/^[lryc]$/i.test(event.key))event.stopPropagation();
  }
  window.addEventListener('beforeunload',event=>{if(controller&&RUNNING.includes(controller.status)&&!previewing){event.preventDefault();event.returnValue='';}});

  return {
    /** On the Perform tab with an arrangement open: its count-in, for the slider beside the Click fader. Changing it is a change to the arrangement, saved with it. */
    countSource(){
      const p=kind==='prepare'?open?.performance:null;if(!p||!open.change)return null;
      return {get:()=>[0,1,2].includes(open.performance?.countBars)?open.performance.countBars:songCount(deps.prefs,open.performance.songId),set:bars=>open.change({...structuredClone(open.performance),countBars:bars})};
    },
    monitorSource,isRunning,closePage,openMidiSetup:()=>midiSetup(),setlist,showRunning,
    /** The Perform tab: this song's plan, or back to the show if there's one in hand. */
    openTab(){if(showInHand()){if(kind!=='perform')openPerform();return;}if(kind!=='prepare')openPrepare();},
    leavePrepare(){if(kind==='prepare')closePage();},
    /** Leave the show controls for another tab. A running show plays on; come back through Perform. */
    leavePerform(){if(kind==='perform')closePage();},
    /** What each song shows under the show controls, as planned in Set list settings: 'chart' (the default) or 'abc' (the lead sheet). */
    showView:()=>controller&&!previewing&&controller.show?.view==='abc'?'abc':'chart',
    /** The last show's run log, moment by moment, to paste into a message if something went wrong; null if there's been no show. */
    runLog:()=>controller&&!previewing?JSON.stringify({show:controller.log,song:controller.runner?.log||[]}):null,
    /** While the show controls are open, the sidebar's song list shows the running set. */
    holdsList:()=>kind==='perform',
    get controller(){return controller;},
    get page(){return kind;},
    /** The Perform tab's undo history, for the top bar's Undo, Redo and History while it's open; null on other pages. */
    get history(){return kind==='prepare'?open?.history??null:null;},
    /** The song the running show is on, or null. Prepare playing its plan isn't a show. */
    planNotes,
    ownsSong:()=>controller&&!previewing&&RUNNING.includes(controller.status)?controller.current?.songId??null:null,
    /** A song was chosen while a show runs: the show goes to it. */
    goToSong(id){controller.goToSong(id).then(()=>view?.paint?.()).catch(showError);},
    /** Another song was chosen while Prepare was playing its plan: that playback ends, as it does for any song you leave. */
    endPreview(){previewTurn++;midiSent={};if(previewing){controller?.stop();release();controller=null;}},
  };
}
