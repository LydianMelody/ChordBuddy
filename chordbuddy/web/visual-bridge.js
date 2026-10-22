// How the player and a visualizer talk: one same-origin BroadcastChannel, so a pop-out window, a full-screen view on the main page, or
// several at once all follow the same player. The main page publishes; each visualizer asks for the current state when it opens.
//   hello  (visualizer -> player)  "I just opened": the player answers with the scene and the clock
//   scene  (player -> visualizers) the song: its chart, MIDI document ids, the separation run for stem features, and the API token
//   clock  (player -> visualizers) position, play state, speed, loop and mixer, stamped with the moment it was true
//   mix    (visualizer -> player)  a new mixer setting from a visualizer's own mixer drawer: {gains, mutes, solos, master}
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
    duration:snapshot.duration,loop:snapshot.loop||null,mix:snapshot.mix||null,ready:!!snapshot.ready,at};
}

/**
 * On the main page. open(): () => BroadcastChannel-like. onListen(): called when a visualizer opens, before it is answered, so the page can
 * publish a fresh scene (nothing is published while nobody listens). onMix(mix): a visualizer changed the mix (the page applies and
 * validates it). Returns {clock(snapshot), scene(value), dispose()}; scene(null) clears it.
 */
export function createVisualPublisher({open=()=>new BroadcastChannel(CHANNEL),onListen=()=>{},onMix=()=>{}}={}){
  let lastScene=null,lastClock=null,listening=false;
  const channel=open();
  channel.onmessage=event=>{
    if(event.data?.type==='mix'&&event.data.mix&&typeof event.data.mix==='object'){onMix(event.data.mix);return;}
    if(event.data?.type!=='hello')return;
    listening=true;
    const before=lastScene;onListen();
    if(lastScene&&lastScene===before)channel.postMessage(lastScene);    // unchanged, so onListen did not send it: answer with it
    if(lastClock)channel.postMessage(lastClock);                       // stamped with when it was true, so it is still exact
  };
  return {
    clock(snapshot){
      lastClock=clockMessage(snapshot);
      if(listening)channel.postMessage(lastClock);
    },
    // value: {songId, runId, title, key, content, music, midiDocs:[{id,name}], token, lyricGuess}; resent only when something in it changed
    scene(value){
      const message=value?{type:'scene',...value}:{type:'scene',songId:null};
      const signature=JSON.stringify([message.songId,message.runId,message.key,message.title,message.revision,message.midiDocs,message.lyricGuess]);
      if(lastScene&&lastScene.signature===signature)return;
      lastScene={...message,signature};
      if(listening)channel.postMessage(lastScene);
    },
    get listening(){return listening;},
    dispose(){channel.close();},
  };
}

/** In a visualizer. onScene(message), onClock(message with `at` converted to this page's performance.now() clock). */
export function createVisualReceiver({onScene,onClock,open=()=>new BroadcastChannel(CHANNEL)}){
  const channel=open();
  channel.onmessage=event=>{
    const m=event.data;
    if(m?.type==='scene')onScene(m);
    else if(m?.type==='clock')onClock({...m,at:m.at-performance.timeOrigin});
  };
  channel.postMessage({type:'hello'});
  return {hello(){channel.postMessage({type:'hello'});},setMix(mix){channel.postMessage({type:'mix',mix});},dispose(){channel.close();}};
}
