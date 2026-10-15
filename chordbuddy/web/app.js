import {commitPracticeDocument} from './practice-save.js';
import {retryDocumentExport} from './export-retry.js';
import {reconcileCompactPreferences} from './compact-chart.js';
import {mountChartPage} from './chart-page.js';
import {SNAPS,DEFAULT_ZOOM} from './timing-geometry.js';
import {askChoice,openTrash} from './dialogs.js';
import {updateViewport} from './practice-timeline.js';
import {PlaybackGate} from './playback-ready.js';
import {analysisUiState,songStatusLabel,analysisErrorMessage,lockStepStates,lockJobFailed} from './analysis-view.js';
import {ProposalGuard,renderRhythmPreview} from './rhythm-view.js';
import {Transport} from './transport.js';
import {mountMixer} from './mixer-rack.js';
import {mountPlayer} from './player-view.js';
import {activeChord, editChordContent, validateNote, pitchName, isJobActive, abcChordTokens, jobProgress, validateChart, reassignChartChords, splitChartSection, mergeChartSection, displayChordLabel, editChartSection, editChartChord, addChartChord, settleHistoryResult, updateAbcDraft, startChordAtMeasure} from './editor.js';
import {renderLeadSheet,updateLeadSheetPlayback} from './lead-sheet.js';
import {openSettings,openSongTiming,openReprocess,openModelAttribution} from './settings-view.js';
import {indicateChord} from './confidence-view.js';
import {effectiveMeasures, isNoChordLabel} from './chart-layout.js';
import {icon} from './icons.js';
import {prefs} from './prefs.js';
import {estimateKey,KEY_CHOICES} from './key-estimate.js';
import {onsetsFromNotes} from './word-layout.js';
import {mountModelsPanel} from './models-view.js';

const $ = id => document.getElementById(id);
document.querySelector('.chart-intro h2')?.remove();
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const model = {state:null,setlist:null,song:null,detail:null,document:null,documents:new Map(),selectedNote:null,track:0,editingChord:null,loadingSong:0,polling:false,importing:false,pendingTitle:false,titleSave:null,pendingNote:false,pendingChord:false,dragSong:null,chartSection:null,chartChord:null,pendingChart:null};
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
async function startAnalysis(songId,invalidate=[]){
 await playbackGate.analyze(songId,()=>api('/api/songs/'+encodeURIComponent(songId)+'/analyze',{invalidate}));
 await refreshState();
}
const mixer=mountMixer($('rack'),{transport,onError:showError,exportTarget:()=>{const runId=separationDetail?.active?.run_id,song=currentSong();return runId&&song?{title:song.title||'Chord Buddy',url:(query,name)=>mediaUrl(`/api/mix-export/${encodeURIComponent(runId)}`)+`&${query}&name=${encodeURIComponent(name)}`}:null;}});

