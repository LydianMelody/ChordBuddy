// A visualizer: follows the player over the visual bridge and draws the chosen visualization, every display frame.
// Visualizations are files in web/visualizations/ (the ones that come with Chord Buddy) and in the My Visuals folder in the app's root
// (your own; an update never touches it). One file per look, found automatically: drop a file in and it appears on the toolbar; names
// starting with _ are templates and drafts, left out. A file in My Visuals with the id of a built-in one takes its place. They draw the world; the chord and the lyrics are drawn on top by
// visual-hud.js in their own bands, so nothing covers them. A visualization that fails to load or throws while drawing is shown as
// broken, with its error, and the others keep working. Mounted by visualizer.html (pop-out window) and the main page's full-screen view.
// Only one visualizer draws at a time (visual-stage.js decides which, in the main window): the others stop drawing, let go of their
// graphics, and show their controls with a note saying where the picture is. The Stream controls window never draws at all.
//
// A visualization module's default export: {id, name, order (toolbar position, default 100), hud (default true),
//   skin (optional: restyles the picker and the mixer to match; visual-skin.js), create() -> {draw(g, frame, env), resize?(w, h), dispose?()}}.
//   inputs (optional, see visual-patch.js): {key:{label, type, default, help}}, the things the patch bay can wire sounds and signals to.
//   fonts (optional): font files from the visualization's own folder, and overlay (optional): the font the chord and lyrics are drawn in
//   (visual-fonts.js says how, and why a file there cannot reach anything else).
// env: {w, h, dt (wall seconds since the last frame), wall (wall seconds), calm, lyrics, chords (false: the chord is switched off, so a
//       visualization that draws its own chord, with hud:false, leaves it out too), zones (hudZones), song (the built scene),
//       fonts (the names it declared -> CSS font-family values, with a fallback), fontsReady (every declared font has loaded or failed), fontsLoaded ({name:true} for the ones that loaded),
//       inputs (each declared input's value this frame, from the patch in use; {} for a visualization without inputs),
//       events: {hits: {role: [strength…]} (new drum and instrument hits this frame), beat (a new beat: {bar, beat, downbeat}) or null,
//       chordChanged, sectionChanged, loop: {started, ended, wrapped} (the loop was turned on or changed, turned off, or went back to
//       its start)}, status, fps}
// frame.loop (visual-scene.js): the loop being repeated or null, with its kind, progress, bars and pass (which time around).
// Everything a scene shows must follow song time or wall time, never a fixed-length animation, so every scene runs as long as the song.
import {createVisualReceiver,randomId} from './visual-bridge.js';
import {BEAT} from './visual-stage.js';
import {SceneClock} from './visual-clock.js';
import {buildScene,sampleFrame,withFeatures} from './visual-scene.js';
import {loadSongFiles,songParts} from './midi-user.js';
import {effectiveMeasures} from './chart-layout.js';
import {setKeySpelling,setChartPitch,shownKey,chartOffsetAt,setSpellingPreference} from './spelling.js';
import {shiftMidiContent} from './pitch-midi.js';
import {hudZones,drawChordHud,drawLyricHud} from './visual-hud.js';
import {mountMixerDrawer} from './visual-mixer.js';
import {pickScene,panelPlace,ID_TEXT,orderScenes,stepScene,moveScene} from './visual-setup.js';
import {VisualCues} from './performance-visuals.js';
import {placePanel,draggable} from './visual-layout.js';
import {readSkin,applySkin,browserCheck,skinStylesheet,loadSkinSheet} from './visual-skin.js';
import {createFontLoader} from './visual-fonts.js';
import {Patcher,readInputs,choosePatch,sourceCatalog,catalogMap,sourceValue,sourceRange} from './visual-patch.js';
import {mountPatchBay} from './visual-patchbay.js';
import {icon} from './icons.js';

const SETTINGS='cb-visualizer';
const USUAL=['scene','lyrics','chords','calm','picker','mixer','patchbay'];   // what the usual setup keeps (visual-setup.js), saved by the main window
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
  const fallback={scene:'abstract',lyrics:true,chords:true,calm:false,fps:false,plain:false};
  try{return {...fallback,...JSON.parse(localStorage.getItem(SETTINGS)||'{}')};}catch{return fallback;}
}
function saveSettings(value){try{localStorage.setItem(SETTINGS,JSON.stringify(value));}catch{}}

