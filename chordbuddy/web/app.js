import {commitPracticeDocument} from './practice-save.js';
import {retryDocumentExport} from './export-retry.js';
import {reconcileCompactPreferences} from './compact-chart.js';
import {installTooltips} from './tooltips.js';
import {mountChartPage} from './chart-page.js';
import {ZOOM_LEVELS} from './timing-geometry.js';
import {askChoice,askSongSetup,openTrash} from './dialogs.js';
import {updateViewport} from './practice-timeline.js';
import {PlaybackGate} from './playback-ready.js';
import {analysisUiState,songStatusLabel,analysisErrorMessage,lockStepStates,lockJobFailed} from './analysis-view.js';
import {ProposalGuard,renderRhythmPreview} from './rhythm-view.js';
import {Transport} from './transport.js';
import {mountMixer} from './mixer-rack.js';
import {mountPlayer} from './player-view.js';
import {activeChord, editChordContent, isJobActive, jobProgress, validateChart, displayChordLabel, settleHistoryResult} from './editor.js';
import {renderLeadSheet,updateLeadSheetPlayback,markCurrentChord,followPlayback} from './lead-sheet.js';
import {renderMidiRoll} from './midi-view.js';
import {installPageNav,MIN_ZOOM as MIN_PAGE_ZOOM} from './page-nav.js';
import {openSongTiming,openReprocess,openModelAttribution} from './settings-view.js';
import {effectiveMeasures, isNoChordLabel} from './chart-layout.js';
import {icon} from './icons.js';
import {prefs} from './prefs.js';
import {estimateKey,KEY_CHOICES} from './key-estimate.js';
import {onsetsFromNotes} from './word-layout.js';
import {mountModelsPanel,mountChordModelPanel} from './models-view.js';
import {mountDeskBars,combinedZoom} from './desk-bars.js';

const $ = id => document.getElementById(id);
document.querySelector('.chart-intro h2')?.remove();
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const model = {state:null,setlist:null,song:null,detail:null,document:null,documents:new Map(),loadingSong:0,polling:false,importing:false,pendingTitle:false,titleSave:null,dragSong:null,chartSection:null,chartChord:null,pendingChart:null};
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
const wantsStems=()=>prefs.get('cb-stems','0')==='1';
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
 await api('/api/separate',{song_id:songId});await refreshState();
}
const mixer=mountMixer($('rack'),{transport,onError:showError,onSplit:()=>splitStems().catch(showError),exportTarget:()=>{const runId=separationDetail?.active?.run_id,song=currentSong();return runId&&song?{title:song.title||'Chord Buddy',url:(query,name)=>mediaUrl(`/api/mix-export/${encodeURIComponent(runId)}`)+`&${query}&name=${encodeURIComponent(name)}`}:null;}});

let practiceViewport=null,practiceData=null;
const player=mountPlayer($('player'),transport,showError,{onViewportChange:updatePracticeViewport,loadWaveform:run=>api('/api/waveform/'+encodeURIComponent(run))});
const practiceView=mountChartPage($('chart-sections'),{
 onSeek:seconds=>transport.seek(seconds),onCommit:commitPracticeEdit,onBarEdit:editBars,onError:showError,onReload:reloadPracticeChart,canEdit:()=>!currentRecord()?.practiceConflict&&!currentRecord()?.saving,
 onViewportChange:updatePracticeViewport,onRhythm:()=>rhythmButton.click(),onTimingSettings:()=>$('song-timing').click(),
 onDraftChange:info=>{const r=currentRecord();if(r&&!info.failed&&!info.saving)r.practiceSaveError=null;renderDocument();},
 onModeChange:()=>syncModeUi(),onToolChange:()=>syncModeUi(),onScopeChange:()=>syncModeUi(),onTimingChange:()=>syncModeUi(),
 dock:$('tool-rail'),note:$('tool-note'),status:$('tool-status'),
});
// There are no chart modes: the tool you hold (Navigate, Write, Cut, Join, Repeat, Time, Barlines) decides what a click means and how the chart is drawn.
// The page owns the tool; the rail and the N W S J R T B keys only ask it to change.
// The Time tool draws the chart on a beat grid wider than the desk: it gets cassette bars (scroll and zoom) instead of scroll bars.
// Pulling the bottom bar out past the smallest beat grid shrinks the page as well (to 50%), so a whole row can always be seen.
let pageNav=null;
const deskBars=mountDeskBars(document.querySelector('.stage'),$('desk'),combinedZoom(
 {get:()=>practiceView.getZoom(),set:value=>practiceView.setZoom(value),limits:[ZOOM_LEVELS[0],ZOOM_LEVELS.at(-1)]},
 {get:()=>pageNav?.getZoom()??1,set:value=>pageNav?.setZoom(value)},MIN_PAGE_ZOOM));
