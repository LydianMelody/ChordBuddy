import {commitPracticeDocument} from './practice-save.js';
import {planChartChordEdit} from './practice-edit.js';
import {retryDocumentExport} from './export-retry.js';
import {reconcileCompactPreferences} from './compact-chart.js';
import {installTooltips} from './tooltips.js';
import {mountChartPage} from './chart-page.js';
import {ZOOM_LEVELS} from './timing-geometry.js';
import {askChoice,askSongSetup,askSongImport,openTrash,openShortcuts,CPU_STEMS_SLOW,CPU_STEMS_WARNING} from './dialogs.js';
import {updateViewport} from './practice-timeline.js';
import {PlaybackGate} from './playback-ready.js';
import {analysisUiState,songStatusLabel,analysisErrorMessage,lockStepStates,lockJobFailed} from './analysis-view.js';
import {ProposalGuard,renderRhythmPreview} from './rhythm-view.js';
import {Transport} from './transport.js';
import {mountMixer} from './mixer-rack.js';
import {mountPlayer} from './player-view.js';
import {playbackAction,targetSeconds} from './playback-keys.js';
import {SHORTCUTS} from './shortcuts.js';
import {renderLibraryPage,tapeTint} from './library-page.js';
import {createSongFacts,shortKey,totalLabel} from './song-facts.js';
import {activeChord, editChordContent, isJobActive, jobProgress, validateChart, displayChordLabel, settleHistoryResult} from './editor.js';
import {renderLeadSheet,updateLeadSheetPlayback,markCurrentChord,followPlayback} from './lead-sheet.js';
import {renderMidiRoll} from './midi-view.js';
import {installPageNav,MIN_ZOOM as MIN_PAGE_ZOOM,MAX_ZOOM as MAX_PAGE_ZOOM} from './page-nav.js';
import {openSongTiming,openReprocess,openModelAttribution} from './settings-view.js';
import {effectiveMeasures, isNoChordLabel} from './chart-layout.js';
import {icon} from './icons.js';
import {prefs} from './prefs.js';
import {usualMeter,parseMeter,METER_CHOICES} from './bar-lengths.js';
import {chooseKey,parseKeyLab,KEY_CHOICES} from './key-estimate.js';
import {setKeySpelling,spellChord,spellAbc} from './spelling.js';
import {onsetsFromNotes} from './word-layout.js';
import {mountModelsPanel,mountChordModelPanel} from './models-view.js';
import {mountDeskBars,combinedZoom} from './desk-bars.js';
import {createVisualPublisher,desktopWindow} from './visual-bridge.js';
import {mountVisualizer} from './visualizer-view.js';

