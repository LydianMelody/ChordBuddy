// How the player and a visualizer talk: one same-origin BroadcastChannel, so a pop-out window, a full-screen view on the main page, or
// several at once all follow the same player. The main page publishes; each visualizer asks for the current state when it opens.
//   hello  (visualizer -> player)  "I just opened": the player answers with the scene and the clock
//   scene  (player -> visualizers) the song: its chart, MIDI document ids, the separation run for stem features, and the API token
//   clock  (player -> visualizers) position, play state, speed, loop and mixer, stamped with the moment it was true
//   mix    (visualizer -> player)  a new mixer setting from a visualizer's own mixer drawer: {gains, mutes, solos, master}
//   command (visualizer -> player) a playback key pressed in a pop-out visualizer: {action} (see playback-keys.js)
//   setup  (player -> visualizers) how the open song is shown (visual-setup.js): {songId, pinned (the song's own look, or null),
//          usual (the look and switches used when a song has none), showing (a look chosen for now over the pinned one, or null)}; kept by the player with the library, so it lasts between launches
//   pin    (visualizer -> player)  pin the look now showing to a song, or unpin it: {songId, setup or null}
//   usual  (visualizer -> player)  the usual look or a switch changed: {usual}
//   show   (visualizer -> player)  a look chosen for now on a song with a pinned one: {songId, scene}; every visualizer then shows it
//   patch  (visualizer -> player)  save a patch from the patch bay (visual-patch.js): {songId (a song's own patch) or null (the usual one),
//          visual, patch or null (remove it)}; the setup message then carries patches: {usual:{visual:patch}, song:{visual:patch}}
//   editor (visualizer -> player) open the Advanced Visuals Editor in the main window (a visualizer's Edit visuals button)
//   perform (player -> visualizers) a running show's timed actions (performance-visuals.js), stamped in epoch ms; a visualizer opening late gets the state in force
// A visualizer in another browser (an OBS Browser Source, at the address from Visualizer → Stream to OBS) gets the same messages through the
// server instead (playerRelay, viewerRelay below); it only listens.
// Clock stamps are epoch milliseconds (performance.timeOrigin + performance.now()), so each window converts them to its own clock.
export const CHANNEL='chordbuddy-visuals';

// The desktop app's own window controls (pywebview), or null in a browser: {toggle_fullscreen, is_fullscreen, open_visualizer}, each
// returning a Promise. A browser uses the page's own full screen and window.open instead.
export function desktopWindow(){
  const api=typeof window!=='undefined'?window.pywebview?.api:null;
  return api&&typeof api.toggle_fullscreen==='function'?api:null;
}
const epoch=()=>performance.timeOrigin+performance.now();

// The subset of the player's state a visualizer needs. snapshot: the transport's getSnapshot(); rate there is a percentage.
export function clockMessage(snapshot,at=epoch()){
  return {type:'clock',songId:snapshot.songId,seconds:snapshot.seconds,playing:!!snapshot.playing,rate:(snapshot.rate||100)/100,
    duration:snapshot.duration,loop:snapshot.loop||null,mix:snapshot.visualMix||snapshot.mix||null,ready:!!snapshot.ready,at};
}

/**
 * On the main page. open(): () => BroadcastChannel-like. onListen(): called when a visualizer opens, before it is answered, so the page can
 * publish a fresh scene (nothing is published while nobody listens). onMix(mix): a visualizer changed the mix (the page applies and
 * validates it). Returns {clock(snapshot), scene(value), dispose()}; scene(null) clears it.
 */
