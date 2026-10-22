// A visualizer: follows the player over the visual bridge and draws the chosen scene, every display frame.
// Scenes (scene-*.js) draw the world; the chord and the lyrics are drawn on top by visual-hud.js in their own bands, so nothing covers
// them. Mounted by visualizer.html (pop-out window) and by the main page's full-screen view.
//
// A scene module: {id, name, hud (default true), create() -> {draw(g, frame, env), resize?(w, h), dispose?()}}.
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
import cozy from './scene-cozy.js';
import runner from './scene-runner.js';
import abstract from './scene-abstract.js';
import diagnostic from './scene-diagnostic.js';

export const SCENES=[cozy,runner,abstract,diagnostic];
const SETTINGS='cb-visualizer';
const MAX_PIXELS=2560*1440;                     // a 4K screen gets a 1440p picture, gently upscaled, so every scene keeps a smooth frame rate
// MIDI documents by file name: the vocal melody, the instrumental melody and the combined melody
const MIDI_NAMES=[[/(^|\/)melody_vocal\.mid$/,'vocal'],[/(^|\/)melody_instrumental\.mid$/,'instrumental'],[/(^|\/)melody\.mid$/,'melody']];

export function midiName(file){for(const [pattern,name] of MIDI_NAMES)if(pattern.test(file))return name;return null;}

function loadSettings(){
  const fallback={scene:SCENES[0].id,lyrics:true,calm:false,fps:false};
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
  let mixer=null,song=null,songKey=null,mix=null,status='Waiting for Chord Buddy… start playback in the main window.',raf=0,disposed=false;
  let frames=0,fpsAt=performance.now(),fps=0,lastWall=null,previous=null,active=null,activeId=null,size=[0,0];

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
    if(!m.runId){status='Split the stems to let each instrument move the scene.';return;}
    try{
      const features=await getJson('/api/visual-features/'+encodeURIComponent(m.runId),m.token);
      if(songKey===key&&!disposed){song=withFeatures(song,features);previous=null;}
    }catch{if(songKey===key)status='Stem data is not available for this song yet.';}
  }
  const receiver=createVisualReceiver({
    onScene:m=>{loadSong(m).catch(()=>{status='Could not load this song.';});},
    onClock:m=>{clock.report(m,m.at);mix=m.mix;mixer?.setMix(m.mix);},
  });

  // ---- the controls: scene, lyrics, calm; they hide when the mouse rests ----
  const toolbar=document.createElement('div');toolbar.className='visualizer-toolbar';
  const button=(label,title,onclick)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.title=title;b.onclick=onclick;return b;};
  const sceneButtons=SCENES.map((s,i)=>button(s.name,`${s.name} (${i+1})`,()=>choose(s.id)));
  const lyricsButton=button('Lyrics','Show the lyrics (L)',()=>set({lyrics:!settings.lyrics}));
  const calmButton=button('Calm','Calm: no shaking or flashes (C)',()=>set({calm:!settings.calm}));
  const mixerButton=button('Mixer','Slide out the mixer (M)',()=>toggleMixer());
  const group=document.createElement('div');group.className='visualizer-scenes';group.append(...sceneButtons);
  toolbar.append(group,lyricsButton,calmButton,mixerButton);container.append(toolbar);
  mixer=mountMixerDrawer(container,{send:value=>receiver.setMix(value)});
  if(mix)mixer.setMix(mix);
  function toggleMixer(value){mixer.toggle(value);mixerButton.setAttribute('aria-pressed',String(mixer.open));}
  function paintControls(){
    SCENES.forEach((s,i)=>sceneButtons[i].setAttribute('aria-pressed',String(s.id===settings.scene)));
    lyricsButton.setAttribute('aria-pressed',String(settings.lyrics));calmButton.setAttribute('aria-pressed',String(settings.calm));
    mixerButton.setAttribute('aria-pressed',String(!!mixer?.open));
  }
  function set(change){Object.assign(settings,change);saveSettings(settings);paintControls();}
  function choose(id){if(SCENES.some(s=>s.id===id))set({scene:id});}
  paintControls();
  let idleTimer=0;
  const wake=()=>{toolbar.classList.remove('idle');container.classList.remove('idle');clearTimeout(idleTimer);
    idleTimer=setTimeout(()=>{toolbar.classList.add('idle');container.classList.add('idle');},2500);};
  container.addEventListener('pointermove',wake);wake();
  const keys=event=>{
    if(event.target?.closest?.('input,textarea,[contenteditable="true"]')||event.ctrlKey||event.metaKey||event.altKey)return;
    const n=Number(event.key);
    if(n>=1&&n<=SCENES.length)choose(SCENES[n-1].id);
    else if(event.key==='l'||event.key==='L')set({lyrics:!settings.lyrics});
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
  function sceneFor(id){
    if(activeId===id&&active)return active;
    active?.dispose?.();activeId=id;
    active=(SCENES.find(s=>s.id===id)||SCENES[0]).create();active.resize?.(size[0],size[1]);
    return active;
  }
  function draw(now){
    if(disposed)return;raf=requestAnimationFrame(draw);
    frames++;if(now-fpsAt>=1000){fps=frames*1000/(now-fpsAt);frames=0;fpsAt=now;}
    const dt=lastWall===null?1/60:Math.min(0.1,(now-lastWall)/1000);lastWall=now;
    const [w,h]=resize();
    if(!song){g.fillStyle='#0d0e14';g.fillRect(0,0,w,h);g.textAlign='center';g.textBaseline='middle';g.fillStyle='#e9e6dc';g.font='500 18px system-ui';g.fillText(status,w/2,h/2);return;}
    const frame=sampleFrame(song,clock.time(now),{playing:clock.playing,rate:clock.rate,mix});
    const definition=SCENES.find(s=>s.id===settings.scene)||SCENES[0],scene=sceneFor(definition.id);
    const env={w,h,dt,wall:now/1000,calm:settings.calm,lyrics:settings.lyrics,zones:hudZones(w,h,settings.lyrics),song,
      events:frameEvents(previous,frame,song),status,fps};
    previous=frame;if(frames%3===0)mixer.setLevels(frame);
    g.save();scene.draw(g,frame,env);g.restore();
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
    dispose(){disposed=true;cancelAnimationFrame(raf);clearTimeout(idleTimer);receiver.dispose();active?.dispose?.();mixer.dispose();
      container.ownerDocument.removeEventListener('keydown',keys,true);container.removeEventListener('pointermove',wake);canvas.remove();toolbar.remove();},
  };
}