const $ = id => document.getElementById(id);
document.querySelector('.chart-intro h2')?.remove();
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const model = {view:'song',libraryQuery:'',libraryKey:'',state:null,setlist:null,song:null,detail:null,document:null,documents:new Map(),loadingSong:0,polling:false,importing:false,pendingTitle:false,titleSave:null,dragSong:null,chartSection:null,chartChord:null,pendingChart:null};
const clone = value => structuredClone(value);
const mediaUrl = path => `${path}?token=${encodeURIComponent(token)}`;
const timeLabel = seconds => `${Math.floor(Math.max(0,seconds)/60)}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
const element = (tag,className,text) => {const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text;return node;};
function showError(error) {$('alert').textContent=error?.message || String(error);$('alert').classList.remove('hidden');}
function clearError() {$('alert').classList.add('hidden');}
async function api(path, body, options={}) {
  const headers={'X-ChordBuddy-Token':token,...options.headers};
  const init={...options,headers};
  if(body!==undefined) {init.method='POST';init.body=JSON.stringify(body);headers['Content-Type']='application/json';}
  const response=await fetch(path,init);
  let result;try{result=await response.json();}catch{throw new Error(`The local app returned an unreadable response (${response.status}).`);}
  if(!response.ok){const error=new Error(result.error || `Request failed (${response.status}).`);error.status=response.status;throw error;}
  return result;
}
// The chord model is needed for every analysis; it shows until it is downloaded (see chordbuddy/transcription_models.py).
const chordModelPanel=mountChordModelPanel($('chord-model-panel'),{
  onDownload:async()=>{try{await api('/api/chord-model/download',{});await refreshState();}catch(error){showError(error);}},
  onCancel:async()=>{try{await api('/api/chord-model/cancel',{});await refreshState();}catch(error){showError(error);}},
});
// The stem separation models are downloaded on first run (see models-view.js and chordbuddy/model_downloads.py).
const modelsPanel=mountModelsPanel($('models-panel'),{
  onDownload:async()=>{try{await api('/api/models/download',{});await refreshState();}catch(error){showError(error);}},
  onCancel:async()=>{try{await api('/api/models/cancel',{});await refreshState();}catch(error){showError(error);}},
  onFile:async file=>{await api('/api/models/import?name='+encodeURIComponent(file.name),undefined,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});await refreshState();},
});
const transport=new Transport({audio:$('audio'),token});
let separationDetail=null;
let lockSig='',lockedMode='none';
const playbackGate=new PlaybackGate(transport,id=>api('/api/playback/'+encodeURIComponent(id)));
// Whether to split the stems is remembered from the last time (off until chosen). The chart and lead sheet never wait for the stems.
// Without a working NVIDIA GPU (or with "CPU only" chosen) splitting can take up to an hour, so there it starts unticked every time.
const fastStems=()=>!!model.state?.engine?.gpu&&model.state?.settings?.device!=='cpu';
const wantsStems=()=>fastStems()&&prefs.get('cb-stems','0')==='1';
const stemsHint=()=>'Separates vocals, guitars, bass, drums and piano so you can mix them. It takes much longer'+(model.state?.models?.ready?'.':' and needs a one-time download of the stem models.');
async function startAnalysis(songId,invalidate=[],stems=wantsStems(),editPolicy='keep'){
 if(model.state?.chord_model&&!model.state.chord_model.ready){chordModelPanel.show();throw Error('Chord Buddy needs the chord model first. Download it in the panel above, then choose Analyze.');}
 if(stems&&model.state?.models&&!model.state.models.ready){modelsPanel.want();throw Error('Splitting stems needs the stem models first. Download them below, then analyze again, or turn stems off.');}
 await playbackGate.analyze(songId,()=>api('/api/songs/'+encodeURIComponent(songId)+'/analyze',{invalidate,stems,edit_policy:editPolicy}));
 await refreshState();
}
// "Split stems" on a song that was analyzed without them: the stems are made on their own, and the player switches to them when done.
async function splitStems(){
 const songId=model.song;if(!songId)return;
 if(model.state?.models&&!model.state.models.ready){modelsPanel.want();throw Error('Splitting stems needs the stem models first. Download them below, then press Split stems again.');}
 if(!fastStems()&&await askChoice({title:'Split the stems on the processor?',message:[CPU_STEMS_SLOW,'The chart, lead sheet and visualizer keep working while it runs.'],choices:[{id:'split',label:'Split stems',kind:'primary'}]})!=='split')return;
 if(model.song!==songId)return;
 await api('/api/separate',{song_id:songId});await refreshState();
}
const mixer=mountMixer($('rack'),{transport,onError:showError,onSplit:()=>splitStems().catch(showError),exportTarget:()=>{const runId=separationDetail?.active?.run_id,song=currentSong();return runId&&song?{title:song.title||'Chord Buddy',stemsUrl:name=>mediaUrl(`/api/stems-export/${encodeURIComponent(runId)}`)+`&name=${encodeURIComponent(name)}`,url:(query,name)=>mediaUrl(`/api/mix-export/${encodeURIComponent(runId)}`)+`&${query}&name=${encodeURIComponent(name)}`}:null;}});

let practiceViewport=null,practiceData=null;
// The waveform's peak outline also tells the chart whether the recording fades out (fade-out.js).
const player=mountPlayer($('player'),transport,showError,{onViewportChange:updatePracticeViewport,loadWaveform:run=>{const song=model.song;return api('/api/waveform/'+encodeURIComponent(run)).then(value=>{
 if(value&&song===model.song){model.waveform={song,run,peaks:value.peaks,duration:value.duration};if(currentRecord()?.doc.kind==='chart')renderChart();}
 return value;});}});
const practiceView=mountChartPage($('chart-sections'),{
 onSeek:seconds=>transport.seek(seconds),onCommit:commitPracticeEdit,onBarEdit:editBars,onError:showChartError,onReload:reloadPracticeChart,canEdit:()=>!currentRecord()?.practiceConflict&&!currentRecord()?.saving,
 onViewportChange:updatePracticeViewport,onRhythm:()=>rhythmButton.click(),onTimingSettings:()=>$('song-timing').click(),
 onDraftChange:info=>{const r=currentRecord();if(r&&!info.failed&&!info.saving)r.practiceSaveError=null;renderDocument();},
 onModeChange:()=>syncModeUi(),onToolChange:()=>syncModeUi(),onScopeChange:()=>syncModeUi(),onTimingChange:()=>syncModeUi(),
 isActive:()=>currentRecord()?.doc.kind==='chart'&&!$('chart-editor').classList.contains('hidden'),onZoomWheel:event=>zoomChartAt(event.deltaY<0?1.15:1/1.15,event.clientX),
 dock:$('tool-rail'),note:$('tool-note'),status:$('tool-status'),legend:$('key-legend'),
});
// The chart has no tools: a click plays from there, Ctrl edits what is written and Shift draws it in time (chart-page.js).
// In time, the chart is drawn on a beat grid wider than the desk: it gets cassette bars (scroll and zoom) instead of scroll bars.
// The bottom bar's grips and Ctrl+wheel share one zoom: the beat grid's own, and past either end of it the page shrinking (to 50%) or
// growing (to the page zoom's largest), so both reach exactly as far.
let pageNav=null;
const chartZoom=combinedZoom(
 {get:()=>practiceView.getZoom(),set:value=>practiceView.setZoom(value),limits:[ZOOM_LEVELS[0],ZOOM_LEVELS.at(-1)]},
 {get:()=>pageNav?.getZoom()??1,set:value=>pageNav?.setZoom(value)},MIN_PAGE_ZOOM,MAX_PAGE_ZOOM);
const deskBars=mountDeskBars(document.querySelector('.stage'),$('desk'),chartZoom);
// Zoom the in-time chart by `factor`, keeping the part of the page under the pointer (or the middle) where it was.
function zoomChartAt(factor,clientX){
 const desk=$('desk'),box=desk.getBoundingClientRect(),px=Number.isFinite(clientX)?clientX-box.left:box.width/2,at=(desk.scrollLeft+px)/Math.max(1,desk.scrollWidth);
 const [lowest,highest]=chartZoom.limits;chartZoom.set(Math.max(lowest,Math.min(highest,chartZoom.get()*factor)));
 desk.scrollTo({left:at*desk.scrollWidth-px,behavior:'instant'});deskBars.refresh();
}
function syncModeUi(){
 const mode=practiceView.getMode(),workspace=$('workspace');
 workspace.dataset.mode=mode;workspace.dataset.tool=practiceView.getTool();workspace.dataset.kind=currentRecord()?.doc.kind||'';
 workspace.dataset.repeats=practiceView.hasRepeats?.()?'1':'';           // "Apply to this pass / all matching" matters only with repeats
 for(const button of document.querySelectorAll('#scope button'))button.classList.toggle('on',button.dataset.scope===practiceView.getScope());
 const snapping=practiceView.isSnapping();$('snap-toggle').classList.toggle('on',snapping);$('snap-toggle').setAttribute('aria-pressed',String(snapping));
 deskBars.show(mode==='timing'&&workspace.dataset.kind==='chart');deskBars.refresh();
 const kind=currentRecord()?.doc.kind;$('song-timing').classList.toggle('hidden',kind!=='chart');
 $('restore').textContent='Restore model-predicted '+(kind==='abc'?'lead sheet':kind==='midi'?'MIDI':'chart')+'…';
 if(typeof rhythmButton!=='undefined')rhythmButton.hidden=kind!=='chart';
}
$('suggest').onchange=()=>{prefs.set('cb-suggest',$('suggest').checked?'1':'0');renderChart();};
$('snap-toggle').onclick=()=>{practiceView.setSnapping(!practiceView.isSnapping());prefs.set('cb-snap',practiceView.isSnapping()?'1':'0');};
installTooltips();
// Middle-button drag pans, Ctrl+wheel zooms the page (page-nav.js).
pageNav=installPageNav({desk:$('desk'),pages:[$('chart-editor'),$('abc-editor')],prefs,pill:$('zoom-pill')});
function closeInfo(){$('key-pop').classList.add('hidden');$('info-pop').classList.add('hidden');}
document.addEventListener('click',event=>{if(!event.target.closest?.('#info-pop,#key-pop'))closeInfo();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeInfo();});
for(const button of document.querySelectorAll('#scope button'))button.onclick=()=>practiceView.setScope(button.dataset.scope);
document.addEventListener('keydown',event=>{
 if(event.ctrlKey||event.metaKey||event.altKey||event.defaultPrevented)return;
 const target=event.target;if(target&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))return;
 if(document.querySelector('dialog[open]'))return;
 if(currentRecord()?.doc.kind==='abc'){if(leadView?.handleKey(event))event.preventDefault();return;}
 if(currentRecord()?.doc.kind!=='chart')return;
 if(practiceView.handleKey?.(event)){event.preventDefault();return;}
 if(practiceView.getMode()==='timing'&&(event.key==='+'||event.key==='=')){event.preventDefault();zoomChartAt(1.25);}
 else if(practiceView.getMode()==='timing'&&(event.key==='-'||event.key==='_')){event.preventDefault();zoomChartAt(.8);}
});
// The space bar plays and pauses from anywhere: except while typing, or while one of our dialogs is open (the browser's own print and
// save windows take the keys themselves). It also wins over a focused button, so a button you just clicked is not pressed a second time.
let spaceHandled=false;
const typingTarget=t=>!!t&&(t.isContentEditable||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||(t.tagName==='INPUT'&&!/^(checkbox|radio|range|button|submit|reset|file|color)$/.test(t.type||'text')));
document.addEventListener('keydown',event=>{
 spaceHandled=false;
 if(event.key!==' '&&event.code!=='Space')return;
 if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
 if(typingTarget(event.target)||document.querySelector('dialog[open]'))return;
 if(!transport.getSnapshot().ready)return;
 event.preventDefault();spaceHandled=true;
 if(event.repeat)return;
 if(transport.getSnapshot().playIntent)transport.pause();else transport.play().catch(showError);
},true);
// Ctrl+Z undoes and Ctrl+Shift+Z (or Ctrl+Y) redoes, as the buttons do. Not while typing, where the text box has its own undo, nor under a dialog.
document.addEventListener('keydown',event=>{
 if(!(event.ctrlKey||event.metaKey)||event.altKey||event.defaultPrevented)return;
 const key=String(event.key).toLowerCase(),redo=(key==='z'&&event.shiftKey)||(key==='y'&&!event.shiftKey);
 if(!redo&&!(key==='z'&&!event.shiftKey))return;
 if(typingTarget(event.target)||document.querySelector('dialog[open]'))return;
 const button=$(redo?'redo':'undo');event.preventDefault();if(!button.disabled)button.click();
});
document.addEventListener('keyup',event=>{if(spaceHandled&&(event.key===' '||event.code==='Space')){event.preventDefault();spaceHandled=false;}},true);
// R loops the section you are in and L four bars, the arrows step a bar and Ctrl+arrows a section (playback-keys.js). A pop-out visualizer sends the same.
function runPlaybackAction(action){
 const s=transport.getSnapshot();if(!s.ready)return;
 if(action.type==='toggle'){if(s.playIntent)transport.pause();else transport.play().catch(showError);}
 else if(action.type==='loop')player.toggleLoop(action.kind==='bars'?'bars':'section');
 else if(action.type==='bar'||action.type==='section'){
  const starts=action.type==='section'?player.sectionStarts():(practiceView.getModel()?.measures||practiceData?.music?.measures||[]).map(m=>m.start);
  const to=targetSeconds(starts,s.seconds,action.direction);if(to!==null)transport.seek(to).catch(showError);
 }
}
document.addEventListener('keydown',event=>{
 // (the space bar has its own handler above; a key the chart or lead sheet used itself, like an arrow moving a selected note, arrives handled)
 if(event.key===' '||event.code==='Space'||document.querySelector('dialog[open]'))return;
 const action=playbackAction(event);if(!action)return;
 event.preventDefault();if(!action.repeat)runPlaybackAction(action);
});
// Export PDF prints the Navigate page: the finished, readable chart.
window.addEventListener('beforeprint',()=>{if(practiceView.getMode()!=='nav')practiceView.setMode('nav');});
function updatePracticeViewport(action){
 if(!practiceData)return;
 const next=updateViewport(practiceViewport,action,{start:0,end:practiceData.content.duration,playhead:transport.getSnapshot().seconds,selectedSeconds:practiceView.getSelectedSeconds(),minSpan:.15});
 if(JSON.stringify(next)===JSON.stringify(practiceViewport))return;
 practiceViewport=next;renderChart();updatePracticePlayer();
}
function updatePracticePlayer(){
 if(practiceData)player.setPractice({music:{...practiceData.music,measures:effectiveMeasures(practiceData.music,practiceData.content.layout)},viewport:practiceViewport,projection:practiceView.getProjection(),barOffset:practiceView.getModel()?.barOffset||0});
}
// A complaint about a chart edit ("move that pin first") goes away as soon as an edit goes through; other messages are left for the user to dismiss.
let chartEditAlert=null;
function showChartError(error){chartEditAlert=error?.message||String(error);showError(error);}
async function commitPracticeEdit(next,label,expected){
 const r=currentRecord();if(!r)throw Error('Choose a chart.');
 next=reconcileCompactPreferences(next,r.doc.music).content;const invalid=validateChart(next);if(invalid)throw Error(invalid);
 const pending=commitPracticeDocument(r,next,label,expected,api);renderSaveStatus();
 try{await pending;if(chartEditAlert!==null&&$('alert').textContent===chartEditAlert)clearError();chartEditAlert=null;if(r.doc.export_warning)showError(r.doc.export_warning);}
 finally{if(currentRecord()===r)renderDocument();}
}
// Moving, adding or removing a barline is a correction to the song's beat grid: it is saved with the chart's timing, so the bars,
// the lyrics' times and the repeats are all rebuilt from it, and Undo puts the old grid back.
async function editBars(change){
  await commitUiDrafts();
  const record=currentRecord();if(record?.doc.kind!=='chart')throw Error('Choose a Song chart to change its barlines.');
  const id=record.doc.id,near=(list,t)=>list.findIndex(x=>Math.abs(x-t)<.04);
  const timing=structuredClone(record.doc.timing_binding?.overrides||{});
  const add=[...(timing.bar_edits?.add||[])],remove=[...(timing.bar_edits?.remove||[])];
  for(const t of change.removeBars||[]){const k=near(add,t);if(k>=0)add.splice(k,1);else remove.push(t);}
  for(const t of change.addBars||[]){const k=near(remove,t);if(k>=0)remove.splice(k,1);else add.push(t);}
  if(add.length||remove.length)timing.bar_edits={...(add.length?{add}:{}),...(remove.length?{remove}:{})};else delete timing.bar_edits;
  await window.chordBuddyFlush();
  await api('/api/documents/'+id+'/timing',{timing,revision:currentRecord().doc.revision});
  await keepDeskPlace(async()=>{await refreshSongDetail(model.song,true);renderDocument();});
}
async function reloadPracticeChart(){
 const r=currentRecord();if(!r||r.saving)return;
 r.saving=true;renderDocument();
 try{const doc=await api('/api/document/'+encodeURIComponent(r.doc.id));r.doc=doc;r.draft=clone(doc.content);r.version++;r.practiceConflict=false;r.practiceSaveError=null;}
 catch(error){showError(error);throw error;}
 finally{r.saving=false;renderDocument();}
}

transport.subscribe(()=>{if(model.detail)updatePlayback();renderLock();});
// ---- Visualizer: a pop-out window or this page in full screen, following the player over the visual bridge (visual-bridge.js). ----
const visuals=createVisualPublisher({onListen:()=>publishVisualScene(),onCommand:action=>runPlaybackAction(action),
  onMix:mix=>{try{transport.setMix(mix);}catch(error){showError(error);}}});        // a visualizer's mixer drawer (the transport checks it)
function publishVisualScene(){
  const song=currentSong(),record=chartRecord();
  if(!song||!model.detail){visuals.scene(null);return;}
  const playing=transport.getSnapshot();                          // without split stems, the recording it plays (orig-…) gives the sound data
  visuals.scene({songId:song.id,title:song.title,key:songKey().label,runId:separationDetail?.active?.run_id||(playing.ready&&playing.sourceRunId)||null,token,
    lyricGuess:prefs.get('cb-suggest','1')!=='0',                  // the chart's "guess from melody" setting, so words land where the chart puts them
    revision:record?`${record.doc.revision}:${record.version}`:null,content:record?.draft||record?.doc.content||null,music:record?.doc.music||null,
    midiDocs:(model.detail.documents||[]).filter(doc=>doc.kind==='midi').map(doc=>({id:doc.id,name:doc.name}))});
}
transport.subscribe(snapshot=>{visuals.clock(snapshot);if(visuals.listening)publishVisualScene();});
// Opening must happen straight from the click (browsers only allow pop-ups and full screen then); the song follows a moment later.
// In the desktop app the page cannot open windows or go full screen itself (WebView2), so it asks the app (desktopWindow()).
function openVisualizer(fullScreen){
  $('more-menu').open=false;
  const desktop=desktopWindow();
  if(fullScreen){
    const overlay=document.createElement('div');overlay.className='visualizer-overlay';document.body.append(overlay);
    const view=mountVisualizer(overlay),button=document.createElement('button');
    button.type='button';button.textContent='Close';button.title='Close the visualizer (Esc)';view.toolbar.append(button);
    let entered=false,closed=false;
    // Esc leaves full screen first (the browser does that); leaving it, Esc or Close removes the view
    const close=()=>{if(closed)return;closed=true;document.removeEventListener('fullscreenchange',changed);document.removeEventListener('keydown',key);view.dispose();overlay.remove();
      if(document.fullscreenElement===overlay)document.exitFullscreen().catch(()=>{});
      if(desktop)desktop.is_fullscreen().then(on=>{if(on)desktop.toggle_fullscreen();}).catch(()=>{});};
    const changed=()=>{if(document.fullscreenElement===overlay)entered=true;else if(entered)close();};
    const key=event=>{if(event.key==='Escape'&&document.fullscreenElement!==overlay){event.preventDefault();close();}};
    document.addEventListener('fullscreenchange',changed);document.addEventListener('keydown',key);button.onclick=close;
    if(desktop)desktop.is_fullscreen().then(on=>{if(!on&&!closed)desktop.toggle_fullscreen();}).catch(()=>{});   // the whole window, edge to edge
    else overlay.requestFullscreen().catch(()=>{});      // without full screen it still fills the window, with Close and Esc
  }else if(desktop)desktop.open_visualizer().catch(showError);
  else window.open('/visualizer.html','chordbuddy-visualizer','popup,width=1280,height=720');
  loadChartRecord().then(publishVisualScene).catch(showError);
}
$('visualizer-window').onclick=()=>openVisualizer(false);
$('visualizer-full').onclick=()=>openVisualizer(true);
// Keyboard shortcuts: from More options, or ? anywhere you are not typing.
const showShortcuts=()=>{$('more-menu').open=false;openShortcuts({groups:SHORTCUTS});};
$('shortcuts-open').onclick=showShortcuts;
document.addEventListener('keydown',event=>{
 if(event.key!=='?'||event.ctrlKey||event.metaKey||event.altKey||event.defaultPrevented||typingTarget(event.target)||document.querySelector('dialog[open]'))return;
 event.preventDefault();showShortcuts();
});
function renderSections(){
 const song=!!model.song,full=lockMode()==='full';
 $('work').classList.toggle('hidden',!song||full);
 $('workspace').classList.toggle('hidden',!song||full);
}
async function refreshSeparation(){
 const id=model.song;if(!id)return;
 let detail;try{detail=await api('/api/separation/'+encodeURIComponent(id));}catch(error){if(model.song===id)playbackGate.block('Could not verify analysis. Reconnecting.');throw error;}if(model.song!==id)return;
 separationDetail=detail;await playbackGate.refresh(id);if(model.song===id){model.readinessChecked=true;renderLock();}if(model.song===id){const snap=transport.getSnapshot();player.setWaveformRun(snap.ready?snap.sourceRunId:null);mixer.setSplit({busy:model.state?.job?.kind==='separation'&&isJobActive(model.state.job)&&model.state.job.song_id===id,note:''});}
}
function currentSong(){return model.state?.songs.find(song=>song.id===model.song);}
function currentRecord(){return model.documents.get(model.document);}
function currentContent(){const record=currentRecord();return record?.draft || record?.doc.content;}
function currentChords(){const record=currentRecord();if(record?.doc.kind==='abc'&&leadView?.chords)return leadView.chords();return ['abc','chart'].includes(record?.doc.kind) ? currentContent()?.chords || [] : model.detail?.chords || [];}
// Tempo and key badges for a song in the lists (song-facts.js), and what a list adds up to.
const songFacts=createSongFacts({api:(path,...rest)=>api(path,...rest),savedKey:id=>prefs.get('cb-key:'+id,''),onChange:()=>{model.libraryKey='';renderLibrary();}});
function factBadges(song){
  const facts=songFacts.get(song.id),box=element('span','song-facts');
  if(facts?.bpm){const tempo=element('b','fact-badge tempo');tempo.title=facts.bpm+' beats per minute';tempo.append(element('i','','♩'),String(facts.bpm));box.append(tempo);}
  if(facts?.key)box.append(Object.assign(element('b','fact-badge key',shortKey(facts.key)),{title:facts.key}));
  return box;
}
// the line under a song's title: what is wrong or happening with it, or else its tempo and key ("Transcribed" goes without saying)
function songLine(song,busy){
  if(busy)return element('small','song-note','Analyzing…');
  const label=songStatusLabel(song);
  return label==='Transcribed'?factBadges(song):element('small','song-note',label);
}
const listLength=songs=>songs.reduce((sum,song)=>sum+(Number(song.duration)||0),0);
function renderLibrary() {
  const state=model.state;if(!state)return;
  if(!state.setlists.some(list=>list.id===model.setlist))model.setlist='default';
  // "All songs" is the library itself (the set list every import joins); the set lists below it are the ones you make, and a song
  // dragged onto one of them (from All songs or from the list in the sidebar) is added to it.
  const library=state.setlists.find(list=>list.id==='default');
  $('all-songs').classList.toggle('selected',model.setlist==='default');$('all-count').textContent=library?.song_ids.length??state.songs.length;
  const nav=$('setlists');nav.replaceChildren();
  for(const list of state.setlists.filter(item=>item.id!=='default')){
    const button=element('button',`setlist-item${list.id===model.setlist?' selected':''}`);const listIcon=element('span','setlist-icon');listIcon.innerHTML=icon('list');
    button.append(listIcon,element('span','',list.name),element('span','setlist-count',list.song_ids.length));
    button.onclick=()=>{model.setlist=list.id;if(model.song)model.view='song';renderLibrary();renderView();};
    button.ondragover=event=>{if(!model.dragSong)return;event.preventDefault();event.dataTransfer.dropEffect='copy';button.classList.add('drop-target');};
    button.ondragleave=()=>button.classList.remove('drop-target');
    button.ondrop=event=>{if(!model.dragSong)return;event.preventDefault();button.classList.remove('drop-target');const id=model.dragSong;model.dragSong=null;addToSetlist(list,id,button);};
    nav.append(button);
  }
  const list=state.setlists.find(item=>item.id===model.setlist);
  $('library-heading').textContent=list?.id==='default'?'ALL SONGS':`${list?.name || 'SONGS'}`.toUpperCase();
  const query=$('song-search').value.trim().toLowerCase();
  const songs=(list?.song_ids || []).map(id=>state.songs.find(song=>song.id===id)).filter(Boolean);
  $('song-count').textContent=songs.length;$('list-total').textContent=songs.length?totalLabel(listLength(songs))+' total':'';songFacts.want(state.songs);
  const container=$('songs');container.replaceChildren();
  for(const [index,song] of songs.entries()){
    if(query && !`${song.title} ${song.artist || ''}`.toLowerCase().includes(query))continue;
    const row=element('div',`song-row${song.id===model.song?' selected':''}`);const busySong=isJobActive(state.job)&&state.job.song_id===song.id;row.dataset.status=busySong?'busy':song.active_run?'ready':'new';row.dataset.tint=String(tapeTint(song.id));const handle=element('span','song-number drag-handle','⠿');handle.draggable=true;handle.title='Drag to reorder, or onto a set list to add it there';handle.setAttribute('aria-label',handle.title);handle.ondragstart=event=>{model.dragSong=song.id;event.dataTransfer.setData('text/plain',song.id);event.dataTransfer.effectAllowed='copyMove';row.classList.add('dragging');};handle.ondragend=()=>{model.dragSong=null;row.classList.remove('dragging');for(const item of container.children)item.classList.remove('drop-target');};row.ondragover=event=>{if(model.dragSong && model.dragSong!==song.id && list?.song_ids.includes(model.dragSong)){event.preventDefault();event.dataTransfer.dropEffect='move';row.classList.add('drop-target');}};row.ondragleave=()=>row.classList.remove('drop-target');row.ondrop=event=>{if(!model.dragSong)return;event.preventDefault();event.stopPropagation();row.classList.remove('drop-target');moveSongBefore(model.dragSong,song.id);};row.append(handle);
    const button=element('button','song-main'),line=songLine(song,busySong);button.append(element('strong','',song.title));button.onclick=()=>selectSong(song.id);row.append(button);
    // on the spine the tempo and key stand on end beside the label; a note (Analyzing…, Failed) stays on the label, under the title
    if(line.classList.contains('song-facts'))row.append(line);else button.append(line);if(!song.active_run){const lock=element('span','song-lock');lock.title='Not analyzed yet';lock.innerHTML=icon('lock');row.append(lock);}else if(song.duration)button.insertBefore(element('span','song-len',timeLabel(song.duration)),button.children[1]||null);
    if(list?.id!=='default'){const out=element('button','song-remove');out.type='button';out.innerHTML=icon('x');out.title=`Take ${song.title} out of ${list.name}`;out.setAttribute('aria-label',out.title);out.onclick=()=>removeFromSetlist(list.id,song.id);row.append(out);}
    const order=element('div','song-order');for(const [symbol,direction] of [['▲',-1],['▼',1]]){const move=element('button','',symbol);move.title=`Move ${song.title} ${direction<0?'up':'down'}`;move.setAttribute('aria-label',move.title);move.disabled=index+direction<0 || index+direction>=songs.length;move.onclick=()=>reorderSong(song.id,direction);order.append(move);}row.append(order);container.append(row);
  }
  if(!container.children.length)container.append(element('p','sidebar-empty',query?'No songs match your search.':list?.id==='default'?'Your song library starts with an MP3. Import one to get going.':'This set list is ready for songs. Import an MP3 or add a song from your library.'));
  renderView();
  const trashed=state.trash||[];$('trash-open').classList.toggle('hidden',!trashed.length);$('trash-open').textContent='Trash ('+trashed.length+')';
  $('engine-status').textContent=state.engine.ready?'Transcription engine ready':state.engine.message || 'Transcription engine needs setup';
  $('engine-dot').classList.toggle('ready',!!state.engine.ready);
}
// The main area shows either the open song or All songs (library-page.js). All songs is drawn again only when something in it changed,
// so the regular refresh never interrupts a drag or the search field.
function renderView(){
  $('app').dataset.view=model.view;
  if(model.view!=='library'||!model.state)return;
  const state=model.state,library=state.setlists.find(list=>list.id==='default'),lists=state.setlists.filter(list=>list.id!=='default');
  const songs=(library?.song_ids||state.songs.map(s=>s.id)).map(id=>state.songs.find(s=>s.id===id)).filter(Boolean);
  const busy=isJobActive(state.job)?state.job.song_id:null,key=JSON.stringify([songs,lists,model.song,busy,model.libraryQuery,songs.map(s=>songFacts.get(s.id))]);
  if(key===model.libraryKey)return;model.libraryKey=key;
  renderLibraryPage($('library-page'),{songs,setlists:lists,selected:model.song,busy,query:model.libraryQuery},{
    onOpen:id=>selectSong(id),onRemove:(listId,songId)=>removeFromSetlist(listId,songId),
    onDragStart:id=>{model.dragSong=id;},onDragEnd:()=>{model.dragSong=null;for(const n of document.querySelectorAll('.drop-target'))n.classList.remove('drop-target');},
    onSearch:query=>{model.libraryQuery=query;renderView();},onImport:()=>$('import-button').click(),time:timeLabel,line:song=>songLine(song,song.id===busy),total:totalLabel(listLength(songs))});
}
function showAllSongs(){model.setlist='default';model.view='library';renderLibrary();}
// While a song is dragged, the whole page takes it, so the pointer stays an arrow (the browser shows its "no" sign wherever a drop is not
// taken). Only a set list does anything with it, and shows the arrow with a + (it is added there); let go anywhere else and nothing happens.
document.addEventListener('dragover',event=>{if(!model.dragSong||event.defaultPrevented)return;event.preventDefault();event.dataTransfer.dropEffect='move';});
document.addEventListener('drop',event=>{if(model.dragSong&&!event.defaultPrevented)event.preventDefault();});
async function addToSetlist(list,songId,node){
  const song=model.state.songs.find(s=>s.id===songId);
  if(list.song_ids.includes(songId)){node?.classList.add('already');setTimeout(()=>node?.classList.remove('already'),900);showError(`${song?.title||'That song'} is already in ${list.name}.`);return;}
  try{await api('/api/setlist/add',{id:list.id,song_id:songId});node?.classList.add('took');setTimeout(()=>node?.classList.remove('took'),900);await refreshState();}catch(error){showError(error);}
}
async function removeFromSetlist(listId,songId){try{await api('/api/setlist/remove',{id:listId,song_id:songId});await refreshState();}catch(error){showError(error);}}
async function reorderSong(id,direction){try{const list=model.state.setlists.find(item=>item.id===model.setlist);const ids=[...list.song_ids];const index=ids.indexOf(id);[ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];await api('/api/setlist/order',{id:list.id,song_ids:ids});await refreshState();}catch(error){showError(error);}}
async function moveSongBefore(id,target){try{const list=model.state.setlists.find(item=>item.id===model.setlist);const destination=list.song_ids.indexOf(target);const ids=list.song_ids.filter(songId=>songId!==id);ids.splice(destination,0,id);await api('/api/setlist/order',{id:list.id,song_ids:ids});model.dragSong=null;await refreshState();}catch(error){showError(error);}}
const TITLE_NODES=['page-song','score-title','midi-title'];
function renderControls(){
  const song=currentSong();$('empty-state').classList.toggle('hidden',!!song);$('song-controls').classList.toggle('hidden',!song);$('workspace').classList.toggle('hidden',!song);
  $('song-actions').classList.toggle('hidden',!song);
  renderSections();if(!song)return;   // (set lists are arranged on All songs, never from a song's page)
  if(!TITLE_NODES.some(id=>document.activeElement===$(id))&&!model.pendingTitle&&!model.titleSave){$('song-title').value=song.title;for(const id of TITLE_NODES)$(id).textContent=song.title;}

  const busy=isJobActive(model.state.job);
  $('transcribe').disabled=!!busy || !model.state.engine.ready || model.importing;
  $('transcribe').querySelector('em').textContent=analysisUiState(song,model.state.job).label;renderChips();
  if(typeof rhythmButton!=='undefined'){const job=model.state.job;rhythmButton.textContent=job?.kind==='rhythm'&&job.document_id===model.document&&job.status==='completed'?'Review rhythm proposal':'Attempt timing correction w/drum track';rhythmButton.disabled=isJobActive(job)||!separationDetail?.active;rhythmButton.title=separationDetail?.active?'':'Split the stems first: this listens to the drums.';}
  $('transcribe').title=!model.state.engine.ready?model.state.engine.message || 'Set up the transcription engine first.':'';
}
// ---- Locked state: a song is unusable until analysis finishes (readiness is decided by PlaybackGate/transport). ----
function lockMode(){const song=currentSong();if(!song)return 'none';if(!song.active_run)return 'full';return model.readinessChecked&&!transport.getSnapshot().ready?'banner':'none';}
function analysisJobFor(song){const job=model.state?.job;return job&&song&&job.song_id===song.id&&['analysis','separation'].includes(job.kind)?job:null;}
function renderLock(){
  const song=currentSong(),mode=lockMode(),job=analysisJobFor(song),running=!!job&&isJobActive(job),snap=transport.getSnapshot();
  const sig=JSON.stringify([mode,song?.id,job&&[job.kind,job.status,job.stage,job.error,job.stages],model.state?.engine?.ready,snap.ready,snap.readiness]);
  if(sig===lockSig)return;lockSig=sig;
  $('app').dataset.lock=mode;
  $('nav-lock').classList.toggle('hidden',!song||snap.ready);
  $('lock-banner').classList.toggle('hidden',mode!=='banner');
  $('banner-reanalyze').classList.toggle('hidden',running);               // the analysis is already running: its panel above has Cancel
  if(mode==='banner')$('lock-banner-text').textContent=(running?'Analyzing again. ':'')+(snap.readiness||'Playback is locked.')+(running?'':' Your chart is still here to view and edit.');
  $('locked-panel').classList.toggle('hidden',mode!=='full');
  if(mode==='full'){
    const failed=lockJobFailed(job);
    $('lock-title').textContent=running?'Analyzing…':failed?(job.status==='cancelled'?'Analysis cancelled':'Analysis did not finish'):'Not analyzed yet';
    $('lock-copy').textContent=running?(job.message||'This can take a few minutes. Playback unlocks when the chart and all seven stems are ready.'):failed?(analysisErrorMessage(job.error,false)||'Analyze again to unlock playback.'):'Chord Buddy needs to listen first. Analysis builds the chord chart and the seven practice stems; playback unlocks when both are ready.';
    const steps=$('lock-steps');steps.replaceChildren();
    for(const {label,glyph,state} of lockStepStates(job)){
      const step=element('div','step'+(state==='idle'?'':' '+state));
      const mark=element('span');mark.innerHTML=icon(state==='done'?'check':state==='failed'?'x':glyph);step.append(mark.firstChild,element('span','',label));
      if(state==='active'){const bar=element('span','bar-p');bar.append(document.createElement('i'));step.append(bar);}
      steps.append(step);
    }
    const cta=$('lock-cta'),text=cta.querySelector('em');
    text.textContent=running?'Cancel analysis':failed?'Analyze again':'Analyze song';
    cta.disabled=!running&&!model.state?.engine?.ready;cta.title=cta.disabled?(model.state?.engine?.message||'Set up the transcription engine first.'):'';
    cta.classList.toggle('hot',!running);
  }
  if(lockedMode!==mode){lockedMode=mode;renderSections();}
}
// The time signature beside the key: the one most bars carry (the model's first, pickup bar is not trusted), unless you have set your own.
// Click it to choose another; the choice is remembered with the library and used when the lead sheet is exported.
function songMeter(){
  const detected=usualMeter(currentRecord()?.doc.music?.measures||chartRecord()?.doc.music?.measures),saved=parseMeter(prefs.get('cb-meter:'+model.song,''));
  return {detected,custom:!!saved,meter:saved||detected};
}
function paintMeter(box){
  const {meter,custom}=songMeter();box.hidden=!meter;box.replaceChildren();if(!meter)return;
  box.append(String(meter[0]),document.createElement('hr'),String(meter[1]));
  box.title=custom?'Time signature set by you. Click to change it.':'Found by the analysis. Click to change it.';
  box.setAttribute('aria-label','Time signature: '+meter.join('/')+'. Click to change it.');
  box.onclick=event=>{event.stopPropagation();openMeterMenu(box);};
}
function openMeterMenu(chip){
  const pop=$('key-pop'),found=songMeter();closeInfo();
  const select=element('select');select.setAttribute('aria-label','Time signature of this song');
  const auto=element('option','','Detected'+(found.detected?': '+found.detected.join('/'):''));auto.value='';select.append(auto);
  for(const name of METER_CHOICES){const option=element('option','',name);option.value=name;select.append(option);}
  select.value=found.custom?found.meter.join('/'):'';
  select.onchange=()=>{prefs.set('cb-meter:'+model.song,select.value);closeInfo();paintMeter($('meter-box'));paintMeter($('score-meter'));};
  pop.replaceChildren(element('label','','Time signature'),select);
  placePop(pop,chip);select.focus();
}
function renderChips(){renderKeyBoxes();}   // the song's details live in each page's banner now; there are no pills in the header
// The key sits in each page's banner, beside the time signature. Click it to choose another.
function renderKeyBoxes(){
  const key=songKey();setKeySpelling(key.label);
  const song=currentSong(),bpm=(chartRecord()||currentRecord())?.doc?.music?.timing?.bpm;if(song?.active_run&&model.detail?.song?.id===song.id)songFacts.set(song.id,song.active_run,bpm,key.label);
  for(const head of document.querySelectorAll('.jhead')){
    let box=head.querySelector('.key-box');
    if(!box){
      box=element('button','key-box');box.type='button';box.append(element('small','','Key'),element('b'));
      box.onclick=event=>{event.stopPropagation();openKeyMenu(box);};
      const meter=head.querySelector('.meter-box');meter?head.insertBefore(box,meter):head.append(box);
    }
    box.hidden=!key.label;
    box.querySelector('b').textContent=key.label||'';
    box.title=key.custom?'Key set by you. Click to change it.':key.fromModel?'Found by the analysis. Click to change it.':key.overruled?`Estimated from the chords (the analysis said ${key.overruled.label}, but many chords do not fit that key). Click to change it.`:'Estimated from the chords. Click to change it.';
    box.setAttribute('aria-label','Key of this song: '+(key.label||'unknown')+'. Click to change it.');
  }
}
// The key is the analysis model's own (its key.lab); a song without one gets a guess from its chords. The player's own choice is remembered
// with the library and wins.
function songKey(){
  const found=model.modelKey?.song===model.song?model.modelKey.key:null;
  const chords=(currentContent()?.chords||chartRecord()?.doc.content?.chords||[]).filter(chord=>!isNoChordLabel(chord.label)),chosen=chooseKey(found,chords),estimate=chosen.key;
  const saved=prefs.get('cb-key:'+model.song,''),custom=KEY_CHOICES.includes(saved);
  return {estimate,custom,fromModel:chosen.source==='model',overruled:chosen.overruled,label:custom?saved:estimate?.label||null};
}
async function loadModelKey(detail,songId){
  const doc=detail.documents.find(item=>/(^|\/)key\.lab$/.test(item.name));
  if(!doc){model.modelKey={song:songId,doc:null,key:null};return;}
  if(model.modelKey?.song===songId&&model.modelKey.doc===doc.id)return;
  try{
    const full=await api('/api/document/'+encodeURIComponent(doc.id));if(model.song!==songId)return;
    model.modelKey={song:songId,doc:doc.id,key:parseKeyLab(full.content?.text)};renderChips();renderChart();if(currentRecord()?.doc.kind==='abc')renderAbc();
  }catch{model.modelKey={song:songId,doc:doc.id,key:null};}
}
// Under the chip, kept inside the window (the time signature sits at the far right of the page).
function placePop(pop,chip){
  const box=chip.getBoundingClientRect();pop.style.top=(box.bottom+8)+'px';pop.classList.remove('hidden');
  pop.style.left=Math.max(8,Math.min(box.left,window.innerWidth-pop.offsetWidth-8))+'px';
}
function openKeyMenu(chip){
  const pop=$('key-pop'),key=songKey();closeInfo();
  const select=element('select');select.setAttribute('aria-label','Key of this song');
  const auto=element('option','','Estimated'+(key.estimate?': '+key.estimate.label:''));auto.value='';select.append(auto);
  for(const name of KEY_CHOICES){const option=element('option','',name);option.value=name;select.append(option);}
  select.value=key.custom?key.label:'';
  select.onchange=()=>{prefs.set('cb-key:'+model.song,select.value);closeInfo();renderChips();renderChart();if(currentRecord()?.doc.kind==='abc')renderAbc();};
  pop.replaceChildren(element('label','','Key of this song'),select);
  placePop(pop,chip);select.focus();
}
// The line under a song's name: the artist (read from the MP3's tags when the song was imported, and yours to change) then the details.
function setSub(node,details){
  const song=currentSong();let artist=node.querySelector('.jartist');
  if(!artist){
    artist=element('span','jartist');artist.contentEditable='plaintext-only';artist.spellcheck=false;artist.setAttribute('role','textbox');artist.setAttribute('aria-label','Artist');
    artist.dataset.placeholder='Add artist';artist.dataset.tipTitle='Artist';artist.dataset.tip='Click to type who wrote or performs this song. It starts as the artist in the MP3’s tags, and stays empty if there is none.';
    artist.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();artist.blur();}else if(event.key==='Escape'){artist.textContent=currentSong()?.artist||'';artist.blur();}};
    artist.onblur=()=>commitArtist(artist).catch(showError);
    node.replaceChildren(artist,element('span','jrest'));
  }
  if(document.activeElement!==artist)artist.textContent=song?.artist||'';
  node.querySelector('.jrest').textContent=details.filter(Boolean).join(' · ');
}
async function commitArtist(node){
  const song=currentSong();if(!song)return;
  const artist=node.textContent.replace(/\s+/g,' ').trim();
  if(artist===(song.artist||''))return;
  const changed=await api('/api/song',{id:song.id,title:song.title,artist});
  const latest=model.state?.songs.find(item=>item.id===song.id);if(latest)Object.assign(latest,changed);
  renderLibrary();
  if(model.song===song.id)for(const id of ['page-sub','score-sub','midi-sub']){const other=$(id).querySelector('.jartist');if(other&&other!==node)other.textContent=changed.artist||'';}
}
function renderPageHead(){
  const song=currentSong(),music=currentRecord()?.doc.music,bpm=music?.timing?.bpm;
  setSub($('page-sub'),[bpm?`♩ = ${Math.round(bpm)}`:null,song?.duration?timeLabel(song.duration):null,'arranged in Chord Buddy']);
  paintMeter($('meter-box'));
}
const jobKey=job=>JSON.stringify([job?.id,job?.kind,job?.status,job?.stage]);
function renderJob(){
  const finished=model.state?.job&&['completed','cancelled'].includes(model.state.job.status),dismissed=model.state?.job&&model.dismissedJob===jobKey(model.state.job);
  if(!model.state?.job||finished||dismissed){$('job-panel').classList.add('hidden');return;}
  const activeJob=model.state?.job;if(['analysis','rhythm'].includes(activeJob?.kind)){const running=isJobActive(activeJob);$('job-panel').classList.remove('hidden');$('job-title').textContent=activeJob.kind==='rhythm'?'Drum-based rhythm correction':'Analyze song';$('job-message').textContent=analysisErrorMessage(activeJob.error,!!currentSong()?.active_run)||activeJob.retention_warning||activeJob.retention?.warning||activeJob.stage;$('cancel-job').classList.toggle('hidden',false);$('cancel-job').textContent=running?'Cancel':'Dismiss';$('cancel-job').disabled=activeJob.status==='cancelling';const progress=$('job-progress'),p=activeJob.progress;progress.classList.toggle('indeterminate',running&&!p?.total);progress.style.width=p?.total?`${Math.min(100,100*p.completed/p.total)}%`:activeJob.status==='completed'?'100%':'25%';return;}

  const job=model.state?.job;const running=isJobActive(job);
  $('job-panel').classList.toggle('hidden',!job);if(!job)return;
  const song=model.state.songs.find(item=>item.id===job.song_id);
  const titles={failed:'Transcription failed',error:'Transcription failed',partial:'Partial transcription · outputs preserved',completed:'Transcription complete',cancelled:'Transcription cancelled',cancelling:'Cancelling transcription',starting:'Starting transcription'};
  if(job.kind==='separation'){
    $('job-title').textContent='Separation'+(song?' — '+song.title:'');
    $('job-message').textContent=job.error||job.retention?.warning||job.message||job.stage;
    const p=job.progress,value=p?.total?100*p.completed/p.total:0;
    $('job-progress').classList.toggle('indeterminate',running&&!value);$('job-progress').style.width=(value||25)+'%';
    $('cancel-job').classList.toggle('hidden',!running);$('cancel-job').disabled=job.status==='cancelling';return;
  }
  $('job-title').textContent=`${titles[job.status] || 'Transcribing'}${song?' · '+song.title:''}`;
  $('job-message').textContent=[job.message || job.stage,job.windows?`Window ${job.window || 0} of ${job.windows}`:null].filter(Boolean).join(' · ');
  const progress=$('job-progress'),value=jobProgress(job);progress.classList.toggle('indeterminate',value.indeterminate);progress.style.width=value.indeterminate?'25%':`${value.percent}%`;
  $('cancel-job').classList.toggle('hidden',!running);
  $('cancel-job').disabled=job.status==='cancelling';
}
async function refreshState(){
  const previous=currentSong();const oldStatus=previous?.status,oldRun=previous?.active_run,oldSettings=JSON.stringify(model.state?.settings);
  model.state=await api('/api/state');chordModelPanel.update(model.state.chord_model);modelsPanel.update(model.state.models);renderLibrary();renderControls();renderJob();renderLock();await refreshSeparation();
  if(oldSettings!==JSON.stringify(model.state.settings)&&currentRecord()){
    if(currentRecord().doc.kind==='chart')refreshChartMusic();else if(currentRecord().doc.kind==='abc')renderAbc();
  }
  const song=currentSong();if(song&&(song.status!==oldStatus || song.active_run!==oldRun || model.state.job?.kind!=='separation' && model.state.job?.song_id===song.id && isJobActive(model.state.job)))await refreshSongDetail(song.id,false);
}
async function selectSong(id){
  if(id===model.song){if(model.view!=='song'){model.view='song';renderLibrary();}return;}
  if(!practiceView.canNavigate())return;
  const request=++model.loadingSong;
  try{const saved=await window.chordBuddyFlush();if(!saved.ok)throw Error('Finish saving before changing the selected song or document.');}catch(error){showError(error);return;}
  if(request!==model.loadingSong)return;
  prefs.set('cb-last-song',id);                       // opened again next time the app starts
  model.view='song';renderView();
  playbackGate.block('Checking analysis.');player.setWaveformRun(null);practiceViewport=null;practiceData=null;player.setPractice({music:{measures:[]},projection:null,viewport:null});separationDetail=null;model.readinessChecked=false;model.song=id;model.detail=null;model.document=null;
  clearError();renderLibrary();renderControls();renderDocument();renderLock();
  await transport.loadSong({songId:id,originalUrl:mediaUrl('/api/audio/'+encodeURIComponent(id)),separation:null});player.setNow({chord:'—',next:''});await refreshSeparation();if(request!==model.loadingSong)return;
  try{const detail=await api(`/api/song/${encodeURIComponent(id)}`);if(request!==model.loadingSong)return;model.detail=detail;renderTabs();loadMelody(detail,id);loadModelKey(detail,id);if(shownDocs(detail).length)await selectDocument(shownDocs(detail)[0].id);else renderDocument();showSongError(detail.song,true);}catch(error){if(request===model.loadingSong)showError(error);}
}
// The vocal melody (a MIDI output of the analysis): its notes are drawn faintly behind the Time tool's bars, and their starts are
// the first guess for where words fall.
async function loadMelody(detail,songId){
  const doc=detail.documents.find(item=>item.kind==='midi'&&/(^|\/)melody_vocal\.mid$/.test(item.name));
  if(!doc){model.melody={song:songId,doc:null,onsets:[],notes:[]};return;}
  if(model.melody?.song===songId&&model.melody.doc===doc.id)return;
  try{
    const full=await api('/api/document/'+encodeURIComponent(doc.id));if(model.song!==songId)return;
    const notes=(full.content?.notes||[]).filter(n=>Number.isFinite(n.start)&&Number.isFinite(n.end)&&Number.isFinite(n.pitch)).map(n=>({start:n.start,end:n.end,pitch:n.pitch}));
    model.melody={song:songId,doc:doc.id,onsets:onsetsFromNotes(notes),notes};renderChart();
  }catch{model.melody={song:songId,doc:doc.id,onsets:[],notes:[]};}
}
// Reloading a document empties the page for a moment, which would send the desk back to the top; put it back where it was.
async function keepDeskPlace(fn){
  const desk=$('desk'),top=desk?.scrollTop||0,left=desk?.scrollLeft||0;
  try{await fn();}finally{if(desk&&(top||left))desk.scrollTo({top,left,behavior:'instant'});}
}
// A song's own analysis error stands in the alert while it is true, and comes down as soon as an analysis of the song succeeds.
let songErrorAlert=null;
function showSongError(song,opened=false){
  const text=song?.error?analysisErrorMessage(song.error,!!song.active_run):null;
  if(text&&(opened||text!==songErrorAlert)){songErrorAlert=text;showError(text);}
  else if(!text&&songErrorAlert!==null){if($('alert').textContent===songErrorAlert)clearError();songErrorAlert=null;}
}
async function refreshSongDetail(id,force=false){
  const detail=await api(`/api/song/${encodeURIComponent(id)}`);if(model.song!==id)return;model.detail=detail;showSongError(detail.song);renderTabs();loadMelody(detail,id);loadModelKey(detail,id);
  if(!model.document && shownDocs(detail).length)await selectDocument(shownDocs(detail)[0].id);
  else if(model.document && shownDocs(detail).length && !detail.documents.some(doc=>doc.id===model.document) && !currentRecord()?.dirty && !currentRecord()?.saving)await selectDocument(shownDocs(detail)[0].id);
  else if(force && model.document&&!practiceView.hasDraft()){const record=currentRecord();if(!record?.dirty&&!record?.saving){await keepDeskPlace(async()=>{model.documents.delete(model.document);await selectDocument(model.document);});}}
}
// Chart, Lead sheet and MIDI are the three views. Everything else the model writes (beats, chords, tokens...) is not shown: it comes in a zip.
const TAB_KINDS=[['chart','Chart'],['abc','Lead sheet'],['midi','MIDI']];
const shownDocs=detail=>detail.documents.filter(doc=>TAB_KINDS.some(([kind])=>kind===doc.kind)).sort((a,b)=>(b.kept?1:0)-(a.kept?1:0));
function renderTabs(){
  const tabs=$('document-tabs');tabs.replaceChildren();
  $('transcription-history').disabled=isJobActive(model.state?.job)||!model.detail?.runs.some(r=>r.id!==currentSong()?.active_run&&r.has_documents);
  renderExportMenu();
  const docs=model.detail?.documents||[],selected=docs.find(doc=>doc.id===model.document);
  for(const [kind,label] of TAB_KINDS){
    const list=docs.filter(doc=>doc.kind===kind);if(!list.length)continue;
    const target=selected?.kind===kind?selected:list.find(doc=>doc.kept)||list.find(doc=>doc.name==='transcription.mid')||list.find(doc=>/melody\.mid$/.test(doc.name))||list[0];
    const button=element('button',`document-tab${selected?.kind===kind?' selected':''}`,label+(kind==='chart'&&target.kept?' · kept edits':''));
    button.role='tab';button.setAttribute('aria-selected',selected?.kind===kind?'true':'false');button.title=target.name;button.onclick=()=>selectDocument(target.id);tabs.append(button);
  }
}
async function selectDocument(id){
  if(id===model.document && model.documents.has(id))return;
  if(!practiceView.canNavigate())return;
  if(id!==model.document){try{const saved=await window.chordBuddyFlush();if(!saved.ok)throw Error('Finish saving before changing the selected song or document.');}catch(error){showError(error);return;}}
  model.document=id;model.chartSection=null;model.chartChord=null;renderTabs();renderDocument();
  if(!model.documents.has(id)){try{const doc=await api(`/api/document/${encodeURIComponent(id)}`);model.documents.set(id,{doc,draft:clone(doc.content),dirty:false,saving:false,error:null,version:0,timer:null});}catch(error){showError(error);}}
  if(model.document===id){renderDocument();if(currentRecord()?.doc.kind==='chart')renderChart();}
}
function renderSaveStatus(){const record=currentRecord();const status=$('save-status');const warning=record?.doc.export_warning;status.classList.toggle('error',!!record?.practiceSaveError || !!record?.error || !!warning);status.textContent=record?.practiceSaveError?'Chart Save failed — use Retry Save':record?.doc.kind==='chart'&&practiceView.hasDraft()&&!record.saving?'Line draft — Save or Cancel':record?.error?'Save failed · click to retry':model.pendingChord||model.pendingChart?'Unsaved fields':record?.saving?'Saving…':record?.dirty?'Unsaved changes':record?.exporting?'Saved - retrying export...':warning?'Saved - click to retry export':'Saved';status.classList.toggle('quiet',['Saved','Saving…'].includes(status.textContent));status.title=record?.error?.message || warning || '';status.tabIndex=(record?.error||warning)&&!record?.exporting?0:-1;}
function markRawDraft(key,value=true){model[key]=value;renderSaveStatus();$('undo').disabled=true;$('redo').disabled=true;$('restore').disabled=true;$('download').classList.add('disabled');}
function renderDocument(){
  // only the editors not being shown are hidden: hiding the one on screen, even for a moment, empties the desk and scrolls it to the top
  const record=currentRecord(),showing={chart:'chart-editor',abc:'abc-editor',midi:'midi-editor'}[record?.doc.kind];
  for(const id of ['abc-editor','midi-editor','chart-editor'])if(id!==showing)$(id).classList.add('hidden');$('document-empty').classList.toggle('hidden',!!record);
  const rawPending=!!model.pendingChart||(record?.doc.kind==='chart'&&practiceView.hasDraft());
  $('undo').disabled=!record?.doc.can_undo||!!record?.dirty||!!record?.saving||rawPending;$('redo').disabled=!record?.doc.can_redo||!!record?.dirty||!!record?.saving||rawPending;$('restore').disabled=!record||!!record?.dirty||!!record?.saving||rawPending;
  $('undo').dataset.tip=record?.doc.undo_label?'Undo: '+record.doc.undo_label+'.':'Undo the last change.';$('redo').dataset.tip=record?.doc.redo_label?'Redo: '+record.doc.redo_label+'.':'Put back what you just undid.';
  $('download').classList.toggle('disabled',!record||record.dirty||record.saving||rawPending);if(record){$('download').href=mediaUrl(`/api/export/${encodeURIComponent(record.doc.id)}`);$('download').setAttribute('download','');}else $('download').removeAttribute('href');
  renderSaveStatus();renderTabs();renderPageHead();renderChips();syncModeUi();
  if(!record)return;
  if(record.doc.kind==='chart'){$('chart-editor').classList.remove('hidden');renderChart();}
  else if(record.doc.kind==='abc'){$('abc-editor').classList.remove('hidden');renderAbc();}
  else if(record.doc.kind==='midi'){$('midi-editor').classList.remove('hidden');renderMidi();}
}
// The song's chart: the one on screen, else the one with kept edits (a new analysis adds a blank chart beside it), as the Chart tab picks.
function chartDoc(){const charts=(model.detail?.documents||[]).filter(doc=>doc.kind==='chart');return charts.find(doc=>doc.id===model.document)||charts.find(doc=>doc.kept)||charts[0]||null;}
function chartRecord(){const id=chartDoc()?.id;return id?model.documents.get(id):null;}
async function loadChartRecord(){
  const id=chartDoc()?.id;if(!id||model.documents.has(id))return;
  try{const doc=await api(`/api/document/${encodeURIComponent(id)}`);if(!model.documents.has(id))model.documents.set(id,{doc,draft:clone(doc.content),dirty:false,saving:false,error:null,version:0,timer:null});}catch(error){showError(error);}
}
function renderAbc(){
  const content=currentContent();$('chord-strip').replaceChildren();
  // The lead sheet shows (and edits) the same lyrics as the chart, so it needs the chart document too.
  const chart=chartRecord();
  if(!chart)loadChartRecord().then(()=>{if(currentRecord()?.doc.kind==='abc')renderAbc();});
  const song=currentSong(),record=currentRecord();
  if(document.activeElement!==$('score-title'))$('score-title').textContent=song?.title||'';
  setSub($('score-sub'),[record.doc.music?.timing?.bpm?`♩ = ${Math.round(record.doc.music.timing.bpm)}`:null,'arranged in Chord Buddy']);
  paintMeter($('score-meter'));
  setKeySpelling(songKey().label);
  leadView=renderLeadSheet($('score'),{key:model.document,musicKey:songKey().label,content:{...content,abc:spellAbc(content.abc,content.chords)},music:record.doc.music,getMeter:()=>songMeter().meter,title:song?.title,artist:song?.artist,settings:model.state.settings,
    dock:$('tool-rail'),note:$('tool-note'),status:$('tool-status'),frozen:readFrozen(song?.id),
    onSeek:seconds=>transport.seek(seconds),onExternal:sendToExternalEditor,
    onFreeze:snapshot=>{writeFrozen(song.id,snapshot);renderAbc();},onUnfreeze:()=>{writeFrozen(song.id,null);renderAbc();},
    chart:chart?{content:chart.draft||chart.doc.content,music:chart.doc.music,documentId:chart.doc.id,revision:chart.doc.revision}:null,
    onChange:(next,label)=>markEdit(next,label),onChord:commitChordLabel,onError:showError,onChartEdit:commitChartFromLeadSheet});
  updatePlayback();
}
// The lead sheet can be handed to another program (MuseScore and the like). From then on it is a frozen copy of what the chord chart said when
// it was sent: it keeps showing that, and nothing in Chord Buddy edits it, until you choose to follow the chord chart again.
let leadView=null;
const readFrozen=songId=>{if(!songId)return null;try{const value=JSON.parse(prefs.get('cb-frozen:'+songId,'null'));return value&&Array.isArray(value.lyrics)?value:null;}catch{return null;}};
const writeFrozen=(songId,value)=>prefs.set('cb-frozen:'+songId,value?JSON.stringify(value):'null');
async function sendToExternalEditor({xml,filename}){
  const song=currentSong();if(!song)throw new Error('Choose a song first.');
  return api('/api/lead-sheet/external',{song_id:song.id,filename,xml});
}
// Lyrics typed on the lead sheet are edits to the chart's lyrics, so they are saved to the chart document and both views show them.
async function commitChartFromLeadSheet(next,label,expected){
  const r=chartRecord();if(!r)throw Error('The chart is not loaded yet. Try again in a moment.');
  next=reconcileCompactPreferences(next,r.doc.music).content;const invalid=validateChart(next);if(invalid)throw Error(invalid);
  const pending=commitPracticeDocument(r,next,label,expected,api);renderSaveStatus();
  try{await pending;if(r.doc.export_warning)showError(r.doc.export_warning);}
  finally{if(currentRecord()?.doc.kind==='abc')renderAbc();}
}
// A chord typed on the lead sheet goes to the chord chart, where the lead sheet's chords come from. (A frozen copy is never edited; a lead
// sheet whose chart has not loaded yet saves it to itself and confirms it, as the old Apply button did.)
async function commitChordLabel(id,text){
  const chart=chartRecord(),typed=String(text||'').trim();
  if(chart&&!readFrozen(currentSong()?.id)){
    const content=chart.draft||chart.doc.content,old=content.chords.find(c=>c.id===id);
    if(!old||!typed||typed===old.label)return;
    const result=planChartChordEdit(content,chart.doc.music,{chordId:id,label:typed});
    if(result.conflicts.length)throw Error(result.conflicts[0].message);
    await commitChartFromLeadSheet(result.candidate,'Correct chord label',{documentId:chart.doc.id,revision:chart.doc.revision});return;
  }
  const chord=currentContent()?.chords?.find(item=>item.id===id),label=String(text||'').trim();
  if(!chord||!label||label===chord.label)return;
  markEdit(editChordContent(currentContent(),id,label),'Correct chord label');
  renderAbc();
  const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving the chord edit before confirming it.');
  await confirmChordOverride({...chord,label},label,chord.start,chord.end);
  renderDocument();
}
function markEdit(content,label,delay=450){const record=currentRecord();if(!record)return;record.draft=content;record.dirty=true;record.error=null;record.version++;record.label=label;clearTimeout(record.timer);record.timer=setTimeout(()=>saveDocument(record.doc.id),delay);renderSaveStatus();$('undo').disabled=true;$('redo').disabled=true;$('restore').disabled=true;$('download').classList.add('disabled');}
async function saveDocument(id){
  const record=model.documents.get(id);if(!record||!record.dirty||record.saving)return;
  clearTimeout(record.timer);record.saving=true;record.error=null;const version=record.version;const content=clone(record.draft);renderSaveStatus();
  try{const doc=await api(`/api/document/${encodeURIComponent(id)}`,{content,label:record.label || 'Edit document',revision:record.doc.revision});record.doc=doc;if(record.version===version){record.draft=clone(doc.content);record.dirty=false;}record.error=null;if(doc.export_warning)showError(doc.export_warning);if(doc.engraving_warning)showError(doc.engraving_warning);}
  catch(error){record.error=error;showError(error.status===409?new Error('This document changed in another window. Your edits are kept here. Reopen the app to load that revision, or retry after resolving the other window.'):error);}
  finally{record.saving=false;if(model.document===id){renderSaveStatus();if(!record.dirty)renderDocument();}if(record.dirty&&!record.error)setTimeout(()=>saveDocument(id),100);}
}
// The piano roll is a viewer. Its view settings (hidden tracks, zoom) are kept per document, so playback redraws never reset them.
let midiRoll=null;const midiView={doc:null,hidden:new Set(),view:null};   // the roll's own view: tracks shown, and its time and pitch scales (remembered per song by the roll)
function renderMidi(){
  const record=currentRecord(),song=currentSong(),content=currentContent();
  if(midiView.doc!==record.doc.id){Object.assign(midiView,{doc:record.doc.id,hidden:new Set(),view:null});}
  const chart=chartRecord();if(!chart)loadChartRecord().then(()=>{if(currentRecord()?.doc.kind==='midi')renderMidi();});
  const offset=practiceView.getModel()?.barOffset||0;      // silence before the music is not a bar: numbering starts at the first bar with music
  const bars=chart?effectiveMeasures(chart.doc.music,chart.doc.content?.layout).map(m=>({start:m.start,end:m.end,number:m.number-offset,beats:m.beats||[]})):[];
  if(document.activeElement!==$('midi-title'))$('midi-title').textContent=song?.title||'';
  renderKeyBoxes();
  midiRoll=renderMidiRoll($('roll'),midiView,{songId:song?.id,content,bars,sections:chart?.doc.content?.sections||[],seconds:transport.getSnapshot().seconds,dock:$('tool-rail'),note:$('tool-note'),status:$('tool-status'),
    onSeek:seconds=>transport.seek(seconds),onExternal:()=>api('/api/midi/external',{song_id:model.song,document_id:record.doc.id}),onError:showError});
  setSub($('midi-sub'),[]);
  updatePlayback();
}
function renderChart(){
 const r=currentRecord();if(r?.doc.kind!=='chart')return;
 const content=currentContent(),music=r.doc.music;
 practiceData={content,music};
 if(!practiceViewport)practiceViewport={start:0,end:content.duration,follow:true};      // the whole song, fully zoomed out
 const onsets=model.melody?.song===model.song?model.melody.onsets:null,hasMelody=!!onsets?.length;
 $('suggest').disabled=!hasMelody;$('suggest').checked=hasMelody&&prefs.get('cb-suggest','1')!=='0';
 $('suggest-wrap').classList.toggle('off',!hasMelody);$('suggest-wrap').title=hasMelody?'Shows the sung melody faintly behind the bars, and places words you have not pinned on its notes as a first guess. Drag a word to pin it.':'No vocal melody was found for this song.';
 practiceView.showTools();
 setKeySpelling(songKey().label);practiceView.update({key:songKey().label,documentId:r.doc.id,revision:r.doc.revision,songId:model.song,content,music,transport:transport.getSnapshot(),viewport:practiceViewport,onsets,waveform:model.waveform?.song===model.song?model.waveform:null,suggest:$('suggest').checked,melody:$('suggest').checked&&model.melody?.song===model.song?model.melody.notes:null});
 updatePracticePlayer();
}
async function confirmChordOverride(chord,label,start,end){
  const metadata=model.detail?.metadata||{revision:0,timing:{constant_tempo:false,bpm:null},chord_overrides:[]};
  await api('/api/confirm-chord',{song_id:model.song,id:chord.id,start:Number(start),end:Number(end),label,revision:metadata.revision});
  await keepDeskPlace(()=>refreshSongDetail(model.song,true));
}
function refreshChartMusic(){try{renderChart();}catch(e){showError(e);}}
function nowAndNext(chords,chord,time){
  const label=c=>c&&!isNoChordLabel(c.label)?spellChord(displayChordLabel(c.label)):'';
  const current=label(chord);
  const upcoming=[...chords].filter(c=>c.start>time&&label(c)&&label(c)!==current).sort((a,b)=>a.start-b.start)[0];
  return {chord:current||'—',next:label(upcoming)};
}
function updatePlayback(){
  const time=transport.getSnapshot().seconds;const chord=activeChord(currentChords(),time);player.setNow(nowAndNext(currentChords(),chord,time));
  for(const chip of $('chord-strip').children)chip.classList.toggle('active',chip.dataset.chordId===chord?.id);
  if(currentRecord()?.doc.kind==='abc'){
    markCurrentChord($('score'),chord&&Number.isInteger(chord.abc_index)?leadView?.chordNodeAt(chord.abc_index):null);
    const snap=transport.getSnapshot();
    if(snap.playIntent&&practiceViewport?.follow!==false)followPlayback($('score'));
  }
  if(currentRecord()?.doc.kind==='midi')midiRoll?.update(time,transport.getSnapshot().playIntent);
  if(currentRecord()?.doc.kind==='chart')practiceView.updatePlayback(transport.getSnapshot());
  else if(currentRecord()?.doc.kind==='abc'){updateLeadSheetPlayback($('score'),$('score').querySelector('.lead-notation')?$('score').querySelector('.lead-notation')._scoreTiming:$('score')._scoreTiming,time);}
  if(practiceData&&practiceViewport?.follow)updatePracticeViewport({type:'tick'});
}
async function historyAction(action){
  const record=currentRecord();if(!record||record.dirty||record.saving||model.pendingChart||practiceView.hasDraft())return;
  const id=record.doc.id,version=record.version;record.saving=true;record.historyPending=true;$('workspace').inert=true;renderDocument();
  try{const doc=await api(`/api/document/${encodeURIComponent(id)}/${action}`,{revision:record.doc.revision});settleHistoryResult(record,doc,version);if(model.document===id&&!record.dirty){model.chartSection=null;model.chartChord=null;}}
  catch(error){showError(error);}
  finally{record.saving=false;record.historyPending=false;$('workspace').inert=false;if(model.document===id){renderSaveStatus();if(!record.dirty)renderDocument();}if(record.dirty&&!record.error)setTimeout(()=>saveDocument(id),0);}
}
async function updateTitle(){
  if(model.titleSave){await model.titleSave;if(!model.pendingTitle)return;}
  const song=currentSong();if(!song)return;const title=$('song-title').value.trim();if(!title)throw new Error('Give your song a title before continuing.');
  if(title===song.title){model.pendingTitle=false;return;}
  const songId=song.id;model.titleSave=api('/api/song',{id:songId,title});
  try{const changed=await model.titleSave;const latest=model.state?.songs.find(item=>item.id===songId);if(latest)Object.assign(latest,changed);if(model.song===songId){model.pendingTitle=$('song-title').value.trim()!==title;renderPageHead();}renderLibrary();}
  finally{model.titleSave=null;}
}
async function commitUiDrafts(){if(model.pendingTitle||model.titleSave)await updateTitle();}
// Straight after an import: the song's name and artist (read from the file's tags, so usually right already) and whether to split the stems.
async function setupImportedSong(song){
 const setup=await askSongSetup({title:song.title,artist:song.artist,stems:wantsStems(),stemsHint:stemsHint(),device:model.state?.settings?.device||'auto',gpu:!!model.state?.engine?.gpu});
 if(!setup)return;
 prefs.set('cb-stems',setup.stems?'1':'0');
 await api('/api/song',{id:song.id,title:setup.title,artist:setup.artist});
 if(setup.device&&setup.device!==model.state?.settings?.device)model.state.settings=await api('/api/settings',{device:setup.device});   // kept for every later analysis too
 await refreshState();
 if(!model.state.engine.ready){showError(model.state.engine.message||'Set up the transcription engine first.');return;}
 await startAnalysis(song.id,[],setup.stems);
}
async function importFile(file){
  if(!file)return;if(/\.zip$/i.test(file.name))return importSongZip(file);
  if(!/\.mp3$/i.test(file.name)){showError('Choose an MP3 recording, or a song zip exported from Chord Buddy.');return;}if(file.size>250*1024*1024){showError('This recording is larger than the 250 MB import limit.');return;}
  if(model.importing)return;model.importing=true;$('import-button').disabled=true;$('import-button').querySelector('em').textContent='Importing…';clearError();
  let added=null;
  try{const bytes=await file.arrayBuffer();const song=await api(`/api/import?filename=${encodeURIComponent(file.name)}&setlist=${encodeURIComponent(model.setlist || '')}`,undefined,{method:'POST',headers:{'Content-Type':'audio/mpeg'},body:bytes});await refreshState();await selectSong(song.id);added=song;}
  catch(error){showError(error);}finally{model.importing=false;$('import-button').disabled=false;$('import-button').querySelector('em').textContent='Import';$('file-input').value='';renderControls();}
  if(added)setupImportedSong(added).catch(showError);
}
// A song exported from another computer (Export → Whole song): it is added, or, when a song here has the same title, you choose what
// to overwrite or import it as a new song. The zip can be gigabytes with stems, so it is sent as the file itself, never read into memory here.
async function importSongZip(file){
  if(model.importing)return;model.importing=true;$('import-button').disabled=true;$('import-button').querySelector('em').textContent='Importing…';clearError();
  let left=null;
  try{
    const summary=await api('/api/song-import',undefined,{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
    let choice={mode:'new'};
    if(summary.matches.length){
      choice=await askSongImport({title:summary.matches[0].title,matches:summary.matches,incoming:summary});
      if(!choice){await api('/api/song-import/cancel',{token:summary.token});return;}
    }
    // Updating the open song: let go of it first, so its stems are not playing while they are replaced.
    if(choice.mode==='update'&&choice.target===model.song){
      const flushed=await window.chordBuddyFlush();if(!flushed.ok){await api('/api/song-import/cancel',{token:summary.token});throw new Error('Finish saving your edits first.');}
      left=model.song;await leaveSong();
    }
    const result=await api('/api/song-import/apply',{token:summary.token,...choice,setlist:model.setlist||'default'});
    await refreshState();await selectSong(result.song_id);
    if(result.warning)showError(result.warning);
  }catch(error){showError(error);if(left&&!model.song)selectSong(left).catch(()=>{});}
  finally{model.importing=false;$('import-button').disabled=false;$('import-button').querySelector('em').textContent='Import';$('file-input').value='';renderControls();}
}
$('import-button').onclick=$('empty-import').onclick=()=>$('file-input').click();$('file-input').onchange=()=>importFile($('file-input').files[0]);
$('all-songs').onclick=showAllSongs;
$('new-setlist').onclick=()=>{$('setlist-form').classList.toggle('hidden');if(!$('setlist-form').classList.contains('hidden'))$('setlist-name').focus();};
$('setlist-form').onsubmit=async event=>{event.preventDefault();try{const name=$('setlist-name').value.trim();if(!name)return;const list=await api('/api/setlist',{name});model.setlist=list.id;$('setlist-name').value='';$('setlist-form').classList.add('hidden');await refreshState();}catch(error){showError(error);}};
$('song-search').oninput=renderLibrary;
let titleTimer=null;
$('song-title').oninput=()=>{model.pendingTitle=$('song-title').value.trim()!==currentSong()?.title;clearTimeout(titleTimer);titleTimer=setTimeout(()=>updateTitle().catch(showError),600);};
$('song-title').onchange=()=>{clearTimeout(titleTimer);updateTitle().catch(showError);};
// The title is written in the chart's own header (a heading you can type in); the hidden field carries it to the saving code above.
for(const id of TITLE_NODES){
  const node=$(id);
  node.oninput=()=>{$('song-title').value=node.textContent.replace(/\s+/g,' ').trim();$('song-title').oninput();};
  node.onblur=()=>{if($('song-title').value||!currentSong())$('song-title').onchange();else node.textContent=currentSong().title;};
  node.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();event.target.blur();}else if(event.key==='Escape'){event.target.textContent=currentSong()?.title||'';$('song-title').value=currentSong()?.title||'';event.target.blur();}};
}

$('model-attribution').onclick=()=>openModelAttribution(model.state?.engine?.model,model.state?.models?.models||[]);
$('song-timing').onclick=async()=>{$('more-menu').open=false;try{await commitUiDrafts();const record=currentRecord();if(record?.doc.kind!=='chart')throw new Error('Choose a Song chart for timing controls.');const id=record.doc.id;openSongTiming({metadata:{timing:record.doc.timing_binding.overrides},onSave:async metadata=>{if(model.document!==id)throw new Error('Selected chart changed.');await window.chordBuddyFlush();const fresh=currentRecord().doc;await api('/api/documents/'+id+'/timing',{timing:metadata.timing,revision:fresh.revision});await refreshSongDetail(model.song,true);renderDocument();}});}catch(error){showError(error);}};
$('transcription-history').onclick=async()=>{
  const songId=model.song;
  try{const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits before opening a previous transcription.');
    await refreshSongDetail(songId);if(model.song!==songId)return;
    openReprocess({hasEdits:false,runs:model.detail.runs,activeRun:currentSong().active_run,canRun:false,onRestore:async runId=>{await api('/api/activate-run',{song_id:songId,run_id:runId});await refreshState();await refreshSongDetail(songId);}});
  }catch(error){showError(error);}
};
// ---- Export: saving and exporting live in one menu, in the same place in every view ----
function renderExportMenu(){
  const docs=model.detail?.documents||[],song=currentSong();
  const has={ 'pdf-chart':docs.some(d=>d.kind==='chart'),'pdf-lead':docs.some(d=>d.kind==='abc'),midi:docs.some(d=>d.kind==='midi'),'midi-tracks':docs.some(d=>d.kind==='midi'),outputs:!!song?.active_run,song:!!song };
  for(const button of document.querySelectorAll('[data-export]'))button.disabled=!has[button.dataset.export];
  $('export-button').classList.toggle('disabled',!song);
}
const downloadUrl=url=>{const link=document.createElement('a');link.href=url;link.download='';document.body.append(link);link.click();link.remove();};
async function runExport(kind){
  const song=currentSong();if(!song)return;
  const docs=model.detail?.documents||[],midi=docs.find(d=>d.kind==='midi'&&d.name==='transcription.mid')||docs.find(d=>d.kind==='midi');
  if(kind==='pdf-chart')return exportPdf('chart');
  if(kind==='pdf-lead')return exportPdf('lead');
  if(kind==='midi'||kind==='midi-tracks'){if(!midi)throw new Error('This song has no MIDI yet.');return downloadUrl(mediaUrl('/api/export-midi/'+encodeURIComponent(midi.id))+'&mode='+(kind==='midi'?'single':'tracks'));}
  if(kind==='outputs')return downloadUrl(mediaUrl('/api/export-outputs/'+encodeURIComponent(song.id)));
  if(kind==='song')return exportSong(song);
}
const sizeLabel=bytes=>bytes>=1e9?(bytes/1e9).toFixed(1)+' GB':Math.max(1,Math.round(bytes/1e6))+' MB';
// The whole song in one zip named after it (recording, analysis, every edit), for Import on another computer. Stems are most of the
// size, so they are only included when asked for.
async function exportSong(song){
  const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits first.');
  const info=await api('/api/song-export/info',{song_id:song.id});
  let stems=false;
  if(info.stems_bytes){
    stems=prefs.get('cb-export-stems','0')==='1';
    const answer=await askChoice({title:'Export “'+song.title+'”',message:['One zip with the recording, the analysis and every edit, ready to import on another computer.'],
      checkbox:{label:'Include the stems',hint:'Adds about '+sizeLabel(info.stems_bytes)+'. Without them the zip is about '+sizeLabel(info.bytes)+', and the stems can be split again on the other computer.',checked:stems,onChange:value=>{stems=value;}},
      choices:[{id:'export',label:'Export',kind:'primary'}]});
    if(answer!=='export')return;
    prefs.set('cb-export-stems',stems?'1':'0');
  }
  downloadUrl(mediaUrl('/api/song-export/'+encodeURIComponent(song.id))+'&stems='+(stems?1:0));
}
for(const button of document.querySelectorAll('[data-export]'))button.onclick=()=>{$('export-menu').open=false;runExport(button.dataset.export).catch(showError);};

// Export PDF: print only the page that is showing, the lead sheet or the chart (print rules live in shell.css). The page is drawn in light
// colours, without tool hints, whichever look is on screen.
const exportChartPdf=()=>exportPdf(currentRecord()?.doc.kind==='abc'?'lead':'chart');
async function exportPdf(which){
 try{
  if(which==='lead'){
   const lead=model.detail?.documents.find(doc=>doc.kind==='abc');if(!lead)throw new Error('This song has no lead sheet to export yet.');
   await loadChartRecord();                                                 // the words come from the chart
   if(currentRecord()?.doc.kind!=='abc'||model.document!==lead.id)await selectDocument(lead.id);
   if(currentRecord()?.doc.kind!=='abc'||!leadView)return;
   await new Promise(resolve=>setTimeout(resolve,150));
   leadView.printMode(true);
   try{await new Promise(resolve=>setTimeout(resolve,80));window.print();}finally{leadView.printMode(false);}
   return;
  }
  const chart=chartDoc();if(!chart)throw new Error('This song has no chart to export yet.');
  if(currentRecord()?.doc.kind!=='chart'||model.document!==chart.id)await selectDocument(chart.id);
  if(currentRecord()?.doc.kind!=='chart')return;
  practiceView.setMode('nav');await new Promise(resolve=>setTimeout(resolve,60));window.print();
 }catch(error){showError(error);}
}
document.addEventListener('chordbuddy:export-pdf',exportChartPdf);
// Analyze again always runs the analysis afresh (it does not just reuse what was saved), so it can be rerun at any time. If the song has
// edits, you choose: keep them (your edited chart and lead sheet stay in front; the fresh result fills in everything you have not
// changed) or start over (the fresh chart and lead sheet are shown; the edited ones stay under Previous transcriptions).
async function confirmReanalyze(song){
 const hasStems=!!separationDetail?.active,edited=(model.detail?.documents||[]).some(d=>d.user_modified);
 let policy='keep',resplit=hasStems?false:wantsStems();
 const answer=await askChoice({title:'Analyze “'+song.title+'” again?',
  message:['Chord Buddy works out the chords, melody and sections again from the recording, fresh, instead of reusing the last result.'],
  radios:edited?{label:'Your edits',value:'keep',onChange:value=>{policy=value;},options:[
   {id:'keep',label:'Keep my edits',hint:'Your edited chart and lead sheet stay as they are. The new analysis is used for everything else.'},
   {id:'replace',label:'Start over',hint:'Show the new chart and lead sheet instead. Your edited versions are kept under Previous transcriptions in the ⋯ menu, so you can bring them back.'}]}:null,
  checkbox:hasStems?{label:'Split the stems again',hint:'Only needed if the stems sound wrong. It takes several minutes.',checked:false,onChange:value=>{resplit=value;},warning:fastStems()?'':CPU_STEMS_WARNING}
   :{label:'Also split the stems',hint:stemsHint(),checked:resplit,onChange:value=>{resplit=value;prefs.set('cb-stems',value?'1':'0');},warning:fastStems()?'':CPU_STEMS_WARNING},
  choices:[{id:'export',label:'Export current chart as PDF',keepOpen:true},{id:'analyze',label:'Analyze again',kind:'primary'}],onPick:()=>exportChartPdf()});
 if(answer!=='analyze')return null;
 return {editPolicy:policy,stems:hasStems||resplit,invalidate:['transcription',...(hasStems&&resplit?['separation']:[])]};
}
$('transcribe').onclick=async()=>{
 const songId=model.song;
 try{
  const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits first.');if(model.song!==songId)return;
  const song=currentSong();let again=null;
  if(song?.active_run){again=await confirmReanalyze(song);if(!again)return;}
  if(model.song!==songId)return;
  if(again)await startAnalysis(songId,again.invalidate,again.stems,again.editPolicy);else await startAnalysis(songId);
 }catch(error){showError(error);}
};
$('banner-export').onclick=exportChartPdf;$('banner-reanalyze').onclick=()=>$('transcribe').click();

// No song open: the views are emptied and the player lets go of the recording and stems.
async function leaveSong(){
 model.song=null;model.detail=null;model.document=null;practiceData=null;practiceViewport=null;player.setWaveformRun(null);player.setPractice({music:{measures:[]},projection:null,viewport:null});
 await transport.loadSong({songId:null});
}
// Deleting a song: first to the Trash (hidden, nothing erased, restorable), then forever only from the Trash.
async function trashSong(id){
 try{
  const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits first.');
  const wasCurrent=model.song===id;await api('/api/song/trash',{id});await refreshState();
  if(wasCurrent){
   await leaveSong();const next=model.state.songs[0];
   if(next)await selectSong(next.id);else{renderLibrary();renderControls();renderDocument();renderLock();}
  }
 }catch(error){showError(error);}
}
$('delete-song').onclick=async()=>{
 $('more-menu').open=false;const song=currentSong();if(!song)return;
 const answer=await askChoice({title:'Delete “'+song.title+'”?',message:['It moves to the Trash. Nothing is erased yet: you can restore it, or delete it forever from the Trash.'],choices:[{id:'trash',label:'Move to Trash',kind:'danger'}]});
 if(answer==='trash')await trashSong(song.id);
};
$('trash-open').onclick=()=>openTrash({
 getItems:()=>model.state?.trash||[],
 onRestore:async item=>{try{await api('/api/song/restore',{id:item.id});await refreshState();}catch(error){showError(error);}},
 onPurge:async item=>{
  const answer=await askChoice({title:'Delete “'+item.title+'” forever?',message:['This permanently deletes the recording, its chart and every edit, and its stems from this computer.','It cannot be undone.'],choices:[{id:'purge',label:'Delete forever',kind:'danger'}]});
  if(answer!=='purge')return;
  try{const result=await api('/api/song/purge',{id:item.id});await refreshState();if(result.warning)showError(result.warning);}catch(error){showError(error);}
 },
});
$('lock-cta').onclick=()=>{const job=analysisJobFor(currentSong());(job&&isJobActive(job)?$('cancel-job'):$('transcribe')).click();};
$('cancel-job').onclick=async()=>{try{const job=model.state?.job;if(job&&!isJobActive(job)){model.dismissedJob=jobKey(job);renderJob();return;}const path=['analysis','rhythm'].includes(job?.kind)?'/api/analysis/'+job.id+'/cancel':job?.kind==='separation'?'/api/separation/cancel':'/api/cancel';await api(path,job?.kind==='separation'?{job_id:job.id}:{});await refreshState();}catch(error){showError(error);}};
$('song-folder').onclick=()=>api('/api/open-folder',{song_id:model.song}).catch(showError);
$('undo').onclick=()=>historyAction('undo');$('redo').onclick=()=>historyAction('redo');$('restore').onclick=async()=>{
 $('more-menu').open=false;const record=currentRecord();if(!record)return;
 const what=record.doc.kind==='abc'?'lead sheet':record.doc.kind==='midi'?'MIDI':'chart';
 const answer=await askChoice({title:'Restore the model-predicted '+what+'?',message:['This puts the '+what+' back exactly as Chord Buddy first made it, without your edits. Undo can still bring your edits back.'],
  choices:[{id:'restore',label:'Restore',kind:'primary'}]});
 if(answer==='restore')historyAction('restore');
};
$('save-status').onclick=()=>{const r=currentRecord();if(r?.error)saveDocument(model.document);else if(r?.doc.export_warning)retryDocumentExport(r,api,()=>{if(currentRecord()===r){renderSaveStatus();if(!r.exporting&&!r.doc.export_warning&&$('alert').textContent.startsWith('Edit saved;'))clearError();}});};$('save-status').onkeydown=event=>{if(event.key==='Enter')$('save-status').click();};
// Playback views subscribe to the transport; the audio element no longer owns chart time.
let dragDepth=0;window.addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').classList.remove('hidden');}});window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});window.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').classList.add('hidden');});window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').classList.add('hidden');importFile(event.dataTransfer.files[0]);});
window.chordBuddyHasPendingEdits=()=>practiceView.hasPendingSave()||!!document.querySelector('[data-edit-dialog]')||model.pendingTitle || !!model.titleSave || !!model.pendingChart || [...model.documents.values()].some(record=>record.dirty||record.saving||record.practiceSaveError);
window.addEventListener('beforeunload',event=>{if(window.chordBuddyHasPendingEdits()){event.preventDefault();event.returnValue='';}});
window.chordBuddyShowCloseError=message=>showError(message || 'Your edits could not finish saving. Keep this window open and retry the failed save before closing.');
window.chordBuddyFlush=async()=>{
    if(document.querySelector('[data-edit-dialog]:not([data-saving])'))return {ok:false,pending:[{id:model.document,error:'Finish or cancel the open chart editor before continuing.'}]};
  try{await commitUiDrafts();}catch(error){showError(error);return {ok:false,pending:[{id:model.document || model.song,error:error.message}]};}
  for(const record of model.documents.values())clearTimeout(record.timer);
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    const pending=[...model.documents.values()].filter(record=>record.dirty||record.saving||record.practiceSaveError);
    if(!pending.length)return {ok:true,pending:[]};
    await Promise.all(pending.filter(record=>!record.saving&&!record.error).map(record=>saveDocument(record.doc.id)));
    if(pending.some(record=>record.error||record.practiceSaveError))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return {ok:false,pending:[...model.documents.values()].filter(record=>record.dirty||record.saving||record.practiceSaveError).map(record=>({id:record.doc.id,error:record.practiceSaveError?.message || record.error?.message || 'An edit is still being saved.'}))};
};
async function boot(){try{await prefs.connect(values=>api('/api/prefs',values),()=>api('/api/prefs'));practiceView.setSnapping(prefs.get('cb-snap','1')!=='0');await refreshState();const last=prefs.get('cb-last-song',''),song=model.state.songs.find(s=>s.id===last)||model.state.songs[0];if(song)await selectSong(song.id);else showAllSongs();}catch(error){showError(error);$('engine-status').textContent='Could not connect to the local app';}}
boot();setInterval(async()=>{if(model.polling)return;model.polling=true;try{await refreshState();}catch(error){$('engine-status').textContent='Connection interrupted · reconnecting';}finally{model.polling=false;}},2500);
export {transport};

const proposalGuard=new ProposalGuard(()=>model.document);
const rhythmButton=element('button','text-button','Attempt timing correction w/drum track');rhythmButton.type='button';
const cleanupButton=element('button','secondary','Check empty end artifact');
rhythmButton.hidden=true;cleanupButton.hidden=true;$('song-timing').after(rhythmButton);$('more-tools').append(cleanupButton);
rhythmButton.addEventListener('click',()=>{$('more-menu').open=false;});
rhythmButton.onclick=async()=>{try{
 const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving edits first.');const doc=currentRecord()?.doc;if(doc?.kind!=='chart')throw new Error('Choose a Song chart.');const ticket=proposalGuard.begin();const job=model.state?.job;
 if(job?.kind!=='rhythm'||job.document_id!==doc.id||job.status!=='completed'||!job.proposal_id){await api('/api/documents/'+doc.id+'/rhythm/propose',{});await refreshState();return;}
 const getPreview=policy=>api('/api/documents/'+doc.id+'/rhythm/preview',{proposal_id:job.proposal_id,policy});
 const preview=await getPreview('preserve');if(!proposalGuard.valid(ticket))return;
 renderRhythmPreview({preview},{cancel:()=>proposalGuard.cancel(),preview:async policy=>{const next=await getPreview(policy);if(JSON.stringify(next.stamp)!==JSON.stringify(preview.stamp))throw new Error('Chart changed while the preview was open. Review a fresh preview before applying.');if(!proposalGuard.valid(ticket))throw new Error('Selected chart changed.');return next;},apply:async candidate=>{if(!proposalGuard.valid(ticket)||!proposalGuard.acquire())throw new Error('Preview is no longer current.');try{const saved=await window.chordBuddyFlush();if(!saved.ok)throw new Error('Finish saving edits first.');await api('/api/documents/'+doc.id+'/rhythm/apply',{preview_id:candidate.id,stamp:candidate.stamp,policy:candidate.policy});if(proposalGuard.valid(ticket)){await refreshSongDetail(model.song,true);renderDocument();}}finally{proposalGuard.release();}}});
 }catch(error){showError(error);}};
cleanupButton.onclick=async()=>{try{const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving edits first.');const id=model.document;if(currentRecord()?.doc.kind!=='chart')throw new Error('Choose a Song chart.');const preview=await api('/api/documents/'+id+'/cleanup/preview',{});if(model.document!==id)return;if(!preview.available)throw new Error(preview.reason||'No proven empty end artifact was found.');if(!confirm('Remove the proven empty end artifact? The preceding section keeps its name and contents. This can be undone.'))return;await api('/api/documents/'+id+'/cleanup/apply',{preview,revision:preview.stamp.document_revision});if(model.document===id){await refreshSongDetail(model.song,true);renderDocument();}}catch(error){showError(error);}};
