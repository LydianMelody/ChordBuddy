// A visualizer: follows the player over the visual bridge and draws the chosen visualization, every display frame.
// Visualizations are files in web/visualizations/ (one per look, found automatically: drop a file in and it appears on the toolbar;
// names starting with _ are templates and drafts, left out). They draw the world; the chord and the lyrics are drawn on top by
// visual-hud.js in their own bands, so nothing covers them. A visualization that fails to load or throws while drawing is shown as
// broken, with its error, and the others keep working. Mounted by visualizer.html (pop-out window) and the main page's full-screen view.
//
// A visualization module's default export: {id, name, order (toolbar position, default 100), hud (default true),
//   create() -> {draw(g, frame, env), resize?(w, h), dispose?()}}.
// env: {w, h, dt (wall seconds since the last frame), wall (wall seconds), calm, lyrics, zones (hudZones), song (the built scene),
//       events: {hits: {role: [strength…]} (new drum and instrument hits this frame), beat (a new beat: {bar, beat, downbeat}) or null,
//       chordChanged, sectionChanged}, status, fps}
// Everything a scene shows must follow song time or wall time, never a fixed-length animation, so every scene runs as long as the song.
import {createVisualReceiver} from './visual-bridge.js';
import {SceneClock} from './visual-clock.js';
import {buildScene,sampleFrame,withFeatures} from './visual-scene.js';
import {setKeySpelling} from './spelling.js';
import {hudZones,drawChordHud,drawLyricHud} from './visual-hud.js';
import {mountMixerDrawer} from './visual-mixer.js';

const SETTINGS='cb-visualizer';
const MAX_PIXELS=2560*1440;                     // a 4K screen gets a 1440p picture, gently upscaled, so every scene keeps a smooth frame rate
// MIDI documents by file name: the vocal melody, the instrumental melody and the combined melody
const MIDI_NAMES=[[/(^|\/)melody_vocal\.mid$/,'vocal'],[/(^|\/)melody_instrumental\.mid$/,'instrumental'],[/(^|\/)melody\.mid$/,'melody']];

export function midiName(file){for(const [pattern,name] of MIDI_NAMES)if(pattern.test(file))return name;return null;}

// Every visualization in web/visualizations, sorted for the toolbar, and the files that could not be used (with why). list(): the files,
// as names or {file, version}; load(file, version): the module. Both are replaceable for tests. The version (from the file's time and
// size) is part of the module's address, so a file that was changed is loaded again instead of coming from the browser's cache.
async function listFolder(){
  const r=await fetch('/visualizations/index.json',{cache:'no-store'});if(!r.ok)throw Error('Could not list the visualizations');
  const body=await r.json();return (body.files||[]).map(file=>({file,version:body.versions?.[file]||''}));
}
export async function loadVisualizations({
  list=listFolder,
  load=(file,version)=>import('./visualizations/'+encodeURIComponent(file)+(version?'?v='+encodeURIComponent(version):'')),
}={}){
  const scenes=[],failed=[];
  for(const entry of await list()){
    const {file,version=''}=typeof entry==='string'?{file:entry}:entry;
    try{
      const scene=(await load(file,version))?.default;
      if(!scene||typeof scene.id!=='string'||!scene.id||typeof scene.name!=='string'||typeof scene.create!=='function')
        throw Error('It needs a default export with id, name and create()');
      if(scenes.some(s=>s.id===scene.id))throw Error(`Another visualization already uses the id "${scene.id}"`);
      scenes.push({...scene,file,version});
    }catch(error){failed.push({file,version,error:error?.message||String(error)});}
  }
  scenes.sort((a,b)=>(a.order??100)-(b.order??100)||a.name.localeCompare(b.name));
  return {scenes,failed};
}

function loadSettings(){
  const fallback={scene:'abstract',lyrics:true,calm:false,fps:false};
  try{return {...fallback,...JSON.parse(localStorage.getItem(SETTINGS)||'{}')};}catch{return fallback;}
}
function saveSettings(value){try{localStorage.setItem(SETTINGS,JSON.stringify(value));}catch{}}

async function getJson(path,token){
  const response=await fetch(path,{headers:{'X-ChordBuddy-Token':token}});
  if(!response.ok)throw Error(`${path}: ${response.status}`);
  return response.json();
}

