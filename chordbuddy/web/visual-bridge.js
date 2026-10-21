// How the player and a visualizer talk: one same-origin BroadcastChannel, so a pop-out window, a full-screen view on the main page, or
// several at once all follow the same player. The main page publishes; each visualizer asks for the current state when it opens.
//   hello  (visualizer -> player)  "I just opened": the player answers with the scene and the clock
//   scene  (player -> visualizers) the song: its chart, MIDI document ids, the separation run for stem features, and the API token
//   clock  (player -> visualizers) position, play state, speed, loop and mixer, stamped with the moment it was true
// Clock stamps are epoch milliseconds (performance.timeOrigin + performance.now()), so each window converts them to its own clock.
export const CHANNEL='chordbuddy-visuals';
const epoch=()=>performance.timeOrigin+performance.now();

// The subset of the player's state a visualizer needs. snapshot: the transport's getSnapshot(); rate there is a percentage.
export function clockMessage(snapshot,at=epoch()){
  return {type:'clock',songId:snapshot.songId,seconds:snapshot.seconds,playing:!!snapshot.playing,rate:(snapshot.rate||100)/100,
    duration:snapshot.duration,loop:snapshot.loop||null,mix:snapshot.mix||null,ready:!!snapshot.ready,at};
}

/** On the main page. open(): () => BroadcastChannel-like. Returns {clock(snapshot), scene(value), dispose()}; scene(null) clears it. */
export function createVisualPublisher({open=()=>new BroadcastChannel(CHANNEL)}={}){
  let channel=null,lastScene=null,lastClock=null,listening=false;
  const ensure=()=>{
    if(channel)return channel;
    channel=open();
    channel.onmessage=event=>{
      if(event.data?.type!=='hello')return;
      listening=true;
      if(lastScene)channel.postMessage(lastScene);
      if(lastClock)channel.postMessage(lastClock);                     // stamped with when it was true, so it is still exact
    };
    return channel;
  };
  ensure();
  return {
    clock(snapshot){
      lastClock=clockMessage(snapshot);
      if(listening)channel.postMessage(lastClock);
    },
    // value: {songId, runId, title, key, content, music, midiDocs:[{id,name}], token}; resent only when something in it changed
    scene(value){
      const message=value?{type:'scene',...value}:{type:'scene',songId:null};
      const signature=JSON.stringify([message.songId,message.runId,message.key,message.title,message.revision,message.midiDocs]);
      if(lastScene&&lastScene.signature===signature)return;
      lastScene={...message,signature};
      if(listening)channel.postMessage(lastScene);
    },
    get listening(){return listening;},
    dispose(){channel?.close();channel=null;},
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
  return {hello(){channel.postMessage({type:'hello'});},dispose(){channel.close();}};
}
