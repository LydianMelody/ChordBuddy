// Deleting a song: first to the Trash (hidden, nothing erased, restorable), then forever only from the Trash.
// app.js makes one with createTrashFlow({...}) (everything it needs from the page is passed in) and calls wire() to attach
// "Delete song" in the song's menu and the Trash button under the song list.
import {askChoice,openTrash} from './dialogs.js';

export function createTrashFlow({$,model,api,currentSong,refreshState,selectSong,leaveSong,renderLibrary,renderControls,renderDocument,renderLock,showError}){
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
function wire(){
$('delete-song').onclick=async()=>{
 $('settings-menu').open=false;const song=currentSong();if(!song)return;
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
}
return {trashSong,wire};
}