// What changed between two frames: new hits on each track, a new beat, a new chord or section. Nothing while paused, and nothing across
// a seek (a jump would otherwise fire every hit in between at once).
export function frameEvents(previous,frame,song){
  const events={hits:{},beat:null,chordChanged:false,sectionChanged:false};
  if(!previous||frame.time<=previous.time||frame.time-previous.time>0.3)return events;
  for(const [role,track] of Object.entries(frame.tracks)){
    const before=previous.tracks[role]?.hitIndex??-1,list=song.features?.tracks[role]?.hits||[];
    if(track.hitIndex>before&&track.hitIndex-before<=8&&track.gain>0)events.hits[role]=list.slice(before+1,track.hitIndex+1).map(hit=>hit.strength);
  }
  if(frame.beat.bar!==null&&(frame.beat.beat!==previous.beat.beat||frame.beat.bar!==previous.beat.bar))
    events.beat={bar:frame.beat.bar,beat:frame.beat.beat,downbeat:frame.beat.beat===1};
  events.chordChanged=frame.chord.index!==previous.chord.index&&frame.chord.label!==null;
  events.sectionChanged=frame.section.index!==previous.section.index&&previous.section.index!==-1;
  return events;
}

export function mountVisualizer(container){
  const canvas=document.createElement('canvas');canvas.className='visualizer-canvas';container.append(canvas);
  const g=canvas.getContext('2d'),clock=new SceneClock(),settings=loadSettings();
  // the bundled fonts (FONTS in visual-hud.js): a canvas only uses a web font once it is loaded, so load them up front
  for(const face of ['400 16px "Bricolage Grotesque"','800 16px "Bricolage Grotesque"','400 16px "Space Mono"','700 16px "Space Mono"','400 16px "Courier Prime"','700 16px "Courier Prime"'])
    document.fonts?.load?.(face).catch(()=>{});
  let mixer=null,song=null,songKey=null,mix=null,status='Waiting for Chord Buddy… start playback in the main window.',raf=0,disposed=false;
  let frames=0,fpsAt=performance.now(),fps=0,lastWall=null,previous=null,active=null,activeId=null,activeDefinition=null,size=[0,0];
  let scenes=[],failed=[];const broken=new Map();   // visualizations, the files that failed to load, and ones that threw (id -> message)

  // ---- the song ----
  async function loadSong(m){
    const key=JSON.stringify([m.songId,m.runId,m.revision,m.key,m.lyricGuess]);if(key===songKey)return;songKey=key;
    if(!m.songId){song=null;status='No song is open in Chord Buddy.';return;}
    setKeySpelling(m.key||'');
    const base={content:m.content,music:m.music,title:m.title,key:m.key,lyricGuess:!!m.lyricGuess};
    song=buildScene(base);status='';previous=null;
    const midi={};
    await Promise.all((m.midiDocs||[]).map(async doc=>{
      const name=midiName(doc.name);if(!name)return;
      try{midi[name]=(await getJson('/api/document/'+encodeURIComponent(doc.id),m.token)).content?.notes||[];}catch{}
    }));
    if(songKey!==key||disposed)return;
    song=buildScene({...base,midi});previous=null;
    if(!m.runId)return;                                // not playable yet: chords, lyrics and MIDI only
    try{
      const features=await getJson('/api/visual-features/'+encodeURIComponent(m.runId),m.token);
      if(songKey===key&&!disposed){song=withFeatures(song,features);previous=null;}
    }catch{if(songKey===key)status='Sound data is not available for this song yet.';}
  }
  const receiver=createVisualReceiver({
    onScene:m=>{loadSong(m).catch(()=>{status='Could not load this song.';});},
    onClock:m=>{clock.report(m,m.at);mix=m.mix;mixer?.setMix(m.mix);},
  });

  // ---- the controls: scene, lyrics, calm; they hide when the mouse rests ----
  const toolbar=document.createElement('div');toolbar.className='visualizer-toolbar';
  const button=(label,title,onclick)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.title=title;b.onclick=onclick;return b;};
  let sceneButtons=[];
  const lyricsButton=button('Lyrics','Show the lyrics (Y)',()=>set({lyrics:!settings.lyrics}));
  const calmButton=button('Calm','Calm: no shaking or flashes (C)',()=>set({calm:!settings.calm}));
  const mixerButton=button('Mixer','Slide out the mixer (M)',()=>toggleMixer());
  const group=document.createElement('div');group.className='visualizer-scenes';
  toolbar.append(group,lyricsButton,calmButton,mixerButton);container.append(toolbar);
  mixer=mountMixerDrawer(container,{send:value=>receiver.setMix(value)});
  if(mix)mixer.setMix(mix);
  function toggleMixer(value){mixer.toggle(value);mixerButton.setAttribute('aria-pressed',String(mixer.open));}
  function paintControls(){
    scenes.forEach((s,i)=>{sceneButtons[i].setAttribute('aria-pressed',String(s.id===current()?.id));sceneButtons[i].classList.toggle('broken',broken.has(s.id));});
    lyricsButton.setAttribute('aria-pressed',String(settings.lyrics));calmButton.setAttribute('aria-pressed',String(settings.calm));
    mixerButton.setAttribute('aria-pressed',String(!!mixer?.open));
  }
  function set(change){Object.assign(settings,change);saveSettings(settings);paintControls();}
  function choose(id){if(scenes.some(s=>s.id===id)){broken.delete(id);if(activeId===id){try{active?.dispose?.();}catch{}active=null;activeId=null;}set({scene:id});}}
  function current(){return scenes.find(s=>s.id===settings.scene)||scenes[0]||null;}
  function showScenes(){
    sceneButtons=scenes.map((s,i)=>button(s.name,`${s.name} (${i+1})`,()=>choose(s.id)));
    const problems=failed.map(f=>{const b=button('⚠ '+f.file.replace(/[.]js$/,''),`${f.file} could not be loaded: ${f.error}`,()=>{});b.className='visualizer-failed';return b;});
    group.replaceChildren(...sceneButtons,...problems);paintControls();
  }
  // The folder is read again every few seconds and whenever the window comes back into focus: a file dropped in appears, a deleted one
  // goes (the chosen look falls back to the first), and a changed one is loaded fresh and restarted. Nothing is redone if nothing changed.
  let listing=null,listingNow=null;
  function refreshScenes(){
    if(disposed||listingNow)return listingNow;
    listingNow=loadVisualizations().then(result=>{
      if(disposed)return;
      const signature=JSON.stringify([result.scenes.map(s=>[s.file,s.version,s.id]),result.failed.map(f=>[f.file,f.version,f.error])]);
      if(signature===listing)return;
      listing=signature;({scenes,failed}=result);broken.clear();
      for(const f of failed)console.error(`Visualization ${f.file}:`,f.error);
      showScenes();
    }).catch(error=>{if(!scenes.length)status='Could not load the visualizations: '+error.message;}).finally(()=>{listingNow=null;});
    return listingNow;
  }
  refreshScenes();
  const rescan=setInterval(()=>{if(container.ownerDocument.visibilityState!=='hidden')refreshScenes();},4000);
  const onFocus=()=>refreshScenes();container.ownerDocument.defaultView?.addEventListener('focus',onFocus);
  paintControls();
  let idleTimer=0;
  const wake=()=>{toolbar.classList.remove('idle');container.classList.remove('idle');clearTimeout(idleTimer);
    idleTimer=setTimeout(()=>{toolbar.classList.add('idle');container.classList.add('idle');},2500);};
  container.addEventListener('pointermove',wake);wake();
  const keys=event=>{
    if(event.target?.closest?.('input,textarea,[contenteditable="true"]')||event.ctrlKey||event.metaKey||event.altKey)return;
    const n=Number(event.key);
    if(n>=1&&n<=scenes.length)choose(scenes[n-1].id);
    else if(event.key==='y'||event.key==='Y')set({lyrics:!settings.lyrics});      // (L loops four bars, as in the main window)
    else if(event.key==='c'||event.key==='C')set({calm:!settings.calm});
    else if(event.key==='p'||event.key==='P')set({fps:!settings.fps});       // frame rate readout, to check smoothness
    else if(event.key==='m'||event.key==='M')toggleMixer();
    else return;
    event.preventDefault();event.stopPropagation();wake();       // over the main page, its own shortcuts must not fire too
  };
  container.ownerDocument.addEventListener('keydown',keys,true);

  // ---- drawing ----
  function resize(){
    const w=container.clientWidth,h=container.clientHeight,ratio=Math.min(window.devicePixelRatio||1,Math.sqrt(MAX_PIXELS/Math.max(1,w*h)));
    if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    g.setTransform(ratio,0,0,ratio,0,0);
    if(size[0]!==w||size[1]!==h){size=[w,h];active?.resize?.(w,h);}
    return [w,h];
  }
  function sceneFor(definition){
    if(activeDefinition===definition&&active)return active;       // a file that changed is a new definition: it starts again
    try{active?.dispose?.();}catch{}
    active=null;activeId=definition.id;activeDefinition=definition;
    active=definition.create();active.resize?.(size[0],size[1]);
    return active;
  }
  // a visualization that failed: say so plainly, keep the chord and lyrics going, and point to the others
  function drawBroken(definition,w,h){
    g.fillStyle='#14111a';g.fillRect(0,0,w,h);g.textAlign='center';g.textBaseline='middle';
    g.fillStyle='#ffb4a8';g.font='700 18px system-ui';g.fillText(`“${definition.name}” stopped with an error`,w/2,h*0.45);
    g.fillStyle='#b8b4c8';g.font='500 14px system-ui';g.fillText(String(broken.get(definition.id)).slice(0,160),w/2,h*0.45+28);
    g.fillText(`The other visualizations still work (keys 1–${scenes.length}). Choosing this one again retries it.`,w/2,h*0.45+52);
  }
  function draw(now){
    if(disposed)return;raf=requestAnimationFrame(draw);
    frames++;if(now-fpsAt>=1000){fps=frames*1000/(now-fpsAt);frames=0;fpsAt=now;}
    const dt=lastWall===null?1/60:Math.min(0.1,(now-lastWall)/1000);lastWall=now;
    const [w,h]=resize();
    if(!song){g.fillStyle='#0d0e14';g.fillRect(0,0,w,h);g.textAlign='center';g.textBaseline='middle';g.fillStyle='#e9e6dc';g.font='500 18px system-ui';g.fillText(status,w/2,h/2);return;}
    const frame=sampleFrame(song,clock.time(now),{playing:clock.playing,rate:clock.rate,mix});
    const definition=current();
    if(!definition){g.fillStyle='#0d0e14';g.fillRect(0,0,w,h);g.textAlign='center';g.textBaseline='middle';g.fillStyle='#e9e6dc';g.font='500 18px system-ui';
      g.fillText(scenes.length||!failed.length?'Loading the visualizations…':'No visualization could be loaded.',w/2,h/2);return;}
    const env={w,h,dt,wall:now/1000,calm:settings.calm,lyrics:settings.lyrics,zones:hudZones(w,h,settings.lyrics),song,
      events:frameEvents(previous,frame,song),status,fps};
    previous=frame;if(frames%3===0)mixer.setLevels(frame);
    g.save();
    if(!broken.has(definition.id)){
      try{sceneFor(definition).draw(g,frame,env);}
      catch(error){broken.set(definition.id,error?.message||String(error));console.error(`Visualization "${definition.name}" failed:`,error);paintControls();}
    }
    g.restore();
    if(broken.has(definition.id)){g.save();drawBroken(definition,w,h);g.restore();}
    if(definition.hud!==false){
      g.save();drawChordHud(g,frame,w,h,{calm:settings.calm});g.restore();
      if(settings.lyrics){g.save();drawLyricHud(g,frame,w,h);g.restore();}
    }
    if(settings.fps){g.font='600 12px ui-monospace,monospace';g.textAlign='right';g.textBaseline='bottom';g.fillStyle='rgba(255,255,255,.7)';
      g.fillText(`${Math.round(fps)} fps · ${canvas.width}×${canvas.height}`,w-10,h-8);}
  }
  raf=requestAnimationFrame(draw);
  return {
    toolbar,
    command:action=>receiver.command(action),           // a playback key, for the player (a pop-out window has no player of its own)
    dispose(){disposed=true;cancelAnimationFrame(raf);clearTimeout(idleTimer);clearInterval(rescan);container.ownerDocument.defaultView?.removeEventListener('focus',onFocus);receiver.dispose();try{active?.dispose?.();}catch{}mixer.dispose();
      container.ownerDocument.removeEventListener('keydown',keys,true);container.removeEventListener('pointermove',wake);canvas.remove();toolbar.remove();},
  };
}