let practiceViewport=null,practiceData=null;
const player=mountPlayer($('player'),transport,showError,{onViewportChange:updatePracticeViewport,loadWaveform:run=>api('/api/waveform/'+encodeURIComponent(run))});
const practiceView=mountChartPage($('chart-sections'),{
 onSeek:seconds=>transport.seek(seconds),onCommit:commitPracticeEdit,onError:showError,onReload:reloadPracticeChart,canEdit:()=>!currentRecord()?.practiceConflict&&!currentRecord()?.saving,
 onViewportChange:updatePracticeViewport,onRhythm:()=>rhythmButton.click(),onTimingSettings:()=>$('song-timing').click(),
 onDraftChange:info=>{const r=currentRecord();if(r&&!info.failed&&!info.saving)r.practiceSaveError=null;renderDocument();},
 onModeChange:()=>syncModeUi(),onScopeChange:()=>syncModeUi(),onTimingChange:()=>syncModeUi(),
});
// Chart modes: Navigate / Edit / Timing. The page owns the mode; the toolbar and the N / E / T keys only ask it to change.
function syncModeUi(){
 const mode=practiceView.getMode(),workspace=$('workspace');
 workspace.dataset.mode=mode;workspace.dataset.kind=currentRecord()?.doc.kind||'';
 for(const button of document.querySelectorAll('#modes .mode')){const on=button.dataset.m===mode;button.classList.toggle('on',on);button.setAttribute('aria-checked',String(on));}
 for(const button of document.querySelectorAll('#scope button'))button.classList.toggle('on',button.dataset.scope===practiceView.getScope());
 for(const button of document.querySelectorAll('#snap button'))button.classList.toggle('on',button.dataset.snap===practiceView.getSnap());
 const hint=[...document.querySelectorAll('#mode-hint [data-h]')].find(s=>s.dataset.h===mode);$('hint-toggle').title=hint?hint.textContent:'What does this mode do?';
 $('tz-label').textContent=practiceView.getZoom()+'×';
 if(typeof rhythmButton!=='undefined'){rhythmButton.hidden=currentRecord()?.doc.kind!=='chart';$('rhythm-tool').disabled=rhythmButton.disabled;}
}
for(const [snap,label] of SNAPS){const button=element('button','',label);button.type='button';button.dataset.snap=snap;button.onclick=()=>practiceView.setSnap(snap);$('snap').append(button);}
$('suggest').onchange=()=>{prefs.set('cb-suggest',$('suggest').checked?'1':'0');renderChart();};
$('tz-in').onclick=()=>practiceView.zoomBy(1);$('tz-out').onclick=()=>practiceView.zoomBy(-1);
$('timing-settings').onclick=()=>$('song-timing').click();
$('rhythm-tool').onclick=()=>rhythmButton.click();
for(const button of document.querySelectorAll('#modes .mode'))button.onclick=()=>practiceView.setMode(button.dataset.m);
// Small help that stays out of the way: the ? explains the current mode, the i explains the confidence colours.
function closeInfo(){$('key-pop').classList.add('hidden');$('mode-hint').classList.remove('show');$('hint-toggle').setAttribute('aria-expanded','false');$('info-pop').classList.add('hidden');}
$('hint-toggle').onclick=event=>{event.stopPropagation();const show=!$('mode-hint').classList.contains('show');closeInfo();if(show){$('mode-hint').classList.add('show');$('hint-toggle').setAttribute('aria-expanded','true');}};
$('confidence-info').onclick=event=>{event.stopPropagation();const open=!$('info-pop').classList.contains('hidden');closeInfo();if(open)return;const box=$('confidence-info').getBoundingClientRect();$('info-pop').textContent=$('confidence-info').dataset.text||'';$('info-pop').style.top=(box.bottom+8)+'px';$('info-pop').style.right=Math.max(8,innerWidth-box.right-20)+'px';$('info-pop').classList.remove('hidden');};
document.addEventListener('click',event=>{if(!event.target.closest?.('#mode-hint,#info-pop,#key-pop'))closeInfo();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeInfo();});
for(const button of document.querySelectorAll('#scope button'))button.onclick=()=>practiceView.setScope(button.dataset.scope);
document.addEventListener('keydown',event=>{
 if(event.ctrlKey||event.metaKey||event.altKey||event.defaultPrevented)return;
 const target=event.target;if(target&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))return;
 if(currentRecord()?.doc.kind!=='chart'||document.querySelector('dialog[open]'))return;
 const mode={n:'nav',e:'edit',t:'timing'}[event.key.toLowerCase()];
 if(mode){event.preventDefault();practiceView.setMode(mode);return;}
 if(practiceView.getMode()==='timing'&&(event.key==='+'||event.key==='=')){event.preventDefault();practiceView.zoomBy(1);}
 else if(practiceView.getMode()==='timing'&&(event.key==='-'||event.key==='_')){event.preventDefault();practiceView.zoomBy(-1);}
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
 if(practiceData)player.setPractice({music:{...practiceData.music,measures:effectiveMeasures(practiceData.music,practiceData.content.layout)},viewport:practiceViewport,projection:practiceView.getProjection()});
}
async function commitPracticeEdit(next,label,expected){
 const r=currentRecord();if(!r)throw Error('Choose a chart.');
 next=reconcileCompactPreferences(next,r.doc.music).content;const invalid=validateChart(next);if(invalid)throw Error(invalid);
 const pending=commitPracticeDocument(r,next,label,expected,api);renderSaveStatus();
 try{await pending;if(r.doc.export_warning)showError(r.doc.export_warning);}
 finally{if(currentRecord()===r)renderDocument();}
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
 $('song-timing').classList.add('hidden');
}
async function refreshSeparation(){
 const id=model.song;if(!id)return;
 let detail;try{detail=await api('/api/separation/'+encodeURIComponent(id));}catch(error){if(model.song===id)playbackGate.block('Could not verify analysis. Reconnecting.');throw error;}if(model.song!==id)return;
 separationDetail=detail;await playbackGate.refresh(id);if(model.song===id){model.readinessChecked=true;renderLock();}if(model.song===id)player.setWaveformRun(transport.getSnapshot().ready?detail.active?.run_id:null);
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
function renderControls(){
  const song=currentSong();$('empty-state').classList.toggle('hidden',!!song);$('song-controls').classList.toggle('hidden',!song);$('workspace').classList.toggle('hidden',!song);
  $('page-title').textContent=song?'Now practicing':'Song library';$('song-actions').classList.toggle('hidden',!song);
  renderSections();if(!song)return;
  if(document.activeElement!==$('song-title')&&!model.pendingTitle&&!model.titleSave)$('song-title').value=song.title;
  $('song-meta').textContent=[song.artist,song.filename,song.duration?timeLabel(song.duration):null].filter(Boolean).join(' · ');

  const busy=isJobActive(model.state.job);
  const modelsMissing=model.state.models&&!model.state.models.ready;
  $('transcribe').disabled=!!busy || !model.state.engine.ready || model.importing || !!modelsMissing;
  $('transcribe').querySelector('em').textContent=analysisUiState(song,model.state.job).label;renderChips();
  if(typeof rhythmButton!=='undefined'){const job=model.state.job;rhythmButton.textContent=job?.kind==='rhythm'&&job.document_id===model.document&&job.status==='completed'?'Review rhythm proposal':'Drum-based rhythm correction';rhythmButton.disabled=isJobActive(job);}
  $('transcribe').title=!model.state.engine.ready?model.state.engine.message || 'Set up the transcription engine first.':(modelsMissing?'Download the stem separation models first.':'');
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
function renderChips(){
  const song=currentSong(),chips=$('chips');chips.replaceChildren();if(!song)return;
  const music=currentRecord()?.doc.music,bpm=music?.timing?.bpm,meter=music?.measures?.[0]?.meter;
  const add=(text,cls='',name)=>{const chip=element('span','chip'+(cls?' '+cls:''));if(name){const wrap=element('span');wrap.innerHTML=icon(name);chip.append(wrap.firstChild);}chip.append(text);chips.append(chip);};
  if(bpm)add(`${Math.round(bpm)} BPM${meter?` · ${meter[0]}/${meter[1]}`:''}`,'','metronome');
  else if(meter)add(`${meter[0]}/${meter[1]}`,'','metronome');
  const key=songKey();
  if(key.label){
    const chip=element('button','chip key'+(key.custom?' set':''));chip.type='button';chip.textContent='Key '+key.label;
    chip.title=key.custom?'Key set by you. Click to change it.':'Estimated from the chords. Click to change it.';
    chip.onclick=event=>{event.stopPropagation();openKeyMenu(chip);};chips.append(chip);
  }
  if(song.active_run)add('Analyzed','ok','check');else add('Not analyzed','','lock');
}
// The key is guessed from the chords; the player's own choice is remembered with the library and wins.
function songKey(){
  const chords=(currentContent()?.chords||[]).filter(chord=>!isNoChordLabel(chord.label)),estimate=estimateKey(chords);
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
function renderPageHead(){
  const song=currentSong(),music=currentRecord()?.doc.music,meter=music?.measures?.[0]?.meter,bpm=music?.timing?.bpm;
  $('page-song').textContent=song?.title||' ';
  $('page-sub').textContent=[song?.artist,bpm?`♩ = ${Math.round(bpm)}`:null,song?.duration?timeLabel(song.duration):null,'arranged in Chord Buddy'].filter(Boolean).join(' · ');
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
  model.state=await api('/api/state');modelsPanel.update(model.state.models);renderLibrary();renderControls();renderJob();renderLock();await refreshSeparation();
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
  playbackGate.block('Checking analysis.');player.setWaveformRun(null);practiceViewport=null;practiceData=null;player.setPractice({music:{measures:[]},projection:null,viewport:null});separationDetail=null;model.readinessChecked=false;model.song=id;model.detail=null;model.document=null;model.selectedNote=null;model.editingChord=null;
  clearError();renderLibrary();renderControls();renderDocument();renderLock();
  await transport.loadSong({songId:id,originalUrl:mediaUrl('/api/audio/'+encodeURIComponent(id)),separation:null});player.setNow({chord:'—',next:''});await refreshSeparation();if(request!==model.loadingSong)return;
  try{const detail=await api(`/api/song/${encodeURIComponent(id)}`);if(request!==model.loadingSong)return;model.detail=detail;renderTabs();loadMelody(detail,id);if(detail.documents.length)await selectDocument(detail.documents[0].id);else renderDocument();if(detail.song.error)showError(analysisErrorMessage(detail.song.error,!!detail.song.active_run));}catch(error){if(request===model.loadingSong)showError(error);}
}
// The vocal melody (a MIDI output of the analysis) gives rough note starts for guessing where words fall.
async function loadMelody(detail,songId){
  const doc=detail.documents.find(item=>item.kind==='midi'&&/(^|\/)melody_vocal\.mid$/.test(item.name));
  if(!doc){model.melody={song:songId,doc:null,onsets:[]};return;}
  if(model.melody?.song===songId&&model.melody.doc===doc.id)return;
  try{
    const full=await api('/api/document/'+encodeURIComponent(doc.id));if(model.song!==songId)return;
    model.melody={song:songId,doc:doc.id,onsets:onsetsFromNotes(full.content?.notes)};renderChart();
  }catch{model.melody={song:songId,doc:doc.id,onsets:[]};}
}
async function refreshSongDetail(id,force=false){
  const detail=await api(`/api/song/${encodeURIComponent(id)}`);if(model.song!==id)return;model.detail=detail;renderTabs();loadMelody(detail,id);
  if(!model.document && detail.documents.length)await selectDocument(detail.documents[0].id);
  else if(model.document && detail.documents.length && !detail.documents.some(doc=>doc.id===model.document) && !currentRecord()?.dirty && !currentRecord()?.saving)await selectDocument(detail.documents[0].id);
  else if(force && model.document&&!practiceView.hasDraft()){const record=currentRecord();if(!record?.dirty&&!record?.saving){model.documents.delete(model.document);await selectDocument(model.document);}}
}
// Chart, Lead sheet and MIDI are the working tabs; every other analysis output lives in "More outputs".
const TAB_KINDS=[['chart','Chart'],['abc','Lead sheet'],['midi','MIDI']];
function renderTabs(){
  const tabs=$('document-tabs');tabs.replaceChildren();
  $('transcription-history').disabled=isJobActive(model.state?.job)||!model.detail?.runs.some(r=>r.id!==currentSong()?.active_run&&r.has_documents);
  const docs=model.detail?.documents||[],selected=docs.find(doc=>doc.id===model.document),direct=new Set();
  for(const [kind,label] of TAB_KINDS){
    const list=docs.filter(doc=>doc.kind===kind);if(!list.length)continue;
    const target=selected?.kind===kind?selected:list.find(doc=>doc.name===model.lastMidiName)||list.find(doc=>/melody\.mid$/.test(doc.name))||list[0];direct.add(target.id);
    const button=element('button',`document-tab${selected?.kind===kind?' selected':''}`,label+(kind==='chart'&&target.kept?' · kept edits':''));
    button.role='tab';button.setAttribute('aria-selected',selected?.kind===kind?'true':'false');button.title=target.name;button.onclick=()=>selectDocument(target.id);tabs.append(button);
  }
  const others=docs.filter(doc=>!direct.has(doc.id));
  if(others.length){
    const menu=element('details','more outputs-menu'),summary=element('summary',`document-tab${selected&&!direct.has(selected.id)?' selected':''}`,selected&&!direct.has(selected.id)?selected.name:'More outputs');
    const pop=element('div','more-pop');
    for(const doc of others){const item=element('button','text-button',doc.name);item.type='button';item.onclick=()=>{menu.open=false;if(doc.kind==='midi')model.lastMidiName=doc.name;selectDocument(doc.id);};pop.append(item);}
    menu.append(summary,pop);tabs.append(menu);
  }
}
async function selectDocument(id){
  if(id===model.document && model.documents.has(id))return;
  if(!practiceView.canNavigate())return;
  if(id!==model.document){try{const saved=await window.chordBuddyFlush();if(!saved.ok)throw Error('Finish saving before changing the selected song or document.');}catch(error){showError(error);return;}}
  model.document=id;model.selectedNote=null;model.editingChord=null;model.chartSection=null;model.chartChord=null;model.track=0;renderTabs();renderDocument();
  if(!model.documents.has(id)){try{const doc=await api(`/api/document/${encodeURIComponent(id)}`);model.documents.set(id,{doc,draft:clone(doc.content),dirty:false,saving:false,error:null,version:0,timer:null});}catch(error){showError(error);}}
  if(model.document===id){renderDocument();if(currentRecord()?.doc.kind==='chart')renderChart();}
}
function renderSaveStatus(){const record=currentRecord();const status=$('save-status');const warning=record?.doc.export_warning;status.classList.toggle('error',!!record?.practiceSaveError || !!record?.error || !!warning);status.textContent=record?.practiceSaveError?'Chart Save failed — use Retry Save':record?.doc.kind==='chart'&&practiceView.hasDraft()&&!record.saving?'Line draft — Save or Cancel':record?.error?'Save failed · click to retry':model.pendingNote||model.pendingChord||model.pendingChart?'Unsaved fields':record?.saving?'Saving…':record?.dirty?'Unsaved changes':record?.exporting?'Saved - retrying export...':warning?'Saved - click to retry export':'Saved';status.title=record?.error?.message || warning || '';status.tabIndex=(record?.error||warning)&&!record?.exporting?0:-1;}
function markRawDraft(key,value=true){model[key]=value;renderSaveStatus();$('undo').disabled=true;$('redo').disabled=true;$('restore').disabled=true;$('download').classList.add('disabled');}
function renderDocument(){
  const record=currentRecord();for(const id of ['abc-editor','midi-editor','text-editor','chart-editor'])$(id).classList.add('hidden');$('document-empty').classList.toggle('hidden',!!record);
  const rawPending=model.pendingNote||model.pendingChord||!!model.pendingChart||(record?.doc.kind==='chart'&&practiceView.hasDraft());
  $('undo').disabled=!record?.doc.can_undo||!!record?.dirty||!!record?.saving||rawPending;$('redo').disabled=!record?.doc.can_redo||!!record?.dirty||!!record?.saving||rawPending;$('restore').disabled=!record||!!record?.dirty||!!record?.saving||rawPending;
  $('undo').title=record?.doc.undo_label || 'Undo last document edit';$('redo').title=record?.doc.redo_label || 'Redo document edit';
  $('download').classList.toggle('disabled',!record||record.dirty||record.saving||rawPending);if(record){$('download').href=mediaUrl(`/api/export/${encodeURIComponent(record.doc.id)}`);$('download').setAttribute('download','');}else $('download').removeAttribute('href');
  renderSaveStatus();renderTabs();renderPageHead();renderChips();syncModeUi();
  const confidence=record?.doc.music?.confidence;
  const noteText=record?.doc.music?(confidence?.available?'Confidence indicators use model prediction certainty. Beat visibility updates when settings are saved; the raw beat grid is retained. '+(confidence.removed_beats?`${confidence.removed_beats} beat annotations were filtered during inference.`:''):'Confidence unavailable for this transcription. Reprocess the song to obtain beat and chord scores.'):'';
  $('confidence-info').classList.toggle('hidden',!noteText);$('confidence-info').title=noteText;$('confidence-info').dataset.text=noteText;
  if(!record)return;
  if(record.doc.kind==='chart'){$('chart-editor').classList.remove('hidden');renderChart();}
  else if(record.doc.kind==='abc'){$('abc-editor').classList.remove('hidden');renderAbc();}
  else if(record.doc.kind==='midi'){$('midi-editor').classList.remove('hidden');if(!model.pendingNote)renderMidi();}
  else {$('text-editor').classList.remove('hidden');$('text-source').value=currentContent().text || '';}
}
function renderAbc(){
  const content=currentContent();const strip=$('chord-strip');strip.replaceChildren();
  for(const chord of content.chords || []){if(isNoChordLabel(chord.label))continue;const button=element('button',`chord-chip${chord.id===model.editingChord?' editing':''}`,chord.label);button.dataset.chordId=chord.id;button.append(element('small','',timeLabel(chord.start)));button.disabled=!Number.isInteger(chord.abc_index);button.title=button.disabled?'No reliable ABC association; edit the notation directly.':'Edit this chord label';button.onclick=()=>openChord(chord.id);indicateChord(button,chord,currentRecord().doc.music,model.state.settings);strip.append(button);}
  $('chord-form').classList.toggle('hidden',!model.editingChord);
  if(!$('confirm-chord')){const confirm=element('button','secondary small-button','Confirm chord');confirm.type='button';confirm.id='confirm-chord';confirm.onclick=async()=>{try{const chord=currentContent()?.chords?.find(item=>item.id===model.editingChord);if(!chord)throw new Error('Select a chord first.');const label=$('chord-label').value.trim();if(!label)throw new Error('Enter a chord label first.');model.pendingChord=true;commitChordDraft();const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving the chord edit before confirming it.');await confirmChordOverride(chord,label,chord.start,chord.end);model.editingChord=null;renderDocument();}catch(error){showError(error);}};$('chord-form').append(confirm);}
  if($('abc-source').value!==(content.abc||''))$('abc-source').value=content.abc || '';
  renderLeadSheet($('score'),{key:model.document,content,music:currentRecord().doc.music,title:currentSong()?.title,settings:model.state.settings,
    onChange:(next,label)=>markEdit(next,label),onChord:openChord,onError:showError});
  updatePlayback();
}
function openChord(id){try{commitChordDraft();}catch(error){showError(error);return;}const chord=currentContent()?.chords?.find(item=>item.id===id);if(!chord||!Number.isInteger(chord.abc_index))return;model.editingChord=id;model.pendingChord=false;$('chord-label').value=chord.label;renderAbc();$('chord-label').focus();$('chord-label').select();}
function markEdit(content,label,delay=450){const record=currentRecord();if(!record)return;record.draft=content;record.dirty=true;record.error=null;record.version++;record.label=label;clearTimeout(record.timer);record.timer=setTimeout(()=>saveDocument(record.doc.id),delay);renderSaveStatus();$('undo').disabled=true;$('redo').disabled=true;$('restore').disabled=true;$('download').classList.add('disabled');}
async function saveDocument(id){
  const record=model.documents.get(id);if(!record||!record.dirty||record.saving)return;
  clearTimeout(record.timer);record.saving=true;record.error=null;const version=record.version;const content=clone(record.draft);renderSaveStatus();
  try{const doc=await api(`/api/document/${encodeURIComponent(id)}`,{content,label:record.label || 'Edit document',revision:record.doc.revision});record.doc=doc;if(record.version===version){record.draft=clone(doc.content);record.dirty=false;}record.error=null;if(doc.export_warning)showError(doc.export_warning);if(doc.engraving_warning)showError(doc.engraving_warning);}
  catch(error){record.error=error;showError(error.status===409?new Error('This document changed in another window. Your edits are kept here. Reopen the app to load that revision, or retry after resolving the other window.'):error);}
  finally{record.saving=false;if(model.document===id){renderSaveStatus();if(!record.dirty)renderDocument();}if(record.dirty&&!record.error)setTimeout(()=>saveDocument(id),100);}
}
function reconcileAbc(abc,oldChords){
  const tokens=abcChordTokens(abc);
  const mapped=(oldChords || []).filter(chord=>Number.isInteger(chord.abc_index));
  if(tokens.length!==mapped.length)return {abc,chords:(oldChords || []).map(chord=>({...chord,abc_index:null}))};
  let i=0;return {abc,chords:(oldChords || []).map(chord=>Number.isInteger(chord.abc_index)?{...chord,label:tokens[i].label,abc_index:tokens[i++].index}:{...chord})};
}
function renderMidi(){
  const content=currentContent();const tracks=content.tracks || [];const trackSelect=$('midi-track');trackSelect.replaceChildren();
  for(let i=0;i<Math.max(1,tracks.length);i++){const option=element('option','',tracks[i]?.name || `Track ${i+1}`);option.value=i;trackSelect.append(option);}trackSelect.value=model.track;
  const notes=(content.notes || []).filter(note=>note.track===model.track);const min=Math.max(0,Math.min(48,...notes.map(note=>note.pitch))-2),max=Math.min(127,Math.max(72,...notes.map(note=>note.pitch))+2);const scale=Number($('midi-zoom').value);const duration=Math.max(8,content.duration || 0,...notes.map(note=>note.end));
  const timeline=$('timeline');timeline.replaceChildren();timeline.style.width=`${Math.max(620,46+duration*scale+40)}px`;timeline.style.height=`${(max-min+1)*18+24}px`;
  for(let pitch=max;pitch>=min;pitch--){const row=element('div',`timeline-row${[1,3,6,8,10].includes(pitch%12)?' black':''}`);row.style.top=`${24+(max-pitch)*18}px`;row.append(element('span','pitch-label',pitchName(pitch)));timeline.append(row);}
  const interval=duration>120?10:duration>45?5:1;for(let second=0;second<=duration;second+=interval){const line=element('div','timeline-second');line.style.left=`${46+second*scale}px`;line.append(element('span','',timeLabel(second)));timeline.append(line);}
  for(const note of notes){const button=element('button',`midi-note${note.id===model.selectedNote?' selected':''}`);button.style.left=`${46+note.start*scale}px`;button.style.top=`${26+(max-note.pitch)*18}px`;button.style.width=`${Math.max(6,(note.end-note.start)*scale)}px`;button.title=`${pitchName(note.pitch)} · ${note.start.toFixed(2)}–${note.end.toFixed(2)}s · velocity ${note.velocity}`;button.setAttribute('aria-label',button.title);button.onclick=()=>{try{commitNoteDraft();model.selectedNote=note.id;renderMidi();}catch(error){showError(error);}};timeline.append(button);}
  const playhead=element('div','timeline-playhead');playhead.id='playhead';timeline.append(playhead);
  const selected=(content.notes || []).find(note=>note.id===model.selectedNote);$('selected-note').textContent=selected?`${pitchName(selected.pitch)} · Track ${model.track+1}`:'Select a note on the timeline, or add one.';
  for(const key of ['pitch','start','end','velocity']){$(`note-${key}`).disabled=!selected;$(`note-${key}`).value=selected?.[key] ?? '';}
  $('apply-note').disabled=!selected;$('delete-note').disabled=!selected;updatePlayback();
}
function renderChart(){
 const r=currentRecord();if(r?.doc.kind!=='chart')return;
 const content=currentContent(),music=r.doc.music;
 practiceData={content,music};
 if(!practiceViewport)practiceViewport={start:0,end:Math.min(content.duration,music?.measures?.[7]?.end||content.duration),follow:true};
 const onsets=model.melody?.song===model.song?model.melody.onsets:null,hasMelody=!!onsets?.length;
 $('suggest').disabled=!hasMelody;$('suggest').checked=hasMelody&&prefs.get('cb-suggest','1')!=='0';
 $('suggest-wrap').classList.toggle('off',!hasMelody);$('suggest-wrap').title=hasMelody?'Unpinned words are placed on the vocal melody\'s notes as a rough guess. Drag a word to pin it.':'No vocal melody was found for this song, so words spread evenly.';
 practiceView.update({documentId:r.doc.id,revision:r.doc.revision,songId:model.song,content,music,transport:transport.getSnapshot(),viewport:practiceViewport,onsets,suggest:$('suggest').checked});
 updatePracticePlayer();
}
async function confirmChordOverride(chord,label,start,end){
  const metadata=model.detail?.metadata||{revision:0,timing:{constant_tempo:false,bpm:null},chord_overrides:[]};
  await api('/api/confirm-chord',{song_id:model.song,id:chord.id,start:Number(start),end:Number(end),label,revision:metadata.revision});
  await refreshSongDetail(model.song,true);
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
  const groups=$('score').querySelectorAll('.abcjs-chord');for(const group of groups)group.classList.remove('score-chord-active');
  if(chord && Number.isInteger(chord.abc_index)){const index=abcChordTokens(currentContent()?.abc || '').findIndex(item=>item.index===chord.abc_index);if(index>=0)groups[index]?.classList.add('score-chord-active');}
  const playhead=$('playhead');if(playhead)playhead.style.left=`${46+time*Number($('midi-zoom').value)}px`;
  if(currentRecord()?.doc.kind==='chart')practiceView.updatePlayback(transport.getSnapshot());
  else if(currentRecord()?.doc.kind==='abc'){updateLeadSheetPlayback($('score'),$('score').querySelector('.lead-notation')?$('score').querySelector('.lead-notation')._scoreTiming:$('score')._scoreTiming,time);}
  if(practiceData&&practiceViewport?.follow)updatePracticeViewport({type:'tick'});
}
async function historyAction(action){
  const record=currentRecord();if(!record||record.dirty||record.saving||model.pendingNote||model.pendingChord||model.pendingChart||practiceView.hasDraft())return;
  const id=record.doc.id,version=record.version;record.saving=true;record.historyPending=true;$('workspace').inert=true;renderDocument();
  try{const doc=await api(`/api/document/${encodeURIComponent(id)}/${action}`,{revision:record.doc.revision});settleHistoryResult(record,doc,version);if(model.document===id&&!record.dirty){model.selectedNote=null;model.editingChord=null;model.chartSection=null;model.chartChord=null;}}
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
function commitNoteDraft(){
  if(!model.pendingNote)return;
  const content=clone(currentContent());const index=content?.notes?.findIndex(note=>note.id===model.selectedNote);if(index===undefined||index<0){model.pendingNote=false;return;}
  const note={...content.notes[index]};for(const key of ['pitch','start','end','velocity']){const value=$(`note-${key}`).value;if(!value.trim())throw new Error('Complete every selected-note field before continuing.');note[key]=Number(value);}
  const error=validateNote(note);if(error)throw new Error(error);content.notes[index]=note;content.duration=Math.max(content.duration || 0,note.end);model.pendingNote=false;markEdit(content,'Edit MIDI note');
}
function commitChordDraft(){
  if(!model.pendingChord)return null;
  const before=currentContent()?.chords?.find(item=>item.id===model.editingChord);const content=editChordContent(currentContent(),model.editingChord,$('chord-label').value);model.pendingChord=false;model.editingChord=null;markEdit(content,'Correct chord label');return before?{...before,label:$('chord-label').value.trim()}:null;
}
async function commitUiDrafts(){if(model.pendingTitle||model.titleSave)await updateTitle();commitNoteDraft();commitChordDraft();}
async function importFile(file){
  if(!file)return;if(!/\.mp3$/i.test(file.name)){showError('Choose an MP3 recording.');return;}if(file.size>250*1024*1024){showError('This recording is larger than the 250 MB import limit.');return;}
  if(model.importing)return;model.importing=true;$('import-button').disabled=true;$('import-button').querySelector('em').textContent='Importing…';clearError();
  try{const bytes=await file.arrayBuffer();const song=await api(`/api/import?filename=${encodeURIComponent(file.name)}&setlist=${encodeURIComponent(model.setlist || '')}`,undefined,{method:'POST',headers:{'Content-Type':'audio/mpeg'},body:bytes});await refreshState();await selectSong(song.id);$('song-title').focus();$('song-title').select();}
  catch(error){showError(error);}finally{model.importing=false;$('import-button').disabled=false;$('import-button').querySelector('em').textContent='Import MP3';$('file-input').value='';renderControls();}
}
$('import-button').onclick=$('empty-import').onclick=()=>$('file-input').click();$('file-input').onchange=()=>importFile($('file-input').files[0]);
$('new-setlist').onclick=()=>{$('setlist-form').classList.toggle('hidden');if(!$('setlist-form').classList.contains('hidden'))$('setlist-name').focus();};
$('setlist-form').onsubmit=async event=>{event.preventDefault();try{const name=$('setlist-name').value.trim();if(!name)return;const list=await api('/api/setlist',{name});model.setlist=list.id;$('setlist-name').value='';$('setlist-form').classList.add('hidden');await refreshState();}catch(error){showError(error);}};
$('song-search').oninput=renderLibrary;
let titleTimer=null;
$('song-title').oninput=()=>{model.pendingTitle=$('song-title').value.trim()!==currentSong()?.title;clearTimeout(titleTimer);titleTimer=setTimeout(()=>updateTitle().catch(showError),600);};
$('song-title').onchange=()=>{clearTimeout(titleTimer);updateTitle().catch(showError);};

$('settings-button').onclick=()=>openSettings({settings:model.state?.settings||{},onSave:async values=>{await commitUiDrafts();model.state.settings=await api('/api/settings',values);if(model.song)await refreshSongDetail(model.song,true);renderDocument();}});
$('model-attribution').onclick=()=>openModelAttribution(model.state?.engine?.model);
$('song-timing').onclick=async()=>{try{await commitUiDrafts();const record=currentRecord();if(record?.doc.kind!=='chart')throw new Error('Choose a Song chart for timing controls.');const id=record.doc.id;openSongTiming({metadata:{timing:record.doc.timing_binding.overrides},onSave:async metadata=>{if(model.document!==id)throw new Error('Selected chart changed.');await window.chordBuddyFlush();const fresh=currentRecord().doc;await api('/api/documents/'+id+'/timing',{timing:metadata.timing,revision:fresh.revision});await refreshSongDetail(model.song,true);renderDocument();}});}catch(error){showError(error);}};
$('transcription-history').onclick=async()=>{
  const songId=model.song;
  try{const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits before opening a previous transcription.');
    await refreshSongDetail(songId);if(model.song!==songId)return;
    openReprocess({hasEdits:false,runs:model.detail.runs,activeRun:currentSong().active_run,canRun:false,onRestore:async runId=>{await api('/api/activate-run',{song_id:songId,run_id:runId});await refreshState();await refreshSongDetail(songId);}});
  }catch(error){showError(error);}
};
// Export PDF: open the song's chart in Navigate mode, then print only the page (print rules live in shell.css).
async function exportChartPdf(){
 try{
  const chart=model.detail?.documents.find(doc=>doc.kind==='chart');if(!chart)throw new Error('This song has no chart to export yet.');
  if(currentRecord()?.doc.kind!=='chart'||model.document!==chart.id)await selectDocument(chart.id);
  if(currentRecord()?.doc.kind!=='chart')return;
  practiceView.setMode('nav');await new Promise(resolve=>setTimeout(resolve,60));window.print();
 }catch(error){showError(error);}
}
document.addEventListener('chordbuddy:export-pdf',exportChartPdf);
// Analyzing again builds a new chart and new stems. The old chart is kept as a previous transcription, but ask first, and offer a printout.
async function confirmReanalyze(song){
 const answer=await askChoice({title:'Analyze “'+song.title+'” again?',
  message:['Analyzing again repairs anything that is missing or out of date, and reuses whatever is still good.','Your chart and its edits are kept. If a new chart does get built, your current one stays under “Previous transcriptions” in the ⋯ menu so you can bring it back. Export it first if you would like a printout.'],
  choices:[{id:'export',label:'Export current chart as PDF',keepOpen:true},{id:'analyze',label:'Analyze again',kind:'danger'}],onPick:()=>exportChartPdf()});
 return answer==='analyze';
}
$('transcribe').onclick=async()=>{
 const songId=model.song;
 try{
  const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving your edits first.');if(model.song!==songId)return;
  const song=currentSong();if(song?.active_run&&!await confirmReanalyze(song))return;
  if(model.song!==songId)return;await startAnalysis(songId);
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
$('undo').onclick=()=>historyAction('undo');$('redo').onclick=()=>historyAction('redo');$('restore').onclick=()=>historyAction('restore');
$('save-status').onclick=()=>{const r=currentRecord();if(r?.error)saveDocument(model.document);else if(r?.doc.export_warning)retryDocumentExport(r,api,()=>{if(currentRecord()===r){renderSaveStatus();if(!r.exporting&&!r.doc.export_warning&&$('alert').textContent.startsWith('Edit saved;'))clearError();}});};$('save-status').onkeydown=event=>{if(event.key==='Enter')$('save-status').click();};
$('toggle-abc').onclick=()=>{$('abc-source-panel').classList.toggle('hidden');$('toggle-abc').textContent=$('abc-source-panel').classList.contains('hidden')?'Edit ABC notation':'Hide ABC notation';};
$('chord-label').oninput=()=>markRawDraft('pendingChord');
$('chord-form').onsubmit=async event=>{event.preventDefault();try{model.pendingChord=true;const chord=commitChordDraft();renderAbc();const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving the chord edit before confirming it.');if(chord)await confirmChordOverride(chord,chord.label,chord.start,chord.end);renderDocument();}catch(error){showError(error);}};
$('close-chord').onclick=()=>{model.pendingChord=false;model.editingChord=null;renderDocument();};
$('abc-source').oninput=()=>{const parsed=reconcileAbc($('abc-source').value,currentContent().chords);markEdit(updateAbcDraft(currentContent(),parsed.abc,parsed.chords),'Edit ABC notation',1000);renderAbc();};
$('apply-abc').onclick=()=>saveDocument(model.document);
$('text-source').oninput=()=>markEdit({text:$('text-source').value},'Edit text',1000);$('apply-text').onclick=()=>saveDocument(model.document);
$('midi-track').onchange=()=>{try{commitNoteDraft();model.track=Number($('midi-track').value);model.selectedNote=null;renderMidi();}catch(error){showError(error);$('midi-track').value=model.track;}};$('midi-zoom').oninput=()=>{try{commitNoteDraft();renderMidi();}catch(error){showError(error);}};
$('add-note').onclick=()=>{try{commitNoteDraft();const content=clone(currentContent());const start=Number(transport.getSnapshot().seconds.toFixed(2)) || 0;const note={id:crypto.randomUUID(),pitch:60,start,end:start+0.5,velocity:100,track:model.track};content.notes.push(note);content.duration=Math.max(content.duration || 0,note.end);model.selectedNote=note.id;markEdit(content,'Add MIDI note');renderMidi();}catch(error){showError(error);}};
for(const key of ['pitch','start','end','velocity'])$(`note-${key}`).oninput=()=>markRawDraft('pendingNote');
$('note-form').onsubmit=event=>{event.preventDefault();try{model.pendingNote=true;commitNoteDraft();renderMidi();}catch(error){showError(error);}};
$('delete-note').onclick=()=>{const content=clone(currentContent());content.notes=content.notes.filter(note=>note.id!==model.selectedNote);model.pendingNote=false;model.selectedNote=null;markEdit(content,'Delete MIDI note');renderMidi();};
// Playback views subscribe to the transport; the audio element no longer owns chart time.
let dragDepth=0;window.addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').classList.remove('hidden');}});window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});window.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').classList.add('hidden');});window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').classList.add('hidden');importFile(event.dataTransfer.files[0]);});
window.chordBuddyHasPendingEdits=()=>practiceView.hasPendingSave()||!!document.querySelector('[data-edit-dialog]')||model.pendingTitle || !!model.titleSave || model.pendingNote || model.pendingChord || !!model.pendingChart || [...model.documents.values()].some(record=>record.dirty||record.saving||record.practiceSaveError);
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
async function boot(){try{await prefs.connect(values=>api('/api/prefs',values),()=>api('/api/prefs'));await refreshState();const song=model.state.songs[0];if(song)await selectSong(song.id);}catch(error){showError(error);$('engine-status').textContent='Could not connect to the local app';}}
boot();setInterval(async()=>{if(model.polling)return;model.polling=true;try{await refreshState();}catch(error){$('engine-status').textContent='Connection interrupted · reconnecting';}finally{model.polling=false;}},2500);
export {transport};

const proposalGuard=new ProposalGuard(()=>model.document);
const rhythmButton=element('button','secondary','Drum-based rhythm correction');
const cleanupButton=element('button','secondary','Check empty end artifact');
const advancedButton=element('button','secondary','Reanalyze stage…');
rhythmButton.hidden=true;cleanupButton.hidden=true;$('more-tools').append(rhythmButton,cleanupButton,advancedButton);
advancedButton.onclick=async()=>{try{if(!model.song)return;const stage=prompt('Stage to reanalyze: separation or transcription');if(stage===null)return;if(!['separation','transcription'].includes(stage))throw new Error('Choose separation or transcription.');if(!confirm('Recompute '+stage+' and its dependent results? Existing edited charts remain available.'))return;await startAnalysis(model.song,[stage]);}catch(error){showError(error);}};
rhythmButton.onclick=async()=>{try{
 const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving edits first.');const doc=currentRecord()?.doc;if(doc?.kind!=='chart')throw new Error('Choose a Song chart.');const ticket=proposalGuard.begin();const job=model.state?.job;
 if(job?.kind!=='rhythm'||job.document_id!==doc.id||job.status!=='completed'||!job.proposal_id){await api('/api/documents/'+doc.id+'/rhythm/propose',{});await refreshState();return;}
 const getPreview=policy=>api('/api/documents/'+doc.id+'/rhythm/preview',{proposal_id:job.proposal_id,policy});
 const preview=await getPreview('preserve');if(!proposalGuard.valid(ticket))return;
 renderRhythmPreview({preview},{cancel:()=>proposalGuard.cancel(),preview:async policy=>{const next=await getPreview(policy);if(JSON.stringify(next.stamp)!==JSON.stringify(preview.stamp))throw new Error('Chart changed while the preview was open. Review a fresh preview before applying.');if(!proposalGuard.valid(ticket))throw new Error('Selected chart changed.');return next;},apply:async candidate=>{if(!proposalGuard.valid(ticket)||!proposalGuard.acquire())throw new Error('Preview is no longer current.');try{const saved=await window.chordBuddyFlush();if(!saved.ok)throw new Error('Finish saving edits first.');await api('/api/documents/'+doc.id+'/rhythm/apply',{preview_id:candidate.id,stamp:candidate.stamp,policy:candidate.policy});if(proposalGuard.valid(ticket)){await refreshSongDetail(model.song,true);renderDocument();}}finally{proposalGuard.release();}}});
 }catch(error){showError(error);}};
cleanupButton.onclick=async()=>{try{const flushed=await window.chordBuddyFlush();if(!flushed.ok)throw new Error('Finish saving edits first.');const id=model.document;if(currentRecord()?.doc.kind!=='chart')throw new Error('Choose a Song chart.');const preview=await api('/api/documents/'+id+'/cleanup/preview',{});if(model.document!==id)return;if(!preview.available)throw new Error(preview.reason||'No proven empty end artifact was found.');if(!confirm('Remove the proven empty end artifact? The preceding section keeps its name and contents. This can be undone.'))return;await api('/api/documents/'+id+'/cleanup/apply',{preview,revision:preview.stamp.document_revision});if(model.document===id){await refreshSongDetail(model.song,true);renderDocument();}}catch(error){showError(error);}};
