// Only one visualizer draws at a time, so the graphics card never draws the same look twice (a shader scene costs as much as a game).
// The main window decides which one, from what the visualizers say over the visual bridge (visual-bridge.js). Pure: no DOM, so it can be
// tested; app.js feeds it messages and sends what it decides.
//   here  (visualizer -> player) {id, kind}: a visualizer is open, said when it opens and every couple of seconds after. kind:
//         'window' (its own window), 'overlay' (full screen on the main page), 'editor' (the Advanced Visuals Editor's preview) or
//         'controls' (the Stream controls window: the picker and mixer, never a picture)
//   take  (visualizer -> player) {id}: draw here instead (the editor's "Show the preview here")
//   bye   (visualizer -> player) {id}: it closed
//   stage (player -> visualizers) {drawer, close}: drawer is the id of the one that draws, 'obs' while a Browser Source in OBS is drawing,
//         or null; close lists the ids that must close
// The rules: the newest opened (or the one that asked to take over) draws, and the older ones on screen (a window, a full-screen view)
// close; the editor's preview never closes, it waits. While OBS draws, nothing here does: OBS keeps the look, and every visualizer on
// screen shows its controls only. A Browser Source that is hidden in OBS stops drawing and says so, and then the newest one here draws.
export const BEAT=2000;                 // ms between a visualizer's "here"s
const GONE=3*BEAT+500;                  // heard nothing for this long: it is gone (closed without a word, or crashed)
const KINDS=new Set(['window','overlay','editor','controls']);
const SCREEN=new Set(['window','overlay']);

export function createStage({post=()=>{},now=()=>Date.now()}={}){
  const open=new Map();                 // id -> {kind, order (newer is larger), heard}
  const closed=new Set();               // told to close: a late "here" from one of them must not bring it back as the newest
  let order=0,obs={connected:0,drawing:0},last='';
  function newest(){let top=null;for(const [id,v] of open)if(v.kind!=='controls'&&(!top||v.order>top.order))top={id,...v};return top;}
  function decide(){
    const top=newest();
    const close=top?[...open].filter(([id,v])=>SCREEN.has(v.kind)&&id!==top.id).map(([id])=>id):[];
    for(const id of close){open.delete(id);closed.add(id);}
    const drawer=obs.drawing>0?'obs':top?.id||null;
    const message={type:'stage',drawer,close};
    const signature=JSON.stringify([drawer,close]);
    // said again whenever it changes, and to anyone new (they need to hear it), but not on every heartbeat
    if(signature!==last||close.length){last=signature;post(message);}
    return message;
  }
  const valid=id=>typeof id==='string'&&id.length>0&&id.length<=64;
  return {
    /** A visualizer's here, take or bye. Returns true when it was one of those. */
    receive(m){
      if(!m||!valid(m.id))return false;
      if(m.type==='here'){
        if(!KINDS.has(m.kind))return false;
        if(closed.has(m.id))return true;
        const known=open.get(m.id);
        if(known){known.heard=now();return true;}
        open.set(m.id,{kind:m.kind,order:++order,heard:now()});last='';decide();return true;   // a newcomer hears the decision
      }
      if(m.type==='take'){const v=open.get(m.id);if(v&&v.kind!=='controls'){v.order=++order;v.heard=now();decide();}return true;}
      if(m.type==='bye'){if(open.delete(m.id))decide();return true;}
      return false;
    },
    /** How many Browser Sources in OBS are connected and drawing (from the server: visual_relay.py). */
    obs(status){
      const next={connected:Math.max(0,Number(status?.connected)||0),drawing:Math.max(0,Number(status?.drawing)||0)};
      if(next.connected===obs.connected&&next.drawing===obs.drawing)return;
      obs=next;decide();
    },
    /** Forget visualizers not heard from for a while. Called every BEAT. */
    tick(){let gone=false;for(const [id,v] of open)if(now()-v.heard>GONE){open.delete(id);gone=true;}if(gone)decide();},
    get obsState(){return {...obs};},
    get drawer(){return obs.drawing>0?'obs':newest()?.id||null;},
    kinds(){return [...open.values()].map(v=>v.kind);},
  };
}
