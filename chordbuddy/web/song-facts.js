// Tempo and key of every song, for the badges in the song lists (the sidebar and All songs) and a set list's total length.
// A song's facts come from its chart and the model's key (key.lab), worked out as the open song's are (chooseKey); a key picked from
// the key chip wins. They are read once per analysis, one song at a time, and the open song's are kept up to date from its page.
import {chooseKey,parseKeyLab,KEY_CHOICES} from './key-estimate.js';
import {isNoChordLabel} from './chart-layout.js';

// "C# minor" -> "C♯m", "Eb major" -> "E♭": short enough for a badge
export function shortKey(label){
  const m=/^\s*([A-G])([#b]?)\s*(major|minor)/i.exec(label||'');if(!m)return '';
  return m[1]+(m[2]==='#'?'♯':m[2]==='b'?'♭':'')+(/minor/i.test(m[3])?'m':'');
}
// 305 -> "5:05", 4321 -> "1:12:01"
export function totalLabel(seconds){
  const s=Math.max(0,Math.round(seconds||0)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=String(s%60).padStart(2,'0');
  return h?`${h}:${String(m).padStart(2,'0')}:${r}`:`${m}:${r}`;
}
export function keyLabelFor(modelKey,chords,saved){
  if(KEY_CHOICES.includes(saved))return saved;
  return chooseKey(modelKey,(chords||[]).filter(c=>!isNoChordLabel(c.label))).key?.label||null;
}

// facts: Map(song id -> {run, bpm, key}); load(song) fills it in the background and calls onChange when something new arrives.
export function createSongFacts({api,savedKey=()=>'',onChange=()=>{}}){
  const facts=new Map(),queue=[];let running=false,reading=null;
  async function read(song){
    const detail=await api(`/api/song/${encodeURIComponent(song.id)}`);
    const charts=(detail.documents||[]).filter(d=>d.kind==='chart'),chart=charts.find(d=>d.kept)||charts[0];
    const keyDoc=(detail.documents||[]).find(d=>/(^|\/)key\.lab$/.test(d.name));
    const doc=chart?await api(`/api/document/${encodeURIComponent(chart.id)}`):null;
    const modelKey=keyDoc?parseKeyLab((await api(`/api/document/${encodeURIComponent(keyDoc.id)}`)).content?.text):null;
    const bpm=doc?.music?.timing?.bpm;
    return {run:song.active_run,bpm:Number.isFinite(bpm)?Math.round(bpm):null,key:keyLabelFor(modelKey,doc?.content?.chords,savedKey(song.id)),modelKey,chords:doc?.content?.chords||[]};
  }
  async function drain(){
    if(running)return;running=true;
    try{while(queue.length){const song=queue.shift();reading=song.id;try{facts.set(song.id,await read(song));onChange();}catch{facts.set(song.id,{run:song.active_run,bpm:null,key:null});}}}
    finally{running=false;reading=null;}
  }
  return {
    get:id=>facts.get(id)||null,
    // ask for the facts of these songs (only those analyzed, and only when their analysis changed since they were read)
    want(songs){for(const song of songs)if(song.active_run&&facts.get(song.id)?.run!==song.active_run&&reading!==song.id&&!queue.some(s=>s.id===song.id))queue.push(song);drain();},
    // the open song, straight from its page (its chords may have just been edited, or a key picked)
    set(id,run,bpm,key){const old=facts.get(id),next={...old,run,bpm:Number.isFinite(bpm)?Math.round(bpm):null,key};if(!old||old.bpm!==next.bpm||old.key!==next.key||old.run!==run){facts.set(id,next);onChange();}},
  };
}
