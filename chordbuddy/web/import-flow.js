// Import: an MP3 becomes a new song (then its name, artist and "split stems?" are asked, and its analysis starts), a song zip exported
// from Chord Buddy is added or updates a song here, and a MIDI file goes to the MIDI import screen. Files come from the Import button or
// are dropped anywhere on the window.
// app.js makes one with createImportFlow({...}) (everything it needs from the page is passed in; midiImport only needs importFile(file))
// and calls wireButtons() and wireDrop() where that code used to stand.
import {askSongSetup,askSongImport} from './dialogs.js';

export function createImportFlow({$,model,prefs,api,midiImport,wantsStems,stemsHint,startAnalysis,refreshState,selectSong,leaveSong,renderControls,showError,clearError}){
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
  if(/\.midi?$/i.test(file.name))return midiImport.importFile(file);
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
function wireButtons(){
$('import-button').onclick=$('empty-import').onclick=()=>$('file-input').click();$('file-input').onchange=()=>importFile($('file-input').files[0]);
}
function wireDrop(){
let dragDepth=0;window.addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').classList.remove('hidden');}});window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});window.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').classList.add('hidden');});window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').classList.add('hidden');importFile(event.dataTransfer.files[0]);});
}
return {importFile,importSongZip,setupImportedSong,wireButtons,wireDrop};
}
