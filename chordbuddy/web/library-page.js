// All songs: every song in the library, as a wall of little cassettes where the chart and lead sheet usually are. A song is dragged from here onto a set list
// in the sidebar to add it; the set lists it is in show as tags, and a tag's × takes it out of that list (never out of the library).
// Plain DOM; the page that mounts it does the saving (onOpen, onRemove) and keeps the dragged song (onDragStart, onDragEnd).
import {icon} from './icons.js';

// a song's tape color (0-4): fixed by its id, so it is the same cassette here and on the spines in the sidebar
export function tapeTint(id){let h=0;for(const c of String(id||''))h=(h*31+c.codePointAt(0))>>>0;return h%5;}

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

// value: {songs, setlists (without All songs), selected (song id), busy (song id being analyzed), query}
// handlers: {onOpen(id), onRemove(setlistId, songId), onDragStart(id), onDragEnd(), onSearch(query), onImport(), time(seconds),
//   line(song): what goes beside the artist (tempo and key badges, or what is happening with the song), total: the songs' length}
export function renderLibraryPage(root,value,handlers){
  const {songs,setlists,selected,busy}=value,query=String(value.query||'').trim().toLowerCase();
  const head=el('header','library-head'),title=el('h2','','All songs'),count=el('span','count',String(songs.length));
  const search=el('label','search library-search');search.innerHTML=icon('search');
  const field=el('input');field.type='search';field.placeholder='Find a song…';field.setAttribute('aria-label','Find a song in the library');field.value=value.query||'';
  field.oninput=()=>handlers.onSearch?.(field.value);search.append(field);
  const hint=el('p','library-hint',setlists.length?'Drag a song onto a set list on the left to add it there.':'Make a set list on the left (+), then drag songs onto it.');
  const name=el('div','library-title');name.append(title);if(handlers.total&&songs.length)name.append(el('small','list-total',handlers.total+' total'));
  head.append(name,count,search);
  const list=el('div','library-list');list.setAttribute('role','list');
  for(const song of songs){
    if(query&&!`${song.title} ${song.artist||''}`.toLowerCase().includes(query))continue;
    // a little cassette: a paper label (title, artist), the tape window (two reels, the tempo and key between them) and the strip
    // along the bottom (its length and the set lists it is on). Each song keeps its own color (tapeTint).
    const card=el('div','library-song tape'+(song.id===selected?' selected':''));card.setAttribute('role','listitem');card.draggable=true;card.dataset.song=song.id;
    card.dataset.status=song.id===busy?'busy':song.active_run?'ready':'new';card.dataset.tint=String(tapeTint(song.id));card.title=song.title+(song.artist?' · '+song.artist:'');
    card.ondragstart=event=>{event.dataTransfer?.setData('text/plain',song.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='copyMove';card.classList.add('dragging');handlers.onDragStart?.(song.id);};
    card.ondragend=()=>{card.classList.remove('dragging');handlers.onDragEnd?.();};
    card.onclick=()=>handlers.onOpen?.(song.id);
    const open=el('button','library-open tape-label');open.type='button';open.setAttribute('aria-label','Open '+song.title);
    open.append(el('strong','',song.title),el('small','',song.artist||' '));
    open.onclick=event=>{event?.stopPropagation?.();handlers.onOpen?.(song.id);};
    const windowBox=el('div','tape-window'),facts=handlers.line?.(song);
    windowBox.append(el('i','reel'),facts||el('span','song-facts'),el('i','reel'));
    const foot=el('div','tape-foot'),tags=el('div','library-tags');
    for(const setlist of setlists.filter(s=>s.song_ids.includes(song.id))){
      const tag=el('span','library-tag'),name=el('span','',setlist.name),remove=el('button','library-untag');remove.type='button';remove.innerHTML=icon('x');tag.title=setlist.name;
      remove.title='Take '+song.title+' out of '+setlist.name;remove.setAttribute('aria-label',remove.title);
      remove.onclick=event=>{event.stopPropagation?.();handlers.onRemove?.(setlist.id,song.id);};
      tag.append(name,remove);tags.append(tag);
    }
    const length=el('span','library-len',song.duration?handlers.time?.(song.duration)||'':'');
    if(!song.active_run){length.innerHTML=icon('lock');length.title='Not analyzed yet';}
    foot.append(el('b','tape-side','A'),tags,length);
    card.append(open,windowBox,foot);list.append(card);
  }
  if(!list.children.length){
    const empty=el('div','library-empty');
    if(query)empty.append(el('p','','No songs match your search.'));
    else{empty.append(el('p','','Your song library starts with an MP3.'));const b=el('button','btn hot');b.type='button';b.innerHTML=icon('plus')+'<em>Import</em>';b.onclick=()=>handlers.onImport?.();empty.append(b);}
    list.append(empty);
  }
  const typing=root.contains?.(document.activeElement)&&document.activeElement?.type==='search';
  root.replaceChildren(head,hint,list);
  if(typing){field.focus();field.setSelectionRange?.(field.value.length,field.value.length);}
}
