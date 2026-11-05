// A visualizer: follows the player over the visual bridge and draws the chosen visualization, every display frame.
// Visualizations are files in web/visualizations/ (the ones that come with Chord Buddy) and in the My Visuals folder in the app's root
// (your own; an update never touches it). One file per look, found automatically: drop a file in and it appears on the toolbar; names
// starting with _ are templates and drafts, left out. A file in My Visuals with the id of a built-in one takes its place. They draw the world; the chord and the lyrics are drawn on top by
// visual-hud.js in their own bands, so nothing covers them. A visualization that fails to load or throws while drawing is shown as
// broken, with its error, and the others keep working. Mounted by visualizer.html (pop-out window) and the main page's full-screen view.
//
// A visualization module's default export: {id, name, order (toolbar position, default 100), hud (default true),
//   skin (optional: restyles the picker and the mixer to match; visual-skin.js), create() -> {draw(g, frame, env), resize?(w, h), dispose?()}}.
//   inputs (optional, see visual-patch.js): {key:{label, type, default, help}}, the things the patch bay can wire sounds and signals to.
// env: {w, h, dt (wall seconds since the last frame), wall (wall seconds), calm, lyrics, zones (hudZones), song (the built scene),
//       inputs (each declared input's value this frame, from the patch in use; {} for a visualization without inputs),
//       events: {hits: {role: [strength…]} (new drum and instrument hits this frame), beat (a new beat: {bar, beat, downbeat}) or null,
//       chordChanged, sectionChanged, loop: {started, ended, wrapped} (the loop was turned on or changed, turned off, or went back to
//       its start)}, status, fps}
// frame.loop (visual-scene.js): the loop being repeated or null, with its kind, progress, bars and pass (which time around).
// Everything a scene shows must follow song time or wall time, never a fixed-length animation, so every scene runs as long as the song.
import {createVisualReceiver} from './visual-bridge.js';
import {SceneClock} from './visual-clock.js';
import {buildScene,sampleFrame,withFeatures} from './visual-scene.js';
import {loadSongFiles,songParts} from './midi-user.js';
import {effectiveMeasures} from './chart-layout.js';
import {setKeySpelling} from './spelling.js';
import {hudZones,drawChordHud,drawLyricHud} from './visual-hud.js';
import {mountMixerDrawer} from './visual-mixer.js';
import {pickScene,panelPlace,ID_TEXT} from './visual-setup.js';
import {VisualCues} from './performance-visuals.js';
import {placePanel,draggable} from './visual-layout.js';
import {readSkin,applySkin,browserCheck,skinStylesheet,loadSkinSheet} from './visual-skin.js';
import {Patcher,readInputs,choosePatch,sourceCatalog,catalogMap,sourceValue,sourceRange} from './visual-patch.js';
import {mountPatchBay} from './visual-patchbay.js';

const SETTINGS='cb-visualizer';
const USUAL=['scene','lyrics','calm','picker','mixer','patchbay'];   // what the usual setup keeps (visual-setup.js), saved by the main window
const MAX_PIXELS=2560*1440;                     // a 4K screen gets a 1440p picture, gently upscaled, so every scene keeps a smooth frame rate
// MIDI documents by file name: the vocal melody, the instrumental melody and the combined melody
const MIDI_NAMES=[[/(^|\/)melody_vocal\.mid$/,'vocal'],[/(^|\/)melody_instrumental\.mid$/,'instrumental'],[/(^|\/)melody\.mid$/,'melody']];

export function midiName(file){for(const [pattern,name] of MIDI_NAMES)if(pattern.test(file))return name;return null;}