function syncModeUi(){
 const mode=practiceView.getMode(),workspace=$('workspace');
 workspace.dataset.mode=mode;workspace.dataset.tool=practiceView.getTool();workspace.dataset.kind=currentRecord()?.doc.kind||'';
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
 if(practiceView.getMode()==='timing'&&(event.key==='+'||event.key==='=')){event.preventDefault();practiceView.zoomBy(1);}
 else if(practiceView.getMode()==='timing'&&(event.key==='-'||event.key==='_')){event.preventDefault();practiceView.zoomBy(-1);}
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
document.addEventListener('keyup',event=>{if(spaceHandled&&(event.key===' '||event.code==='Space')){event.preventDefault();spaceHandled=false;}},true);
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
async function commitPracticeEdit(next,label,expected){
 const r=currentRecord();if(!r)throw Error('Choose a chart.');
 next=reconcileCompactPreferences(next,r.doc.music).content;const invalid=validateChart(next);if(invalid)throw Error(invalid);
 const pending=commitPracticeDocument(r,next,label,expected,api);renderSaveStatus();
 try{await pending;if(r.doc.export_warning)showError(r.doc.export_warning);}
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
function currentChords(){const record=currentRecord();return ['abc','chart'].includes(record?.doc.kind) ? currentContent()?.chords || [] : model.detail?.chords || [];}
function renderLibrary() {
  const state=model.state;if(!state)return;
  if(!state.setlists.some(list=>list.id===model.setlist))model.setlist=state.setlists[0]?.id;
  const nav=$('setlists');nav.replaceChildren();
  for(const list of state.setlists){const button=element('button',`setlist-item${list.id===model.setlist?' selected':''}`);const listIcon=element('span','setlist-icon');listIcon.innerHTML=icon('list');button.append(listIcon,element('span','',list.name),element('span','setlist-count',list.song_ids.length));button.onclick=()=>{model.setlist=list.id;renderLibrary();};nav.append(button);}
  const list=state.setlists.find(item=>item.id===model.setlist);
  $('library-heading').textContent=list?.name==='Default'?'ALL SONGS':`${list?.name || 'SONGS'}`.toUpperCase();
  const query=$('song-search').value.trim().toLowerCase();
  const songs=(list?.song_ids || []).map(id=>state.songs.find(song=>song.id===id)).filter(Boolean);
  $('song-count').textContent=songs.length;
  const container=$('songs');container.replaceChildren();
  for(const [index,song] of songs.entries()){
    if(query && !`${song.title} ${song.artist || ''}`.toLowerCase().includes(query))continue;
    const row=element('div',`song-row${song.id===model.song?' selected':''}`);const busySong=isJobActive(state.job)&&state.job.song_id===song.id;row.dataset.status=busySong?'busy':song.active_run?'ready':'new';const handle=element('span','song-number drag-handle','⠿');handle.draggable=true;handle.title='Drag to reorder in this set list';handle.setAttribute('aria-label',handle.title);handle.ondragstart=event=>{model.dragSong=song.id;event.dataTransfer.setData('text/plain',song.id);event.dataTransfer.effectAllowed='move';row.classList.add('dragging');};handle.ondragend=()=>{model.dragSong=null;row.classList.remove('dragging');for(const item of container.children)item.classList.remove('drop-target');};row.ondragover=event=>{if(model.dragSong && model.dragSong!==song.id){event.preventDefault();event.dataTransfer.dropEffect='move';row.classList.add('drop-target');}};row.ondragleave=()=>row.classList.remove('drop-target');row.ondrop=event=>{if(!model.dragSong)return;event.preventDefault();event.stopPropagation();row.classList.remove('drop-target');moveSongBefore(model.dragSong,song.id);};row.append(handle);
    const button=element('button','song-main');button.append(element('strong','',song.title),element('small','',busySong?'Analyzing…':songStatusLabel(song)));button.onclick=()=>selectSong(song.id);row.append(button);if(!song.active_run){const lock=element('span','song-lock');lock.title='Not analyzed yet';lock.innerHTML=icon('lock');row.append(lock);}else if(song.duration)row.append(element('span','song-len',timeLabel(song.duration)));
    const order=element('div','song-order');for(const [symbol,direction] of [['▲',-1],['▼',1]]){const move=element('button','',symbol);move.title=`Move ${song.title} ${direction<0?'up':'down'}`;move.setAttribute('aria-label',move.title);move.disabled=index+direction<0 || index+direction>=songs.length;move.onclick=()=>reorderSong(song.id,direction);order.append(move);}row.append(order);container.append(row);
  }
  if(!container.children.length)container.append(element('p','sidebar-empty',query?'No songs match your search.':list?.name==='Default'?'Your song library starts with an MP3. Import one to get going.':'This set list is ready for songs. Import an MP3 or add a song from your library.'));
  const trashed=state.trash||[];$('trash-open').classList.toggle('hidden',!trashed.length);$('trash-open').textContent='Trash ('+trashed.length+')';
  $('engine-status').textContent=state.engine.ready?'Transcription engine ready':state.engine.message || 'Transcription engine needs setup';
  $('engine-dot').classList.toggle('ready',!!state.engine.ready);
}
async function reorderSong(id,direction){try{const list=model.state.setlists.find(item=>item.id===model.setlist);const ids=[...list.song_ids];const index=ids.indexOf(id);[ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];await api('/api/setlist/order',{id:list.id,song_ids:ids});await refreshState();}catch(error){showError(error);}}
async function moveSongBefore(id,target){try{const list=model.state.setlists.find(item=>item.id===model.setlist);const destination=list.song_ids.indexOf(target);const ids=list.song_ids.filter(songId=>songId!==id);ids.splice(destination,0,id);await api('/api/setlist/order',{id:list.id,song_ids:ids});model.dragSong=null;await refreshState();}catch(error){showError(error);}}
const TITLE_NODES=['page-song','score-title','midi-title'];
function renderControls(){
  const song=currentSong();$('empty-state').classList.toggle('hidden',!!song);$('song-controls').classList.toggle('hidden',!song);$('workspace').classList.toggle('hidden',!song);
  $('song-actions').classList.toggle('hidden',!song);
  renderSections();if(!song)return;
  if(!TITLE_NODES.some(id=>document.activeElement===$(id))&&!model.pendingTitle&&!model.titleSave){$('song-title').value=song.title;for(const id of TITLE_NODES)$(id).textContent=song.title;}

  const busy=isJobActive(model.state.job);
  $('transcribe').disabled=!!busy || !model.state.engine.ready || model.importing;
  $('transcribe').querySelector('em').textContent=analysisUiState(song,model.state.job).label;renderChips();
  if(typeof rhythmButton!=='undefined'){const job=model.state.job;rhythmButton.textContent=job?.kind==='rhythm'&&job.document_id===model.document&&job.status==='completed'?'Review rhythm proposal':'Attempt timing correction w/drum track';rhythmButton.disabled=isJobActive(job)||!separationDetail?.active;rhythmButton.title=separationDetail?.active?'':'Split the stems first: this listens to the drums.';}
  $('transcribe').title=!model.state.engine.ready?model.state.engine.message || 'Set up the transcription engine first.':'';
  const field=$('song-controls').querySelector('#setlist-add');if(field)field.remove();
  const available=model.state.setlists.filter(list=>list.name!=='Default'&&!list.song_ids.includes(song.id));
  if(available.length){const select=element('select');select.id='setlist-add';select.setAttribute('aria-label','Add song to set list');const prompt=element('option','','Add to set list…');prompt.value='';select.append(prompt);for(const list of available){const option=element('option','',list.name);option.value=list.id;select.append(option);}select.onchange=async()=>{if(!select.value)return;try{await api('/api/setlist/add',{id:select.value,song_id:song.id});await refreshState();}catch(error){showError(error);}};$('song-title').parentElement.append(select);}
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
function renderChips(){renderKeyBoxes();}   // the song's details live in each page's banner now; there are no pills in the header
// The key sits in each page's banner, beside the time signature. Click it to choose another.
function renderKeyBoxes(){
  const key=songKey();
  for(const head of document.querySelectorAll('.jhead')){
    let box=head.querySelector('.key-box');
    if(!box){
      box=element('button','key-box');box.type='button';box.append(element('small','','Key'),element('b'));
      box.onclick=event=>{event.stopPropagation();openKeyMenu(box);};
      const meter=head.querySelector('.meter-box');meter?head.insertBefore(box,meter):head.append(box);
    }
    box.hidden=!key.label;
    box.querySelector('b').textContent=key.label||'';
    box.title=key.custom?'Key set by you. Click to change it.':'Estimated from the chords. Click to change it.';
    box.setAttribute('aria-label','Key of this song: '+(key.label||'unknown')+'. Click to change it.');
  }
}
// The key is guessed from the chords; the player's own choice is remembered with the library and wins.
function songKey(){
  const chords=(currentContent()?.chords||chartRecord()?.doc.content?.chords||[]).filter(chord=>!isNoChordLabel(chord.label)),estimate=estimateKey(chords);
  const saved=prefs.get('cb-key:'+model.song,''),custom=KEY_CHOICES.includes(saved);
  return {estimate,custom,label:custom?saved:estimate?.label||null};
}
function openKeyMenu(chip){
  const pop=$('key-pop'),key=songKey();closeInfo();
  const select=element('select');select.setAttribute('aria-label','Key of this song');
  const auto=element('option','','Estimated'+(key.estimate?': '+key.estimate.label:''));auto.value='';select.append(auto);
  for(const name of KEY_CHOICES){const option=element('option','',name);option.value=name;select.append(option);}
  select.value=key.custom?key.label:'';
  select.onchange=()=>{prefs.set('cb-key:'+model.song,select.value);closeInfo();renderChips();};
  pop.replaceChildren(element('label','','Key of this song'),select);
  const box=chip.getBoundingClientRect();pop.style.top=(box.bottom+8)+'px';pop.style.left=Math.max(8,box.left)+'px';pop.classList.remove('hidden');select.focus();
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
  const song=currentSong(),music=currentRecord()?.doc.music,meter=music?.measures?.[0]?.meter,bpm=music?.timing?.bpm;
  setSub($('page-sub'),[bpm?`♩ = ${Math.round(bpm)}`:null,song?.duration?timeLabel(song.duration):null,'arranged in Chord Buddy']);
  const box=$('meter-box');box.hidden=!meter;box.replaceChildren();if(meter)box.append(String(meter[0]),document.createElement('hr'),String(meter[1]));
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
  if(id===model.song)return;
  if(!practiceView.canNavigate())return;
  const request=++model.loadingSong;
  try{const saved=await window.chordBuddyFlush();if(!saved.ok)throw Error('Finish saving before changing the selected song or document.');}catch(error){showError(error);return;}
  if(request!==model.loadingSong)return;
  playbackGate.block('Checking analysis.');player.setWaveformRun(null);practiceViewport=null;practiceData=null;player.setPractice({music:{measures:[]},projection:null,viewport:null});separationDetail=null;model.readinessChecked=false;model.song=id;model.detail=null;model.document=null;
  clearError();renderLibrary();renderControls();renderDocument();renderLock();
  await transport.loadSong({songId:id,originalUrl:mediaUrl('/api/audio/'+encodeURIComponent(id)),separation:null});player.setNow({chord:'—',next:''});await refreshSeparation();if(request!==model.loadingSong)return;
  try{const detail=await api(`/api/song/${encodeURIComponent(id)}`);if(request!==model.loadingSong)return;model.detail=detail;renderTabs();loadMelody(detail,id);if(shownDocs(detail).length)await selectDocument(shownDocs(detail)[0].id);else renderDocument();if(detail.song.error)showError(analysisErrorMessage(detail.song.error,!!detail.song.active_run));}catch(error){if(request===model.loadingSong)showError(error);}
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
async function refreshSongDetail(id,force=false){
  const detail=await api(`/api/song/${encodeURIComponent(id)}`);if(model.song!==id)return;model.detail=detail;renderTabs();loadMelody(detail,id);
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
  const record=currentRecord();for(const id of ['abc-editor','midi-editor','chart-editor'])$(id).classList.add('hidden');$('document-empty').classList.toggle('hidden',!!record);
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
function chartRecord(){const id=model.detail?.documents?.find(doc=>doc.kind==='chart')?.id;return id?model.documents.get(id):null;}
async function loadChartRecord(){
  const id=model.detail?.documents?.find(doc=>doc.kind==='chart')?.id;if(!id||model.documents.has(id))return;
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
  const meter=record.doc.music?.measures?.[0]?.meter,box=$('score-meter');box.hidden=!meter;box.replaceChildren();if(meter)box.append(String(meter[0]),document.createElement('hr'),String(meter[1]));
  leadView=renderLeadSheet($('score'),{key:model.document,content,music:record.doc.music,title:song?.title,artist:song?.artist,settings:model.state.settings,
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
// A chord typed on the lead sheet is saved to the lead sheet and confirmed, exactly as the old Apply button did.
async function commitChordLabel(id,text){
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
 practiceView.update({documentId:r.doc.id,revision:r.doc.revision,songId:model.song,content,music,transport:transport.getSnapshot(),viewport:practiceViewport,onsets,suggest:$('suggest').checked,melody:$('suggest').checked&&model.melody?.song===model.song?model.melody.notes:null});
 updatePracticePlayer();
}
async function confirmChordOverride(chord,label,start,end){
  const metadata=model.detail?.metadata||{revision:0,timing:{constant_tempo:false,bpm:null},chord_overrides:[]};
  await api('/api/confirm-chord',{song_id:model.song,id:chord.id,start:Number(start),end:Number(end),label,revision:metadata.revision});
  await keepDeskPlace(()=>refreshSongDetail(model.song,true));
}
function refreshChartMusic(){try{renderChart();}catch(e){showError(e);}}
function nowAndNext(chords,chord,time){
  const label=c=>c&&!isNoChordLabel(c.label)?displayChordLabel(c.label):'';
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
 const setup=await askSongSetup({title:song.title,artist:song.artist,stems:wantsStems(),stemsHint:stemsHint(),device:model.state?.settings?.device||'auto'});
 if(!setup)return;
 prefs.set('cb-stems',setup.stems?'1':'0');
 await api('/api/song',{id:song.id,title:setup.title,artist:setup.artist});
 if(setup.device&&setup.device!==model.state?.settings?.device)model.state.settings=await api('/api/settings',{device:setup.device});   // kept for every later analysis too
 await refreshState();
 if(!model.state.engine.ready){showError(model.state.engine.message||'Set up the transcription engine first.');return;}
 await startAnalysis(song.id,[],setup.stems);
}
async function importFile(file){
  if(!file)return;if(!/\.mp3$/i.test(file.name)){showError('Choose an MP3 recording.');return;}if(file.size>250*1024*1024){showError('This recording is larger than the 250 MB import limit.');return;}
  if(model.importing)return;model.importing=true;$('import-button').disabled=true;$('import-button').querySelector('em').textContent='Importing…';clearError();
  let added=null;
  try{const bytes=await file.arrayBuffer();const song=await api(`/api/import?filename=${encodeURIComponent(file.name)}&setlist=${encodeURIComponent(model.setlist || '')}`,undefined,{method:'POST',headers:{'Content-Type':'audio/mpeg'},body:bytes});await refreshState();await selectSong(song.id);added=song;}
  catch(error){showError(error);}finally{model.importing=false;$('import-button').disabled=false;$('import-button').querySelector('em').textContent='Import MP3';$('file-input').value='';renderControls();}
  if(added)setupImportedSong(added).catch(showError);
}
$('import-button').onclick=$('empty-import').onclick=()=>$('file-input').click();$('file-input').onchange=()=>importFile($('file-input').files[0]);
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
  const has={ 'pdf-chart':docs.some(d=>d.kind==='chart'),'pdf-lead':docs.some(d=>d.kind==='abc'),midi:docs.some(d=>d.kind==='midi'),'midi-tracks':docs.some(d=>d.kind==='midi'),outputs:!!song?.active_run };
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
  const chart=model.detail?.documents.find(doc=>doc.kind==='chart');if(!chart)throw new Error('This song has no chart to export yet.');
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
  checkbox:hasStems?{label:'Split the stems again',hint:'Only needed if the stems sound wrong. It takes several minutes.',checked:false,onChange:value=>{resplit=value;}}
   :{label:'Also split the stems',hint:stemsHint(),checked:resplit,onChange:value=>{resplit=value;prefs.set('cb-stems',value?'1':'0');}},
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

// Deleting a song: first to the Trash (hidden, nothing erased, restorable), then forever only from the Trash.
async function trashSong(id){
 try{
  const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits first.');
  const wasCurrent=model.song===id;await api('/api/song/trash',{id});await refreshState();
  if(wasCurrent){
   model.song=null;model.detail=null;model.document=null;practiceData=null;practiceViewport=null;player.setWaveformRun(null);player.setPractice({music:{measures:[]},projection:null,viewport:null});
   await transport.loadSong({songId:null});const next=model.state.songs[0];
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
async function boot(){try{await prefs.connect(values=>api('/api/prefs',values),()=>api('/api/prefs'));practiceView.setSnapping(prefs.get('cb-snap','1')!=='0');await refreshState();const song=model.state.songs[0];if(song)await selectSong(song.id);}catch(error){showError(error);$('engine-status').textContent='Could not connect to the local app';}}
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