const userFiles=new Map();                     // your MIDI files, read once per version (id:mtime)
// The index of the chart's bar 1 among the measures (the first bar shown), as the scene numbers them.
function firstBarOf(measures,scene){const one=scene?.bars?.find(b=>b.number===1);return Math.max(0,one?measures.findIndex(m=>Math.abs(m.start-one.start)<1e-6):0);}
// Who is asking: the main window's own pop-out has the session token in its scene; a visualizer in OBS has only its stream key.
export const credentials=(token,streamKey)=>token?{'X-ChordBuddy-Token':token}:{'X-ChordBuddy-Stream':streamKey||''};
async function getJson(path,headers){
  const response=await fetch(path,{headers});
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

// options: {streamKey (the OBS address's key, used in place of a token), open (the bridge channel; the BroadcastChannel by default), stream (an OBS Browser Source: no controls at all, nothing saved here,
// and it follows the main window's look rather than choosing one), editor (the Advanced Visuals Editor, visual-patchbay.js: {root, defaultVisualMenu, onPopOut,
// onClose}; the editor fills root and this visualizer draws in its preview corner, with no controls of its own),
// kind (what it is, for visual-stage.js: 'window', 'overlay', 'editor' or 'controls'; the Stream controls window shows the picker only
// and never draws), onClose (the main window asked it to close because a newer visualizer opened),
// keepOnTop (the Stream controls window in the desktop app: (on) => keep the window above the others; without it, Always on top keeps
// the controls from fading instead)}
export function mountVisualizer(container,{open,stream=false,streamKey='',editor=null,kind=editor?'editor':'window',onClose=null,keepOnTop=null}={}){
  const controlsOnly=kind==='controls';
  let bay=null;
  if(editor){
    // the patch bay (visual-patchbay.js; bayShown: what it was last given, so it is only told when something changed): a change shows at
    // once here, and is saved by the main window, which tells every visualizer
    bay=mountPatchBay(editor.root,{onSave:(song,visual,value)=>{
      const place=song?patches.song:patches.usual,next={...place};if(value)next[visual]=value;else delete next[visual];
      patches=song?{...patches,song:next}:{...patches,usual:next};bayShown=null;receiver.patch(song,visual,value);},
      stored:(song,visual)=>(song?patches.song:patches.usual)?.[visual]??null,
      onChoose:id=>choose(id),defaultVisualMenu:editor.defaultVisualMenu,onPopOut:editor.onPopOut,onClose:editor.onClose});
    container=bay.preview;container.classList.add('visualizer-stage','in-editor');
  }
  const canvas=document.createElement('canvas');canvas.className='visualizer-canvas';container.append(canvas);
  const g=canvas.getContext('2d'),clock=new SceneClock(),settings=stream?{...loadSettings(),fps:false,plain:false}:loadSettings();
  if(stream)container.classList.add('streaming');
  if(controlsOnly){container.classList.add('controls-only');canvas.hidden=true;}
  // ---- whether this one draws (visual-stage.js): undefined until the main window says, so a lone visualizer starts at once ----
  const me=randomId();
  let drawer,obsShown=true;
  const drawsHere=()=>!controlsOnly&&(stream?obsShown:drawer===undefined||drawer===me);
  const elsewhere=document.createElement('div');elsewhere.className='visualizer-elsewhere';elsewhere.hidden=true;
  const elsewhereText=document.createElement('p'),takeButton=document.createElement('button');
  takeButton.type='button';takeButton.className='btn';takeButton.textContent='Show the preview here';
  takeButton.title='Draw the preview here again. The visualizer window closes, so the look is still only drawn once.';
  takeButton.onclick=()=>receiver.take(me);
  elsewhere.append(elsewhereText,takeButton);container.append(elsewhere);
  function whereNote(){
    if(stream)return '';
    if(drawer==='obs')return controlsOnly?'Showing in OBS. These controls change what OBS shows.'
      :'Showing in OBS, so it isn’t drawn here too (that would use your graphics card twice). To see it here, hide the Browser Source in OBS.';
    if(controlsOnly)return drawer?'Showing in the visualizer window.':'Not showing anywhere yet. Add the Browser Source in OBS, or open the visualizer.';
    return kind==='editor'?'The preview is in its own window, so it isn’t drawn here too.':'Showing in another visualizer window.';
  }
  function updateDrawing(){
    const on=drawsHere();
    if(on&&!raf&&!disposed){lastWall=null;raf=requestAnimationFrame(draw);}
    if(!on&&raf){
      cancelAnimationFrame(raf);raf=0;
      try{active?.dispose?.();}catch{}active=null;activeId=null;activeDefinition=null;   // its graphics are let go, not just left still
      g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,canvas.width,canvas.height);
    }
    const text=on?'':whereNote();
    elsewhere.hidden=!text;elsewhereText.textContent=text;
    container.dataset.where=drawer==='obs'?'obs':drawer?'window':'nowhere';   // the Stream controls window's status light
    takeButton.hidden=!(kind==='editor'&&drawer&&drawer!=='obs'&&drawer!==me);
    container.classList.toggle('drawn-elsewhere',!on);
    if(!on)wake?.();
  }  // the bundled fonts (FONTS in visual-hud.js): a canvas only uses a web font once it is loaded, so load them up front
  for(const face of ['400 16px "Bricolage Grotesque"','800 16px "Bricolage Grotesque"','400 16px "Space Mono"','700 16px "Space Mono"','400 16px "Courier Prime"','700 16px "Courier Prime"'])
    document.fonts?.load?.(face).catch(()=>{});
  const fontLoader=createFontLoader();           // the fonts visualizations bring (visual-fonts.js), loaded once per copy of each
  let mixer=null,song=null,songKey=null,mix=null,status='Waiting for Chord Buddy… start playback in the main window.',raf=0,disposed=false,order=[];
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
    const key=JSON.stringify([m.songId,m.runId,m.revision,m.key,m.spelling,m.pitch,m.lyricGuess,m.userMidi]);if(key===songKey)return;songKey=key;
    if(!m.songId){song=null;status='No song is open in Chord Buddy.';return;}
    // pitch control: chord names, the key and melody notes follow the Chart switch (spelling.js, pitch-midi.js); drums, and your MIDI
    // that only drives a visual (extras), never move
    setSpellingPreference(m.spelling||'key');setKeySpelling(m.key||'');setChartPitch(m.pitch?.chart||0,m.pitch?.steps||[]);
    const base={content:m.content,music:m.music,title:m.title,key:shownKey()||m.key,lyricGuess:!!m.lyricGuess};
    const moved=notes=>shiftMidiContent({notes,tracks:[]},chartOffsetAt).notes;
    song=buildScene(base);status='';previous=null;
    const midi={};
    await Promise.all((m.midiDocs||[]).map(async doc=>{
      const name=midiName(doc.name);if(!name)return;
      try{midi[name]=moved((await getJson('/api/document/'+encodeURIComponent(doc.id),credentials(m.token,streamKey))).content?.notes||[]);}catch{}
    }));
    // your own MIDI files: parts that replace the model's melodies, and extras (midi-user.js)
    let user=[],extras=[];
    if(m.userMidi?.length&&m.music?.measures?.length)try{
      const files=await loadSongFiles(m.songId,m.userMidi,path=>fetch(path,{headers:credentials(m.token,streamKey)}).then(r=>{if(!r.ok)throw Error(r.status);return r.arrayBuffer();}),userFiles);
      const measures=effectiveMeasures(m.music,m.content?.layout||{});
      const parts=songParts(files,measures,{duration:m.content?.duration||m.music?.duration||0,firstBar:firstBarOf(measures,song)});
      for(const [name,notes] of Object.entries(parts.replace)){midi[name]=moved(notes).map(n=>({...n,mine:true}));user.push(name);}
      // the combined melody follows a replaced part (your notes in it keep their dynamics; the model's are measured as before)
      if(user.length&&midi.melody)midi.melody=[...(midi.vocal||[]),...(midi.instrumental||[])];
      extras=parts.extras;
    }catch{/* the model's MIDI is used instead */}
    if(songKey!==key||disposed)return;
    song=buildScene({...base,midi,user,extras});previous=null;
    if(!m.runId)return;                                // not playable yet: chords, lyrics and MIDI only
    try{
      const features=await getJson('/api/visual-features/'+encodeURIComponent(m.runId),credentials(m.token,streamKey));
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
      const nextOrder=Array.isArray(m.order)?m.order:[];
      if(JSON.stringify(nextOrder)!==JSON.stringify(order)){order=nextOrder;showScenes();}
      paintControls();arrange();},
    onStage:m=>{
      if(stream)return;                                  // OBS draws while its source is shown (setDrawing)
      drawer=m.drawer??null;updateDrawing();          // stops at once, even if the window can't close (a browser tab it didn't open)
      if(m.close?.includes(me))onClose?.();
    },
  });
  // say this one is open (and again every couple of seconds, so the main window can tell when one vanished), and when it closes
  const bye=()=>receiver.bye(me);
  let heartbeat=0;
  if(!stream){receiver.here(me,kind);heartbeat=setInterval(()=>receiver.here(me,kind),BEAT);container.ownerDocument.defaultView?.addEventListener('pagehide',bye);}

  // ---- the controls: scene, lyrics, calm; they hide when the mouse rests ----
  const toolbar=document.createElement('div');toolbar.className='visualizer-toolbar';
  const button=(label,title,onclick)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.title=title;b.onclick=onclick;return b;};
  let sceneButtons=[];
  const lyricsButton=button('Lyrics','Show the lyrics (Y)',()=>set({lyrics:!settings.lyrics}));
  const chordsButton=button('Chords','Show the chord at the top: its name, and the ones coming next (H)',()=>set({chords:settings.chords===false}));
  // Always on top: in the Stream controls window (desktop app) the window stays above your other windows; in a visualizer window or full
  // screen, the controls stay on screen instead of fading when the mouse rests. Kept in this window's own settings.
  const topButton=button('Always on top',controlsOnly
    ?'Keep this window above your other windows, so the controls are always at hand while you stream'
    :'Keep these controls on screen: they stop fading away when the mouse rests',()=>setOnTop(!onTop));
  const calmButton=button('Calm','Calm mode: gentler motion, with no shaking, flashing or sudden bursts of light (C)',()=>set({calm:!settings.calm}));
  const mixerButton=button('Mixer','Slide out the mixer (M)',()=>toggleMixer());
  // the patch bay lives in the main window (the Advanced Visuals Editor), where there is room for it
  const patchButton=button('Edit visuals','Open the Advanced Visuals Editor in the main window: choose which sounds and signals move which parts of this visualization',()=>receiver.editor());
  const pinButton=button('Pin','',()=>togglePin());pinButton.className='visualizer-pin';
  // stable names for a skin's stylesheet (visual-skin.js)
  for(const [b,name] of [[pinButton,'pin'],[topButton,'ontop'],[lyricsButton,'lyrics'],[chordsButton,'chords'],[calmButton,'calm'],[mixerButton,'mixer'],[patchButton,'patch']])b.dataset.control=name;
  // every switch in the app's own buttons, each with its icon (as in the Stream controls window)
  for(const [b,name] of [[topButton,'pin'],[lyricsButton,'text'],[chordsButton,'note'],[calmButton,'heart'],[mixerButton,'layers'],[patchButton,'wand']]){
    b.classList.add('btn');b.insertAdjacentHTML('afterbegin',icon(name));}
  if(controlsOnly&&!keepOnTop)topButton.hidden=true;           // a browser can't keep a window on top, and nothing here fades
  const ON_TOP='cb-visualizer-on-top:'+kind;
  let onTop=false;try{onTop=localStorage.getItem(ON_TOP)==='1';}catch{}
  function setOnTop(on){onTop=on;try{localStorage.setItem(ON_TOP,on?'1':'');}catch{}if(controlsOnly)keepOnTop?.(on);paintControls();wake();}
  if(controlsOnly&&onTop)keepOnTop?.(true);
  const group=document.createElement('div');group.className='visualizer-scenes';
  // previous and next look, going around at the ends ([ and ] on the keyboard)
  const stepper=document.createElement('div');stepper.className='visualizer-step';
  const previousButton=button('‹ Previous','Previous visualization: the one above in this list (the [ key)',()=>step(-1));previousButton.setAttribute('aria-label','Previous visualization');
  const nextButton=button('Next ›','Next visualization: the one below in this list (the ] key)',()=>step(1));nextButton.setAttribute('aria-label','Next visualization');
  previousButton.dataset.control='previous';nextButton.dataset.control='next';
  previousButton.textContent='';previousButton.insertAdjacentHTML('afterbegin',icon('chevronLeft')+'<span>Previous</span>');
  nextButton.textContent='';nextButton.insertAdjacentHTML('afterbegin','<span>Next</span>'+icon('chevron'));
  stepper.classList.add('seg');stepper.append(previousButton,nextButton);
  // the look showing, as a dropdown (the list of looks got too long for a column); the Stream controls window keeps the whole list
  const lookButton=document.createElement('button');lookButton.type='button';lookButton.className='btn visualizer-look';
  lookButton.title='Choose a visualization: the list opens here. Drag one up or down in it to change the order (keys 1 to 9 choose the first nine).';
  lookButton.setAttribute('aria-haspopup','true');lookButton.setAttribute('aria-expanded','false');
  const lookName=document.createElement('span');lookName.className='visualizer-look-name';
  lookButton.append(lookName);lookButton.insertAdjacentHTML('beforeend',icon('chevronDown'));
  const lookMenu=document.createElement('div');lookMenu.className='visualizer-look-menu';lookMenu.hidden=true;lookMenu.append(group);
  const lookWrap=document.createElement('div');lookWrap.className='visualizer-look-wrap';lookWrap.append(lookButton,lookMenu);
  function showMenu(open){
    lookMenu.hidden=!open;lookButton.setAttribute('aria-expanded',String(open));toolbar.classList.toggle('menu-open',open);
    if(open){wake();group.querySelector('button[aria-pressed="true"]')?.scrollIntoView({block:'nearest'});}
  }
  lookButton.onclick=()=>showMenu(lookMenu.hidden);
  const outside=event=>{if(!lookMenu.hidden&&!lookWrap.contains(event.target))showMenu(false);};
  container.ownerDocument.addEventListener('pointerdown',outside,true);
  // the grip along the top: drag it to move the picker anywhere on the screen (the ridges of a cassette's hinge, as on the set lists)
  const grip=document.createElement('div');grip.className='visualizer-grip';grip.title='Drag to move these controls';grip.setAttribute('aria-hidden','true');
  const switches=document.createElement('div');switches.className='visualizer-switches';
  switches.append(topButton,lyricsButton,chordsButton,calmButton,mixerButton,patchButton);
  toolbar.append(grip,stepper,lookWrap,switches);container.append(toolbar);
  // The Stream controls window lays the same controls out as two of the app's panels, each with a small label: the looks (with
  // Previous and Next) and the switches. Elsewhere the picker stays one slim floating column.
  let lookCount=null;
  if(controlsOnly){
    const panel=(cls,title,...nodes)=>{const box=document.createElement('section'),head=document.createElement('p');
      box.className='controls-panel '+cls;head.className='controls-label';head.textContent=title;box.append(head,...nodes);return box;};
    lookCount=document.createElement('em');
    const looks=panel('controls-looks','Visualizations',stepper,group);looks.firstChild.append(lookCount);
    toolbar.replaceChildren(looks,panel('controls-switches','On screen',topButton,lyricsButton,chordsButton,calmButton,patchButton));
  }
  // in the editor the mixer sits under the preview (muting a stem there quiets what it moves too: visual-patch.js)
  mixer=mountMixerDrawer(bay?bay.mixerSlot:container,{send:value=>receiver.setMix(value),docked:!!bay,
    onToggle:open=>{mixerButton.setAttribute('aria-pressed',String(open));}});   // its own chevron closes it too   // (the Stream controls window hides it: visualizer.css)
  if(mix)mixer.setMix(mix);
  function toggleMixer(value){if(controlsOnly)return;mixer.toggle(value);mixerButton.setAttribute('aria-pressed',String(mixer.open));arrange();}
  // ---- where the picker and the mixer float (visual-layout.js): the song's own places when it has a pin, else the usual ones ----
  // A drag saves the new place to the pin when the song has one (so the whole look comes back with the song), else as the usual place.
  const SPOTS={picker:{x:0,y:0},mixer:{x:1,y:0}};   // the built-in spots: picker top left, mixer top right
  function arrange(){
    if(!mixer||controlsOnly)return;
    placePanel(toolbar,container,panelPlace('picker',{pinned,usual:settings})||SPOTS.picker);
    if(!mixer.element.hidden&&!mixer.docked)placePanel(mixer.element,container,panelPlace('mixer',{pinned,usual:settings})||SPOTS.mixer);
    bay?.redraw();
  }
  function moved(panel,place){
    if(pinned){pinned={...pinned,[panel]:place};receiver.pin(songId,pinned);}
    else set({[panel]:place});
  }
  const undrag=controlsOnly?[]:[draggable(toolbar,grip,container,place=>moved('picker',place)),...(mixer.docked?[]:[draggable(mixer.element,mixer.handle,container,place=>moved('mixer',place))])];
  function paintControls(){
    shown().forEach((s,i)=>{sceneButtons[i].setAttribute('aria-pressed',String(s.id===current()?.id));sceneButtons[i].classList.toggle('broken',broken.has(s.id));sceneButtons[i].classList.toggle('pinned',pinned?.scene===s.id);});
    lyricsButton.setAttribute('aria-pressed',String(settings.lyrics));calmButton.setAttribute('aria-pressed',String(settings.calm));
    chordsButton.setAttribute('aria-pressed',String(settings.chords!==false));topButton.setAttribute('aria-pressed',String(onTop));
    lookName.textContent=current()?.name||'Choose a look';
    mixerButton.setAttribute('aria-pressed',String(!!mixer?.open));bay?.setScenes(shown(),current()?.id);
    previousButton.disabled=nextButton.disabled=scenes.length<2;
    // in the Stream controls window the list scrolls: keep the look showing in view when it changes
    if(controlsOnly||!lookMenu.hidden){const on=group.querySelector('button[aria-pressed="true"]');if(on&&on.dataset.scene!==shownLook){shownLook=on.dataset.scene;on.scrollIntoView({block:'nearest'});}}
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
    if(!controlsOnly&&!lookMenu.hidden&&!stepping)showMenu(false);
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
  // the looks in the picker's order (your favorites first: drag one up or down the list); 1-9 choose the first nine
  function shown(){return orderScenes(scenes,order);}
  let stepping=false;   // Previous and Next leave the list open if it is
  function step(direction){const next=stepScene(shown(),current()?.id,direction);if(next){stepping=true;choose(next.id);stepping=false;}}
  function sceneTip(s,i){return `Show ${s.name}${i<9?` (key ${i+1})`:''}. Drag it up or down to change the order: keys 1 to 9 choose the first nine.`;}
  function showScenes(){
    sceneButtons=shown().map((s,i)=>{const b=button(s.name,sceneTip(s,i),()=>{if(!dragged)choose(s.id);});b.dataset.scene=s.id;
      // in the Stream controls window, a grip that shows on hover (as on the sidebar's songs) and the number key on the right
      {b.classList.add('setlist-item');b.textContent='';b.insertAdjacentHTML('afterbegin',`<span class="scene-grip">${icon('grip')}</span>`);
        const name=document.createElement('span');name.className='scene-name';name.textContent=s.name;b.append(name);
        if(i<9){const key=document.createElement('em');key.className='scene-key';key.textContent=String(i+1);b.append(key);}}
      return b;});
    if(lookCount)lookCount.textContent=`${scenes.length} looks`;
    const problems=failed.map(f=>{const b=button('⚠ '+f.file.replace(/[.]js$/,''),`${f.file} could not be loaded: ${f.error}`,()=>{});b.className='visualizer-failed';return b;});
    group.replaceChildren(...sceneButtons,...problems);paintControls();arrange();
  }
  // Drag a look up or down the list to reorder it. The new order is saved by the main window (cb-visual-order), so every visualizer, the
  // number keys and [ ] follow it. A press that moves less than a few pixels is a click.
  let dragged=false,press=null,shownLook=null;
  group.addEventListener('pointerdown',event=>{
    const b=event.target.closest?.('button[data-scene]');if(!b||event.button!==0)return;
    press={b,id:b.dataset.scene,y:event.clientY,pointer:event.pointerId};dragged=false;
  });
  group.addEventListener('pointermove',event=>{
    if(!press||event.pointerId!==press.pointer)return;
    if(!dragged){if(Math.abs(event.clientY-press.y)<6)return;dragged=true;group.setPointerCapture?.(event.pointerId);press.b.classList.add('dragging');group.classList.add('reordering');}
    const others=[...group.querySelectorAll('button[data-scene]')].filter(b=>b!==press.b);
    const before=others.find(b=>{const r=b.getBoundingClientRect();return event.clientY<r.top+r.height/2;});
    group.insertBefore(press.b,before||others.at(-1)?.nextSibling||null);
  });
  const drop=event=>{
    if(!press||event.pointerId!==press.pointer)return;
    const was=press;press=null;
    if(!dragged)return;
    was.b.classList.remove('dragging');group.classList.remove('reordering');
    const at=[...group.querySelectorAll('button[data-scene]')].indexOf(was.b);
    order=moveScene(shown(),was.id,at);receiver.order(order);showScenes();
    setTimeout(()=>{dragged=false;},0);                // the click that ends a drag does not choose the look
  };
  group.addEventListener('pointerup',drop);group.addEventListener('pointercancel',drop);
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
  // the controls fade while the mouse rests over the picture; with no picture here (drawn elsewhere), they stay
  const wake=()=>{toolbar.classList.remove('idle');container.classList.remove('idle');clearTimeout(idleTimer);
    if(!drawsHere()||onTop||!lookMenu.hidden)return;
    idleTimer=setTimeout(()=>{toolbar.classList.add('idle');container.classList.add('idle');},2500);};
  container.addEventListener('pointermove',wake);wake();
  const keys=event=>{
    if(stream)return;
    if(event.target?.closest?.('input,textarea,[contenteditable="true"]')||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='Escape'&&!lookMenu.hidden){showMenu(false);event.preventDefault();event.stopPropagation();return;}
    const n=Number(event.key),list=shown();
    if(n>=1&&n<=Math.min(9,list.length))choose(list[n-1].id);
    else if(event.key==='[')step(-1);
    else if(event.key===']')step(1);
    else if(event.key==='y'||event.key==='Y')set({lyrics:!settings.lyrics});
    else if(event.key==='h'||event.key==='H')set({chords:settings.chords===false});   // the chord at the top      // (L loops four bars, as in the main window)
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
    g.fillText('The other visualizations still work: choose one in the list, or press [ or ]. Choosing this one again retries it.',w/2,h*0.45+52);
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
    if(disposed||!drawsHere()){raf=0;return;}raf=requestAnimationFrame(draw);
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
    const typeface=fontLoader.use(definition);
    const shownChords=settings.chords!==false;
    const env={w,h,dt,wall:now/1000,calm:cues.state.calm??settings.calm,lyrics:shownLyrics,chords:shownChords,zones:hudZones(w,h,shownLyrics),song,
      events:frameEvents(previous,frame,song),status,fps,inputs:{},random:cues.random,fonts:typeface.families,fontsReady:typeface.ready,fontsLoaded:typeface.loaded};
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
    if(definition.hud!==false&&!typeface.waiting){        // held back while its own font loads, so it never flashes in the wrong face
      if(shownChords){g.save();drawChordHud(g,frame,w,h,{calm:settings.calm,style:typeface.style});g.restore();}
      if(settings.lyrics){g.save();drawLyricHud(g,frame,w,h,{style:typeface.style});g.restore();}
    }
    if(settings.fps){g.font='600 12px ui-monospace,monospace';g.textAlign='right';g.textBaseline='bottom';g.fillStyle='rgba(255,255,255,.7)';
      g.fillText(`${Math.round(fps)} fps · ${canvas.width}×${canvas.height}`,w-10,h-8);}
  }
  updateDrawing();
  return {
    toolbar,
    /** Add a button to the switches (Full screen, Close): one of the app's buttons, with its icon. */
    addControl(b,iconName){b.classList.add('btn');if(iconName)b.insertAdjacentHTML('afterbegin',icon(iconName));(controlsOnly?toolbar:switches).append(b);},
    /** An OBS Browser Source: whether its source is shown in OBS (it draws only then). */
    setDrawing(value){obsShown=!!value;updateDrawing();},
    command:action=>receiver.command(action),           // a playback key, for the player (a pop-out window has no player of its own)
    dispose(){disposed=true;cancelAnimationFrame(raf);clearTimeout(idleTimer);clearInterval(rescan);clearInterval(heartbeat);container.ownerDocument.defaultView?.removeEventListener('focus',onFocus);
      if(!stream){bye();container.ownerDocument.defaultView?.removeEventListener('pagehide',bye);}receiver.dispose();elsewhere.remove();try{active?.dispose?.();}catch{}mixer.dispose();bay?.dispose();
      if(skinSheet){const doc=container.ownerDocument;doc.adoptedStyleSheets=doc.adoptedStyleSheets.filter(s=>s!==skinSheet);}
      container.ownerDocument.removeEventListener('keydown',keys,true);container.ownerDocument.removeEventListener('pointerdown',outside,true);container.removeEventListener('pointermove',wake);undrag.forEach(off=>off());canvas.remove();toolbar.remove();},
  };
}
