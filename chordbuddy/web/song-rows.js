// What a song's row says under its title in the sidebar and on All songs (its tempo and key badges, or a note such as "Analyzing…"), and
// the one-time animations of a song that just arrived or just finished its analysis.
// app.js makes one with createSongRows({songFacts, element}) and uses songLine(song, busy) while drawing the lists and noteArrivals(state)
// after drawing the sidebar.
import {isJobActive} from './editor.js';
import {songStatusLabel} from './analysis-view.js';
import {shortKey} from './song-facts.js';

export function createSongRows({songFacts,element}){
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
// A song that just arrived drops in once, and one that just finished its analysis glows once (touches.css). What each song was last seen as is
// remembered here; the first drawing of the page only records it, so nothing animates just because the app was opened.
let knownSongs=null;
function noteArrivals(state){
  const busy=isJobActive(state.job)?state.job.song_id:null,LASTS=1600,time=performance.now(),recent=noteArrivals.recent||=new Map();   // recent: song id -> its mark and when it was given
  const now=new Map(state.songs.map(song=>[song.id,song.id===busy?'busy':song.active_run?'ready':'new']));
  if(knownSongs)for(const [id,status] of now){
    const before=knownSongs.get(id),mark=before===undefined?'just-added':before==='busy'&&status==='ready'?'just-ready':null;
    if(mark)recent.set(id,{mark,at:time});
  }
  knownSongs=now;
  // The list is often drawn again a moment later (a finished song's tempo and key arrive), which would cut the moment short. So a mark is kept
  // for as long as its animation lasts and put on the new nodes, started where the old ones had got to (--touch-age), then taken off again:
  // a class left behind would keep the reels from turning under the pointer.
  for(const [id,{mark,at}] of recent){
    const age=Math.round(time-at);
    if(age>=LASTS){recent.delete(id);continue;}
    for(const node of document.querySelectorAll(`[data-song="${CSS.escape(id)}"]`)){
      if(node.classList.contains(mark))continue;
      node.classList.add(mark);node.style.setProperty('--touch-age',`-${age}ms`);setTimeout(()=>node.classList.remove(mark),LASTS-age);
    }
  }
}
return {factBadges,songLine,noteArrivals};
}