export function createVisualPublisher({open=()=>new BroadcastChannel(CHANNEL),onListen=()=>{},onMix=()=>{},onCommand=()=>{},onPin=()=>{},onUsual=()=>{},onShow=()=>{},onPatch=()=>{},onEditor=()=>{}}={}){
  let lastScene=null,lastClock=null,lastSetup=null,listening=false,performState=null;
  const channel=open();
  channel.onmessage=event=>{
    const m=event.data;
    if(m?.type==='mix'&&m.mix&&typeof m.mix==='object'){onMix(m.mix);return;}
    if(m?.type==='command'&&m.action&&typeof m.action==='object'){onCommand(m.action);return;}
    if(m?.type==='pin'&&typeof m.songId==='string'&&m.songId){onPin(m.songId,m.setup&&typeof m.setup==='object'?m.setup:null);return;}
    if(m?.type==='usual'&&m.usual&&typeof m.usual==='object'){onUsual(m.usual);return;}
    if(m?.type==='show'&&typeof m.songId==='string'&&typeof m.scene==='string'){onShow(m.songId,m.scene);return;}
    if(m?.type==='patch'&&typeof m.visual==='string'&&(m.songId===null||typeof m.songId==='string')){onPatch(m.songId,m.visual,m.patch&&typeof m.patch==='object'?m.patch:null);return;}
    if(m?.type==='editor'){onEditor();return;}
    if(m?.type!=='hello')return;
    listening=true;
    const before=lastScene,setupBefore=lastSetup;onListen();
    if(lastScene&&lastScene===before)channel.postMessage(lastScene);    // unchanged, so onListen did not send it: answer with it
    if(lastSetup&&lastSetup===setupBefore)channel.postMessage(lastSetup);
    if(lastClock)channel.postMessage(lastClock);                       // stamped with when it was true, so it is still exact
    if(performState)channel.postMessage({type:'perform',...performState()});
  };
  return {
    clock(snapshot){
      lastClock=clockMessage(snapshot);
      if(listening)channel.postMessage(lastClock);
    },
    // value: {songId, runId, title, key, content, music, midiDocs:[{id,name}], userMidi:[{id,name,mtime,settings}] (your own MIDI files,
    // midi-user.js), token, lyricGuess}; resent only when something in it changed
    scene(value){
      const message=value?{type:'scene',...value}:{type:'scene',songId:null};
      const signature=JSON.stringify([message.songId,message.runId,message.key,message.title,message.revision,message.midiDocs,message.userMidi,message.lyricGuess]);
      if(lastScene&&lastScene.signature===signature)return;
      lastScene={...message,signature};
      if(listening)channel.postMessage(lastScene);
    },
    // value: {songId, pinned, usual, showing, patches}; resent only when it changed
    setup(value){
      const message={type:'setup',songId:value?.songId||null,pinned:value?.pinned||null,usual:value?.usual||null,showing:value?.showing||null,
        patches:value?.patches||{usual:{},song:{}}};
      const signature=JSON.stringify([message.songId,message.pinned,message.usual,message.showing,message.patches]);
      if(lastSetup&&lastSetup.signature===signature)return;
      lastSetup={...message,signature};
      if(listening)channel.postMessage(lastSetup);
    },
    // A show's timed actions. current(): what a visualizer opening late needs (the state in force; never effects that have already happened).
    perform(message){if(listening)channel.postMessage({type:'perform',...message});},
    setPerformState(current){performState=current;},
    get listening(){return listening;},
    dispose(){channel.close();},
  };
}

// ---- Visualizers in another browser (an OBS Browser Source), which a BroadcastChannel cannot reach: the server relays (visual_relay.py).
// A viewer only listens; the server says hello for it when it connects. The player relays only while someone is listening there, one
// request at a time, and a newer clock replaces one still waiting (each is stamped, so the latest is all a viewer needs). Clocks go out
// when something changes (play, pause, a seek, the speed, the loop, the mix) and otherwise twice a second: the viewer's clock runs on
// by itself in between (visual-clock.js), and a request for every report (about 20 a second) would leave thousands of closed
// connections waiting on the computer.
const STEADY=500;                               // ms between clocks while nothing changes
const JUMP=0.05;                                // seconds off from where the last clock said it would be: a seek

// Whether a clock must go out now, given the last one sent.
export function clockNews(last,m){
  if(!last)return true;
  if(m.playing!==last.playing||m.rate!==last.rate||m.songId!==last.songId||m.ready!==last.ready||m.duration!==last.duration
    ||JSON.stringify(m.loop)!==JSON.stringify(last.loop)||JSON.stringify(m.mix)!==JSON.stringify(last.mix))return true;
  const expected=last.playing?last.seconds+(m.at-last.at)/1000*last.rate:last.seconds;
  return Math.abs(m.seconds-expected)>JUMP||m.at-last.at>=STEADY;
}

