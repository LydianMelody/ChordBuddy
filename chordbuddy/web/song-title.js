// The open song's title: typed in the header of the chart, lead sheet or MIDI page, and saved a moment after the last key.
// app.js makes one with createSongTitle({$, model, api, currentSong, renderPageHead, renderLibrary, showError}). commitUiDrafts() saves
// a title that is still waiting (app.js calls it before anything that needs the song saved); wire() attaches the title fields.
// model.pendingTitle is true while the typed title differs from the saved one, model.titleSave is the save in flight.

// the three headings a title can be typed in (the hidden #song-title field carries it to the saving code)
export const TITLE_NODES=['page-song','score-title','midi-title'];

export function createSongTitle({$,model,api,currentSong,renderPageHead,renderLibrary,showError}){
async function updateTitle(){
  if(model.titleSave){await model.titleSave;if(!model.pendingTitle)return;}
  const song=currentSong();if(!song)return;const title=$('song-title').value.trim();if(!title)throw new Error('Give your song a title before continuing.');
  if(title===song.title){model.pendingTitle=false;return;}
  const songId=song.id;model.titleSave=api('/api/song',{id:songId,title});
  try{const changed=await model.titleSave;const latest=model.state?.songs.find(item=>item.id===songId);if(latest)Object.assign(latest,changed);if(model.song===songId){model.pendingTitle=$('song-title').value.trim()!==title;renderPageHead();}renderLibrary();}
  finally{model.titleSave=null;}
}
async function commitUiDrafts(){if(model.pendingTitle||model.titleSave)await updateTitle();}
function wire(){
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
}
return {updateTitle,commitUiDrafts,wire};
}