// Every visualization, sorted for the toolbar, and the files that could not be used (with why). list(): the files, as names or
// {file, version, mine}; load(file, version, mine): the module. Both are replaceable for tests. The version (from the file's time and
// size) is part of the module's address, so a file that was changed is loaded again instead of coming from the browser's cache.
// Yours are listed first, so one with a built-in's id wins and the built-in is left out (quietly: that is how you replace one).
async function listFolder(){
  const r=await fetch('/visualizations/index.json',{cache:'no-store'});if(!r.ok)throw Error('Could not list the visualizations');
  const body=await r.json();
  return [...(body.mine||[]).map(file=>({file,version:body.mine_versions?.[file]||'',mine:true})),
    ...(body.files||[]).map(file=>({file,version:body.versions?.[file]||'',mine:false}))];
}
export async function loadVisualizations({
  list=listFolder,
  load=(file,version,mine)=>import((mine?'./my-visuals/':'./visualizations/')+encodeURIComponent(file)+(version?'?v='+encodeURIComponent(version):'')),
}={}){
  const scenes=[],failed=[];
  for(const entry of await list()){
    const {file,version='',mine=false}=typeof entry==='string'?{file:entry}:entry;
    try{
      const scene=(await load(file,version,mine))?.default;
      if(!scene||typeof scene.id!=='string'||!scene.id||typeof scene.name!=='string'||typeof scene.create!=='function')
        throw Error('It needs a default export with id, name and create()');
      if(!ID_TEXT.test(scene.id))throw Error(`Its id "${scene.id}" must be up to 40 letters, digits, spaces, _ . or -, starting with a letter or digit`);
      const twin=scenes.find(s=>s.id===scene.id);
      if(twin&&twin.mine&&!mine)continue;                // your own version of a built-in one
      if(twin)throw Error(`Another visualization already uses the id "${scene.id}"`);
      scenes.push({...scene,file,version,mine});
    }catch(error){failed.push({file,version,mine,error:error?.message||String(error)});}
  }
  scenes.sort((a,b)=>(a.order??100)-(b.order??100)||a.name.localeCompare(b.name));
  return {scenes,failed};
}

function loadSettings(){
  const fallback={scene:'abstract',lyrics:true,calm:false,fps:false,plain:false};
  try{return {...fallback,...JSON.parse(localStorage.getItem(SETTINGS)||'{}')};}catch{return fallback;}
}
function saveSettings(value){try{localStorage.setItem(SETTINGS,JSON.stringify(value));}catch{}}

const userFiles=new Map();                     // your MIDI files, read once per version (id:mtime)
// The index of the chart's bar 1 among the measures (the first bar shown), as the scene numbers them.
function firstBarOf(measures,scene){const one=scene?.bars?.find(b=>b.number===1);return Math.max(0,one?measures.findIndex(m=>Math.abs(m.start-one.start)<1e-6):0);}
async function getJson(path,token){
  const response=await fetch(path,{headers:{'X-ChordBuddy-Token':token}});
  if(!response.ok)throw Error(`${path}: ${response.status}`);
  return response.json();
}