/** Several BroadcastChannel-like channels as one: a message goes out on all of them, and one from any of them is received. */
export function joinChannels(...channels){
  const joined={onmessage:null,postMessage(m){for(const c of channels)c.postMessage(m);},close(){for(const c of channels)c.close();}};
  for(const c of channels)c.onmessage=event=>joined.onmessage?.(event);
  return joined;
}

/** On the player page: the relay as a BroadcastChannel-like channel. */
export function playerRelay(token,{fetch=globalThis.fetch,EventSource=globalThis.EventSource}={}){
  let active=false,sending=false,waiting=[],closed=false,lastClock=null;
  const events=new EventSource('/api/visual-relay/player?token='+encodeURIComponent(token));
  const channel={onmessage:null,
    postMessage(m){
      if(!active||closed||!m||!['scene','clock','setup','perform'].includes(m.type))return;
      if(m.type==='clock'){if(!clockNews(lastClock,m))return;lastClock=m;waiting=waiting.filter(w=>w.type!=='clock');}
      waiting.push(m);flush();
    },
    close(){closed=true;events.close();},
  };
  async function flush(){
    if(sending||!waiting.length)return;
    sending=true;const messages=waiting;waiting=[];
    try{
      const r=await fetch('/api/visual-relay/send',{method:'POST',headers:{'Content-Type':'application/json','X-ChordBuddy-Token':token},body:JSON.stringify({messages})});
      if(r.ok&&(await r.json()).viewers===0){active=false;waiting=[];}    // nobody there any more: quiet until the next hello
    }catch{/* the next message tries again */}
    finally{sending=false;if(active)flush();}
  }
  events.onmessage=event=>{
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m?.type!=='hello')return;
    active=true;lastClock=null;channel.onmessage?.({data:m});      // a new viewer gets the clock at once
  };
  return channel;
}

/** In a visualizer in another browser: the relay as a BroadcastChannel-like channel that only listens. key: from its address (?stream=).
 * onLink(connected): the connection to Chord Buddy came up, or was lost (the app was closed). The browser keeps trying the same address
 * by itself, so it comes back up when the app runs again; the server then says hello for it and the player sends the song. */
export function viewerRelay(key,{EventSource=globalThis.EventSource,onLink=()=>{}}={}){
  const events=new EventSource('/visual-stream?key='+encodeURIComponent(key));
  events.onopen=()=>onLink(true);events.onerror=()=>onLink(false);
  const channel={onmessage:null,postMessage(){},close(){events.close();}};
  events.onmessage=event=>{let m;try{m=JSON.parse(event.data);}catch{return;}channel.onmessage?.({data:m});};
  return channel;
}

/** In a visualizer. onScene(message), onClock(message with `at` converted to this page's performance.now() clock). */
export function createVisualReceiver({onScene,onClock,onSetup=()=>{},onPerform=()=>{},open=()=>new BroadcastChannel(CHANNEL)}){
  const channel=open();
  channel.onmessage=event=>{
    const m=event.data;
    if(m?.type==='scene')onScene(m);
    else if(m?.type==='clock')onClock({...m,at:m.at-performance.timeOrigin});
    else if(m?.type==='setup')onSetup(m);
    else if(m?.type==='perform')onPerform(m);
  };
  channel.postMessage({type:'hello'});
  return {hello(){channel.postMessage({type:'hello'});},setMix(mix){channel.postMessage({type:'mix',mix});},command(action){channel.postMessage({type:'command',action});},
    pin(songId,setup){channel.postMessage({type:'pin',songId,setup:setup||null});},usual(value){channel.postMessage({type:'usual',usual:value});},
    show(songId,scene){channel.postMessage({type:'show',songId,scene});},
    patch(songId,visual,value){channel.postMessage({type:'patch',songId:songId||null,visual,patch:value||null});},
    editor(){channel.postMessage({type:'editor'});},
    dispose(){channel.close();}};
}
