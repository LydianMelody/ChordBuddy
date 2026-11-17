// Export: the Export menu (PDF of the chart or lead sheet, MIDI, the model's outputs, the whole song as a zip, the lead sheet in MuseScore)
// and Export PDF itself, which prints the page that is showing.
// app.js makes one with createExportFlow({...}) (everything it needs from the page is passed in; getLeadView() gives the lead sheet on
// screen, or null), calls renderExportMenu() when the tabs are drawn and exportChartPdf() from the other places that offer a PDF;
// wire() attaches the menu's buttons.
import {askChoice} from './dialogs.js';
import {tempoMapMidi,SMOOTHING} from './tempo-map.js';

export function createExportFlow({$,model,prefs,api,mediaUrl,practiceView,getLeadView,currentSong,currentRecord,chartDoc,loadChartRecord,selectDocument,songContext,showError}){
// ---- Export: saving and exporting live in one menu, in the same place in every view ----
function renderExportMenu(){
  const docs=model.detail?.documents||[],song=currentSong();
  const has={ 'pdf-chart':docs.some(d=>d.kind==='chart'),'pdf-lead':docs.some(d=>d.kind==='abc'),midi:docs.some(d=>d.kind==='midi'),'midi-tracks':docs.some(d=>d.kind==='midi'),'tempo-map':docs.some(d=>d.kind==='chart'),outputs:!!song?.active_run,song:!!song };
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
  if(kind==='tempo-map')return exportTempoMap(song);
  if(kind==='outputs')return downloadUrl(mediaUrl('/api/export-outputs/'+encodeURIComponent(song.id)));
  if(kind==='song')return exportSong(song);
  if(kind==='lead-external')return openLeadElsewhere();
}
// The song's tempo map as a small MIDI file, so a DAW's grid follows the recording. The dialog says how to bring it into Reaper and Live,
// since both ask a question on import that is easy to answer "no" to. (The file itself is built in tempo-map.js.)
async function exportTempoMap(song){
  const c=await songContext(song.id);
  let smoothing=prefs.get('cb-tempo-smoothing','bar'),markers=prefs.get('cb-tempo-markers','1')==='1';
  if(!SMOOTHING.some(s=>s.id===smoothing))smoothing='bar';
  const answer=await askChoice({title:'Export the tempo map of “'+song.title+'”',
    message:['A small MIDI file with the tempo changes Chord Buddy found, so your DAW’s beats and bars line up with the recording, even when the band speeds up and slows down.',
      'Reaper: use Insert > Media file, import into a new project, and say yes when it asks about the tempo map. Ableton Live: drag the file onto an Arrangement track and say yes when it asks to import the tempo map. Then delete the “Delete me” note, which only exists so Live offers the import.'],
    radios:{label:'How many tempo changes',value:smoothing,options:SMOOTHING.map(({id,label,hint})=>({id,label,hint})),onChange:id=>{smoothing=id;}},
    checkbox:{label:'Add the section names as markers',hint:'Verse, Chorus and so on show up on your DAW’s timeline.',checked:markers,onChange:value=>{markers=value;}},
    choices:[{id:'export',label:'Export',kind:'primary'}]});
  if(answer!=='export')return;
  prefs.set('cb-tempo-smoothing',smoothing);prefs.set('cb-tempo-markers',markers?'1':'0');
  const bytes=tempoMapMidi({measures:c.measures,sections:c.sections,title:c.title,smoothing,markers});
  const link=document.createElement('a'),url=URL.createObjectURL(new Blob([bytes],{type:'audio/midi'}));
  link.href=url;link.download=`${(c.title||'Song').replace(/[\\/:*?"<>|]+/g,' ').trim()||'Song'} tempo map.mid`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
// Sending the lead sheet to MuseScore freezes it: Chord Buddy cannot read the changes back, so from then on it shows the copy that was
// sent instead of following the chord chart. Say so first. ("Follow the chord chart again", above the lead sheet, undoes it.)
async function openLeadElsewhere(){
  if(currentRecord()?.doc.kind!=='abc'||!getLeadView())throw new Error('Open the Lead sheet tab first.');
  const answer=await askChoice({title:'Open the lead sheet in MuseScore?',
    message:['Chord Buddy saves the lead sheet as a MusicXML file and opens it in MuseScore, or whichever program opens those files.',
      'Chord Buddy can’t read your changes back. From then on, this lead sheet stays as it was sent and stops following the chord chart. “Follow the chord chart again”, above the lead sheet, undoes that.'],
    choices:[{id:'open',label:'Open in MuseScore',kind:'primary'}]});
  if(answer==='open')await getLeadView().openExternal();
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
// Export PDF: print only the page that is showing, the lead sheet or the chart (print rules live in shell.css). The page is drawn in light
// colours, without tool hints, whichever look is on screen.
const exportChartPdf=()=>exportPdf(currentRecord()?.doc.kind==='abc'?'lead':'chart');
async function exportPdf(which){
 try{
  if(which==='lead'){
   const lead=model.detail?.documents.find(doc=>doc.kind==='abc');if(!lead)throw new Error('This song has no lead sheet to export yet.');
   await loadChartRecord();                                                 // the words come from the chart
   if(currentRecord()?.doc.kind!=='abc'||model.document!==lead.id)await selectDocument(lead.id);
   if(currentRecord()?.doc.kind!=='abc'||!getLeadView())return;
   await new Promise(resolve=>setTimeout(resolve,150));
   getLeadView().printMode(true);
   try{await new Promise(resolve=>setTimeout(resolve,80));window.print();}finally{getLeadView().printMode(false);}
   return;
  }
  const chart=chartDoc();if(!chart)throw new Error('This song has no chart to export yet.');
  if(currentRecord()?.doc.kind!=='chart'||model.document!==chart.id)await selectDocument(chart.id);
  if(currentRecord()?.doc.kind!=='chart')return;
  practiceView.setMode('nav');await new Promise(resolve=>setTimeout(resolve,60));window.print();
 }catch(error){showError(error);}
}
function wire(){
for(const button of document.querySelectorAll('[data-export]'))button.onclick=()=>{$('export-menu').open=false;runExport(button.dataset.export).catch(showError);};
document.addEventListener('chordbuddy:export-pdf',exportChartPdf);
}
return {renderExportMenu,runExport,exportSong,exportChartPdf,exportPdf,wire};
}