// What changed between two frames: new hits on each track, a new beat, a new chord or section. Nothing while paused, and nothing across
// a seek (a jump would otherwise fire every hit in between at once).
// The loop's own events are worked out first, since a wrap is a jump back; frame.loop.pass carries on from the previous frame.
export function frameEvents(previous,frame,song){
  const events={hits:{},beat:null,chordChanged:false,sectionChanged:false,loop:loopEvents(previous,frame)};
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

// A jump back to the loop's start is a wrap when, going round the loop, the song moved on only a little (the end of the loop and then its
// start add up to at most this); any other jump back is a seek. Frame-rate proof: a window drawing once a second still sees every wrap.
const WRAP=1.5;
function loopEvents(previous,frame){
  const now=frame.loop,before=previous?.loop||null;
  const same=!!now&&!!before&&Math.abs(now.start-before.start)<1e-3&&Math.abs(now.end-before.end)<1e-3;
  const wrapped=same&&frame.playing&&frame.time<previous.time&&Math.max(0,now.end-previous.time)+Math.max(0,frame.time-now.start)<=WRAP;
  if(now)now.pass=same?before.pass+(wrapped?1:0):1;
  return {started:!!now&&!same,ended:!now&&!!before,wrapped};
}

// options: {open (the bridge channel; the BroadcastChannel by default), stream (an OBS Browser Source: no controls at all, nothing saved here,
// and it follows the main window's look rather than choosing one), editor (the Advanced Visuals Editor, visual-patchbay.js: {root, onPopOut,
// onClose}; the editor fills root and this visualizer draws in its preview corner, with no controls of its own)}
export function mountVisualizer(container,{open,stream=false,editor=null}={}){
  let bay=null;
  if(editor){
    // the patch bay (visual-patchbay.js; bayShown: what it was last given, so it is only told when something changed): a change shows at
    // once here, and is saved by the main window, which tells every visualizer
    bay=mountPatchBay(editor.root,{onSave:(song,visual,value)=>{
      const place=song?patches.song:patches.usual,next={...place};if(value)next[visual]=value;else delete next[visual];
      patches=song?{...patches,song:next}:{...patches,usual:next};bayShown=null;receiver.patch(song,visual,value);},
      stored:(song,visual)=>(song?patches.song:patches.usual)?.[visual]??null,
      onChoose:id=>choose(id),onPopOut:editor.onPopOut,onClose:editor.onClose});
    container=bay.preview;container.classList.add('visualizer-stage','in-editor');
  }
  const canvas=document.createElement('canvas');canvas.className='visualizer-canvas';container.append(canvas);
  const g=canvas.getContext('2d'),clock=new SceneClock(),settings=stream?{...loadSettings(),fps:false,plain:false}:loadSettings();
  if(stream)container.classList.add('streaming');
  // the bundled fonts (FONTS in visual-hud.js): a canvas only uses a web font once it is loaded, so load them up front
  for(const face of ['400 16px "Bricolage Grotesque"','800 16px "Bricolage Grotesque"','400 16px "Space Mono"','700 16px "Space Mono"','400 16px "Courier Prime"','700 16px "Courier Prime"'])
    document.fonts?.load?.(face).catch(()=>{});
  let mixer=null,song=null,songKey=null,mix=null,status='Waiting for Chord Buddy… start playback in the main window.',raf=0,disposed=false;
  let frames=0,fpsAt=performance.now(),fps=0,lastWall=null,previous=null,active=null,activeId=null,activeDefinition=null,size=[0,0];
  let scenes=[],failed=[];const broken=new Map();   // visualizations, the files that failed to load, and ones that threw (id -> message)
  // which look to draw (visual-setup.js): the open song's own (pinned), else the usual one (settings.scene); a click in the picker shows
  // another one for now (showing) and, for a song with nothing pinned, makes it the usual one
  let songId=null,pinned=null,showing=null;
  // the patch bay (visual-patch.js): saved patches for the open song's visualizations, {usual:{visualId:patch}, song:{visualId:patch}}
  let patches={usual:{},song:{}},patcher=new Patcher(),patcherFor=null,catalogFor=null,catalog=null,catalogById=null,bayShown=null;const bayHeld={};
  const inputsOf=new WeakMap();
  const inputsFor=definition=>{if(!inputsOf.has(definition))inputsOf.set(definition,readInputs(definition));return inputsOf.get(definition);};
  const patchFor=definition=>{
    // a show can choose which saved connections are in use; left alone, a song's own win over the usual ones
    const chosen=cues.state.patch;
    return choosePatch(inputsFor(definition),{song:chosen==='usual'||chosen==='default'?null:patches.song?.[definition.id],usual:chosen==='default'?null:patches.usual?.[definition.id]});
  };
  function sources(){if(catalogFor!==song){catalogFor=song;catalog=sourceCatalog(song);catalogById=catalogMap(catalog);}return catalog;}
  function followSong(id){if(id!==songId){songId=id||null;showing=null;pinned=null;}}

  // ---- the song ----
  async function loadSong(m){
    const key=JSON.stringify([m.songId,m.runId,m.revision,m.key,m.lyricGuess,m.userMidi]);if(key===songKey)return;songKey=key;
    if(!m.songId){song=null;status='No song is open in Chord Buddy.';return;}
    setKeySpelling(m.key||'');
    const base={content:m.content,music:m.music,title:m.title,key:m.key,lyricGuess:!!m.lyricGuess};
    song=buildScene(base);status='';previous=null;
    const midi={};
    await Promise.all((m.midiDocs||[]).map(async doc=>{
      const name=midiName(doc.name);if(!name)return;
      try{midi[name]=(await getJson('/api/document/'+encodeURIComponent(doc.id),m.token)).content?.notes||[];}catch{}
    }));
    // your own MIDI files: parts that replace the model's melodies, and extras (midi-user.js)
    let user=[],extras=[];
    if(m.userMidi?.length&&m.music?.measures?.length)try{
      const files=await loadSongFiles(m.songId,m.userMidi,path=>fetch(path,{headers:{'X-ChordBuddy-Token':m.token}}).then(r=>{if(!r.ok)throw Error(r.status);return r.arrayBuffer();}),userFiles);
      const measures=effectiveMeasures(m.music,m.content?.layout||{});
      const parts=songParts(files,measures,{duration:m.content?.duration||m.music?.duration||0,firstBar:firstBarOf(measures,song)});
      for(const [name,notes] of Object.entries(parts.replace)){midi[name]=notes.map(n=>({...n,mine:true}));user.push(name);}
      // the combined melody follows a replaced part (your notes in it keep their dynamics; the model's are measured as before)
      if(user.length&&midi.melody)midi.melody=[...(midi.vocal||[]),...(midi.instrumental||[])];
      extras=parts.extras;
    }catch{/* the model's MIDI is used instead */}
    if(songKey!==key||disposed)return;
    song=buildScene({...base,midi,user,extras});previous=null;
    if(!m.runId)return;                                // not playable yet: chords, lyrics and MIDI only
    try{
      const features=await getJson('/api/visual-features/'+encodeURIComponent(m.runId),m.token);
      if(songKey===key&&!disposed){song=withFeatures(song,features);previous=null;}
    }catch{if(songKey===key)status='Sound data is not available for this song yet.';}
  }
  const receiver=createVisualReceiver({...(open?{open}:{}),
    onScene:m=>{followSong(m.songId);loadSong(m).catch(()=>{status='Could not load this song.';});},
    onClock:m=>{clock.report(m,m.at);mix=m.mix;mixer?.setMix(m.mix);},
    // the song's pinned setup and the usual look, kept by the main window with the library (so they last between launches)
    onPerform:m=>cues.receive(m),
    onSetup:m=>{followSong(m.songId);pinned=m.pinned||null;showing=m.showing||null;   // the player keeps the look chosen for now, so every visualizer agrees
      patches={usual:m.patches?.usual||{},song:m.patches?.song||{}};bayShown=null;
      if(m.usual){for(const key of USUAL)if(key in m.usual)settings[key]=m.usual[key];if(!stream)saveSettings(settings);}
      paintControls();arrange();},
  });

  // ---- the controls: scene, lyrics, calm; they hide when the mouse rests ----
  const toolbar=document.createElement('div');toolbar.className='visualizer-toolbar';
  const button=(label,title,onclick)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.title=title;b.onclick=onclick;return b;};
  let sceneButtons=[];
  const lyricsButton=button('Lyrics','Show the lyrics (Y)',()=>set({lyrics:!settings.lyrics}));
  const calmButton=button('Calm','Calm mode: gentler motion, with no shaking, flashing or sudden bursts of light (C)',()=>set({calm:!settings.calm}));
  const mixerButton=button('Mixer','Slide out the mixer (M)',()=>toggleMixer());
  // the patch bay lives in the main window (the Advanced Visuals Editor), where there is room for it
  const patchButton=button('Edit visuals','Open the Advanced Visuals Editor in the main window: choose which sounds and signals move which parts of this visualization',()=>receiver.editor());
  const pinButton=button('Pin','',()=>togglePin());pinButton.className='visualizer-pin';
  // stable names for a skin's stylesheet (visual-skin.js)
  for(const [b,name] of [[pinButton,'pin'],[lyricsButton,'lyrics'],[calmButton,'calm'],[mixerButton,'mixer'],[patchButton,'patch']])b.dataset.control=name;
  const group=document.createElement('div');group.className='visualizer-scenes';
  // the grip along the top: drag it to move the picker anywhere on the screen (the ridges of a cassette's hinge, as on the set lists)
  const grip=document.createElement('div');grip.className='visualizer-grip';grip.title='Drag to move these controls';grip.setAttribute('aria-hidden','true');
  toolbar.append(grip,group,pinButton,lyricsButton,calmButton,mixerButton,patchButton);container.append(toolbar);
  // in the editor the mixer sits under the preview (muting a stem there quiets what it moves too: visual-patch.js)
  mixer=mountMixerDrawer(bay?bay.mixerSlot:container,{send:value=>receiver.setMix(value),docked:!!bay});
  if(mix)mixer.setMix(mix);
  function toggleMixer(value){mixer.toggle(value);mixerButton.setAttribute('aria-pressed',String(mixer.open));arrange();}
  // ---- where the picker and the mixer float (visual-layout.js): the song's own places when it has a pin, else the usual ones ----
  // A drag saves the new place to the pin when the song has one (so the whole look comes back with the song), else as the usual place.
  const SPOTS={picker:{x:0,y:0},mixer:{x:1,y:0}};   // the built-in spots: picker top left, mixer top right
  function arrange(){
    if(!mixer)return;
    placePanel(toolbar,container,panelPlace('picker',{pinned,usual:settings})||SPOTS.picker);
    if(!mixer.element.hidden&&!mixer.docked)placePanel(mixer.element,container,panelPlace('mixer',{pinned,usual:settings})||SPOTS.mixer);
    bay?.redraw();
  }
  function moved(panel,place){
    if(pinned){pinned={...pinned,[panel]:place};receiver.pin(songId,pinned);}
    else set({[panel]:place});
  }
  const undrag=[draggable(toolbar,grip,container,place=>moved('picker',place)),...(mixer.docked?[]:[draggable(mixer.element,mixer.handle,container,place=>moved('mixer',place))])];
  function paintControls(){
    scenes.forEach((s,i)=>{sceneButtons[i].setAttribute('aria-pressed',String(s.id===current()?.id));sceneButtons[i].classList.toggle('broken',broken.has(s.id));sceneButtons[i].classList.toggle('pinned',pinned?.scene===s.id);});
    lyricsButton.setAttribute('aria-pressed',String(settings.lyrics));calmButton.setAttribute('aria-pressed',String(settings.calm));
    mixerButton.setAttribute('aria-pressed',String(!!mixer?.open));bay?.setScenes(scenes,current()?.id);
    const look=current(),on=!!pinned&&look?.id===pinned.scene;
    pinButton.hidden=!songId;pinButton.setAttribute('aria-pressed',String(on));pinButton.textContent=on?'Pinned':'Pin';
    pinButton.title=on?`${look.name} is pinned to this song. Click to unpin it (the song then uses your usual look).`
      :`Pin ${look?.name||'this look'} to this song: it comes back every time the song opens.`;
  }
  function set(change){Object.assign(settings,change);saveSettings(settings);receiver.usual(Object.fromEntries(USUAL.filter(k=>k in settings).map(k=>[k,settings[k]])));paintControls();}
  function choose(id){
    if(!scenes.some(s=>s.id===id))return;
    broken.delete(id);if(activeId===id){try{active?.dispose?.();}catch{}active=null;activeId=null;}
    showing=id;if(pinned){receiver.show(songId,id);paintControls();}else set({scene:id});   // every other visualizer follows (OBS too)
  }
  // a running show's timed actions (performance-visuals.js). Times arrive in epoch ms; a chosen look or switch outranks everything until the show ends.
  const cues=new VisualCues();
  const epochOf=now=>performance.timeOrigin+now;
  function current(){return pickScene(scenes,{showing:cues.state.scene||showing,pinned,usual:{scene:settings.scene}});}
  // pin the look now showing to the open song, or unpin it (the main window saves it; it answers with the new setup)
  function togglePin(){
    const look=current();if(!songId||!look)return;
    // pinning keeps the panels where they are now too, so the song comes back exactly as it looks
    const places=Object.fromEntries(['picker','mixer'].map(panel=>[panel,panelPlace(panel,{pinned,usual:settings})]).filter(([,place])=>place));
    pinned=pinned?.scene===look.id?null:{...places,scene:look.id};
    if(!pinned)showing=look.id;                         // unpinned: it stays on screen for now; the usual look is unchanged
    receiver.pin(songId,pinned);paintControls();
  }
  function showScenes(){
    sceneButtons=scenes.map((s,i)=>button(s.name,`${s.name} (${i+1})`,()=>choose(s.id)));
    const problems=failed.map(f=>{const b=button('⚠ '+f.file.replace(/[.]js$/,''),`${f.file} could not be loaded: ${f.error}`,()=>{});b.className='visualizer-failed';return b;});
    group.replaceChildren(...sceneButtons,...problems);paintControls();arrange();
  }
  // The folder is read again every few seconds and whenever the window comes back into focus: a file dropped in appears, a deleted one
  // goes (the chosen look falls back to the first), and a changed one is loaded fresh and restarted. Nothing is redone if nothing changed.
  let listing=null,listingNow=null;
  function refreshScenes(){
    if(disposed||listingNow)return listingNow;
    listingNow=loadVisualizations().then(result=>{
      if(disposed)return;
      const signature=JSON.stringify([result.scenes.map(s=>[s.mine,s.file,s.version,s.id]),result.failed.map(f=>[f.mine,f.file,f.version,f.error])]);
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
    if(stream)return;
    if(event.target?.closest?.('input,textarea,[contenteditable="true"]')||event.ctrlKey||event.metaKey||event.altKey)return;
    const n=Number(event.key);
    if(n>=1&&n<=scenes.length)choose(scenes[n-1].id);
    else if(event.key==='y'||event.key==='Y')set({lyrics:!settings.lyrics});      // (L loops four bars, as in the main window)
    else if(event.key==='c'||event.key==='C')set({calm:!settings.calm});
    else if(event.key==='p'||event.key==='P')set({fps:!settings.fps});       // frame rate readout, to check smoothness
    else if(event.key==='m'||event.key==='M')toggleMixer();
    else if(event.key==='k'||event.key==='K')set({plain:!settings.plain});   // plain controls: no visualization's skin
    else return;
    event.preventDefault();event.stopPropagation();wake();       // over the main page, its own shortcuts must not fire too
  };
  if(!editor)container.ownerDocument.addEventListener('keydown',keys,true);   // in the editor, keys are for typing and its own controls

  // ---- drawing ----
  function resize(){
    const w=container.clientWidth,h=container.clientHeight,ratio=Math.min(window.devicePixelRatio||1,Math.sqrt(MAX_PIXELS/Math.max(1,w*h)));
    if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    g.setTransform(ratio,0,0,ratio,0,0);
    if(size[0]!==w||size[1]!==h){size=[w,h];active?.resize?.(w,h);arrange();}
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
  // the shown visualization's skin on the picker and the mixer, worked out again when the look, the app's theme or its scheme changes,
  // or K turns skins off (plain controls)
  let skinned=null,skinSheet=null;
  function skin(definition){
    const doc=container.ownerDocument,root=doc.documentElement,key=[definition?.id,definition?.version,root.dataset.theme,root.dataset.scheme,settings.plain];
    if(skinned&&key.every((v,i)=>v===skinned[i]))return;skinned=key;
    const own=settings.plain?null:definition?.skin;
    const css=getComputedStyle(root),theme={'--page':css.getPropertyValue('--page').trim(),'--ink':css.getPropertyValue('--ink').trim()};
    const vars=readSkin(own,{dark:root.dataset.scheme==='dark',theme,check:browserCheck});
    const tokens=Object.keys(own||{}).some(k=>k!=='css');
    if(tokens&&!Object.keys(vars).length)console.warn(`Visualization "${definition.name}": its skin colours were left out (unreadable, or its words would be hard to read on its paper)`);
    const panels=mixer.docked?[toolbar]:[toolbar,mixer.element];   // the editor's mixer keeps the app's own look, like the rest of the editor
    applySkin(panels,vars);for(const panel of panels)panel.classList.toggle('skinned',!!Object.keys(vars).length);
    // its own stylesheet, if it has one
    const base=(definition?.mine?'/my-visuals/':'/visualizations/');
    const sheet=own?.css?loadSkinSheet(skinStylesheet(own.css,{base})):null;
    if(own?.css&&!sheet)console.warn(`Visualization "${definition.name}": its skin stylesheet was left out (it must only style the picker and the mixer)`);
    if(skinSheet||sheet)doc.adoptedStyleSheets=[...doc.adoptedStyleSheets.filter(s=>s!==skinSheet),...(sheet?[sheet]:[])];
    skinSheet=sheet;
    for(const panel of panels){if(sheet)panel.dataset.skin=definition.id;else delete panel.dataset.skin;}
    arrange();                                          // a new border or font can change a panel's size
  }
  function draw(now){
    if(disposed)return;raf=requestAnimationFrame(draw);
    frames++;if(now-fpsAt>=1000){fps=frames*1000/(now-fpsAt);frames=0;fpsAt=now;}
    const dt=lastWall===null?1/60:Math.min(0.1,(now-lastWall)/1000);lastWall=now;
    cues.step(epochOf(now));
    const [w,h]=resize();skin(current());
    if(!song){g.fillStyle='#0d0e14';g.fillRect(0,0,w,h);g.textAlign='center';g.textBaseline='middle';g.fillStyle='#e9e6dc';g.font='500 18px system-ui';g.fillText(status,w/2,h/2);return;}
    const frame=sampleFrame(song,clock.time(now),{playing:clock.playing,rate:clock.rate,mix,loop:clock.loop});
    const definition=current();
    if(!definition){g.fillStyle='#0d0e14';g.fillRect(0,0,w,h);g.textAlign='center';g.textBaseline='middle';g.fillStyle='#e9e6dc';g.font='500 18px system-ui';
      g.fillText(scenes.length||!failed.length?'Loading the visualizations…':'No visualization could be loaded.',w/2,h/2);return;}
    const shownLyrics=cues.state.lyrics??settings.lyrics;
    const env={w,h,dt,wall:now/1000,calm:cues.state.calm??settings.calm,lyrics:shownLyrics,zones:hudZones(w,h,shownLyrics),song,
      events:frameEvents(previous,frame,song),status,fps,inputs:{},random:cues.random};
    const replay=cues.takeReplay();if(replay)env.events.replay=replay;
    const inputs=inputsFor(definition);
    if(inputs.length){
      if(patcherFor!==definition){patcher=new Patcher();patcherFor=definition;}
      sources();env.inputs=cues.overlay(inputs,patcher.run(inputs,patchFor(definition),{frame,previous,events:env.events,scene:song,dt,catalog:catalogById}),epochOf(now));
    }
    if(bay){
      // the bay shows the look on screen, its song's sources, and the patch in use (song's own, else the usual one)
      const shown=[definition,song,patches];
      if(!bayShown||shown.some((v,i)=>v!==bayShown[i])){bayShown=shown;
        bay.setVisual({visual:definition,inputs,catalog:sources(),patch:patchFor(definition),scope:patches.song?.[definition.id]?'song':'usual',songId,
          range:id=>sourceRange(id,song)});}
      const values=new Map(),ctx={frame,previous,events:env.events,scene:song,held:bayHeld};
      for(const id of bay.visibleSources())values.set(id,sourceValue(id,ctx));   // only the rows on show: a project can have hundreds
      bay.showLevels(values,env.inputs,dt);
    }
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
    dispose(){disposed=true;cancelAnimationFrame(raf);clearTimeout(idleTimer);clearInterval(rescan);container.ownerDocument.defaultView?.removeEventListener('focus',onFocus);receiver.dispose();try{active?.dispose?.();}catch{}mixer.dispose();bay?.dispose();
      if(skinSheet){const doc=container.ownerDocument;doc.adoptedStyleSheets=doc.adoptedStyleSheets.filter(s=>s!==skinSheet);}
      container.ownerDocument.removeEventListener('keydown',keys,true);container.removeEventListener('pointermove',wake);undrag.forEach(off=>off());canvas.remove();toolbar.remove();},
  };
}
