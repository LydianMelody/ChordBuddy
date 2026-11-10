// Set lists: adding a song to one (by dropping it there), taking it out, reordering, and the "new set list" form.
// app.js makes one with createSetlistActions({$, model, api, refreshState, showError}) and calls the four actions from the sidebar and
// All songs. wireDrag() and wireForm() attach the page's listeners; app.js calls them where that code used to stand.
// model.dragSong is the id of the song being dragged (set by the rows themselves); every action asks the app, then refreshes the state.

export function createSetlistActions({$,model,api,refreshState,showError}){
async function addToSetlist(list,songId,node){
  const song=model.state.songs.find(s=>s.id===songId);
  if(list.song_ids.includes(songId)){node?.classList.add('already');setTimeout(()=>node?.classList.remove('already'),900);showError(`${song?.title||'That song'} is already in ${list.name}.`);return;}
  try{await api('/api/setlist/add',{id:list.id,song_id:songId});node?.classList.add('took');setTimeout(()=>node?.classList.remove('took'),900);await refreshState();}catch(error){showError(error);}
}
async function removeFromSetlist(listId,songId){try{await api('/api/setlist/remove',{id:listId,song_id:songId});await refreshState();}catch(error){showError(error);}}
async function reorderSong(id,direction){try{const list=model.state.setlists.find(item=>item.id===model.setlist);const ids=[...list.song_ids];const index=ids.indexOf(id);[ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];await api('/api/setlist/order',{id:list.id,song_ids:ids});await refreshState();}catch(error){showError(error);}}
async function moveSongBefore(id,target){try{const list=model.state.setlists.find(item=>item.id===model.setlist);const destination=list.song_ids.indexOf(target);const ids=list.song_ids.filter(songId=>songId!==id);ids.splice(destination,0,id);await api('/api/setlist/order',{id:list.id,song_ids:ids});model.dragSong=null;await refreshState();}catch(error){showError(error);}}
function wireDrag(){
// While a song is dragged, the whole page takes it, so the pointer stays an arrow (the browser shows its "no" sign wherever a drop is not
// taken). Only a set list does anything with it, and shows the arrow with a + (it is added there); let go anywhere else and nothing happens.
document.addEventListener('dragover',event=>{if(!model.dragSong||event.defaultPrevented)return;event.preventDefault();event.dataTransfer.dropEffect='move';});
document.addEventListener('drop',event=>{if(model.dragSong&&!event.defaultPrevented)event.preventDefault();});
}
function wireForm(){
$('new-setlist').onclick=()=>{$('setlist-form').classList.toggle('hidden');if(!$('setlist-form').classList.contains('hidden'))$('setlist-name').focus();};
$('setlist-form').onsubmit=async event=>{event.preventDefault();try{const name=$('setlist-name').value.trim();if(!name)return;const list=await api('/api/setlist',{name});model.setlist=list.id;$('setlist-name').value='';$('setlist-form').classList.add('hidden');await refreshState();}catch(error){showError(error);}};
}
return {addToSetlist,removeFromSetlist,reorderSong,moveSongBefore,wireDrag,wireForm};
}
