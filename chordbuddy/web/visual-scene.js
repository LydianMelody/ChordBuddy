// The visualizer's view of a song: everything a visual might react to, looked up by song time. Pure, so it can be tested.
// buildScene() gathers the chart (chords, bars, beats, sections), the MIDI tracks and the per-stem features once; sampleFrame() then answers
// "what is happening at this moment" for any time, playing or not. Visuals only ever read frames, so any look can sit on top of this.
import {effectiveMeasures} from './chart-layout.js';
import {chartPresentation} from './chart-presentation.js';
import {spellChord} from './spelling.js';
import {layoutLine,onsetsFromNotes} from './word-layout.js';

// The mixer's seven channels, in the player's order (pcm-mixer-core.js). Never reorder.
export const STEM_ORDER=['bass','drums','other','vocals','piano','lead','rhythm'];
export const BAND_COUNT=8;
const UPCOMING=4;                               // chords listed after the current one
const LONGEST_WORD=2;                           // a line's last word is held at most this long (seconds)
const placeholder=label=>label==null||['','N','?','UNKNOWN'].includes(String(label).trim().toUpperCase());

function decode(text){
  const bytes=typeof atob==='function'?atob(text):Buffer.from(text,'base64').toString('binary');
  const out=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)out[i]=bytes.charCodeAt(i);return out;
}
// Index of the last item whose start is at or before t (items sorted by start), or -1.
function lastStartingBy(items,t){
  let lo=0,hi=items.length-1,found=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(items[mid].start<=t){found=mid;lo=mid+1;}else hi=mid-1;}
  return found;
}
function features(raw){
  if(!raw?.tracks)return null;
  const tracks={};
  for(const [role,track] of Object.entries(raw.tracks)){
    tracks[role]={level:decode(track.level),bands:decode(track.bands),brightness:decode(track.brightness),flux:decode(track.flux),
      hits:(track.hits||[]).map(([time,strength])=>({start:time,strength})),peakDb:track.peak_db};
  }
  return {fps:raw.fps,frames:raw.frames,floorDb:raw.floor_db,bandEdges:raw.band_edges_hz,tracks};
}
function midiTracks(midi){
  const out={};
  for(const [name,notes] of Object.entries(midi||{})){
    const list=(notes||[]).filter(n=>Number.isFinite(n.start)&&Number.isFinite(n.end)&&n.end>n.start&&Number.isFinite(n.pitch))
      .map(n=>({start:n.start,end:n.end,pitch:n.pitch,velocity:Number.isFinite(n.velocity)?n.velocity:100,strength:1})).sort((a,b)=>a.start-b.start);
    let longest=0;for(const n of list)longest=Math.max(longest,n.end-n.start);
    let low=Infinity,high=-Infinity;for(const n of list){low=Math.min(low,n.pitch);high=Math.max(high,n.pitch);}
    out[name]={notes:list,longest,low:list.length?low:null,high:list.length?high:null};
  }
  return out;
}

// Every placed lyric line with each word's time, exactly as the chart places them (pins, spreading, and the melody guess when the
// chart uses it). Lines never placed on the chart have no times and are left out (counted in `unplaced`).
function lyricLines(content,measures,onsets){
  const lines=[];let unplaced=0;
  for(const section of content.sections||[]){
    String(section.lyrics??'').split('\n').forEach((text,line)=>{
      if(!text.trim())return;
      const layout=layoutLine(content,measures,section.id,line,{onsets});
      if(!layout?.placed||!layout.tokens.length){unplaced++;return;}
      const words=layout.tokens.filter(t=>Number.isFinite(t.seconds)).map((t,i,all)=>({text:t.text,start:t.seconds,
        end:i+1<all.length?all[i+1].seconds:Math.min(layout.end,t.seconds+LONGEST_WORD)}));
      if(!words.length){unplaced++;return;}
      lines.push({text:text.trim(),section:section.name||'',start:words[0].start,end:Math.max(words.at(-1).end,words[0].start),words});
    });
  }
  return {lines:lines.sort((a,b)=>a.start-b.start),unplaced};
}

/**
 * content, music: the chart document (as the chart page has them). midi: {name: [{start,end,pitch,velocity}]}, e.g. vocal, instrumental.
 * features: the server's /api/visual-features answer, or null while it loads. key: the song's key name, for spelling chords.
 * lyricGuess: place unpinned words on the vocal melody's notes, as the chart does when its melody guess is on.
 */
export function buildScene({content={},music={},midi={},features:raw=null,title='',key=null,lyricGuess=false}={}){
  const measures=music?.measures?.length?effectiveMeasures(music,content.layout||{}):[];
  const shown=chartPresentation(content,measures);
  const chords=(content.chords||[]).filter(c=>shown.visible(c)&&Number.isFinite(c.start)&&c.end>c.start)
    .map(c=>({start:c.start,end:c.end,label:placeholder(c.label)?null:spellChord(String(c.label))})).sort((a,b)=>a.start-b.start)
    // a chord held over a barline is stored once per bar: one chord to a visual, so "next" is always a change
    .reduce((merged,c)=>{const last=merged.at(-1);if(last&&last.label===c.label&&c.start-last.end<1e-3)last.end=Math.max(last.end,c.end);else merged.push(c);return merged;},[]);
  const first=Math.max(0,measures.findIndex(m=>m.end>shown.start+1e-6));
  const bars=measures.map((m,i)=>({start:m.start,end:m.end,number:i-first+1,beats:m.beats?.length?m.beats:[m.start]}));
  const sections=(content.sections||[]).filter(s=>Number.isFinite(s.start)&&s.end>s.start).map(s=>({start:s.start,end:s.end,name:s.name||''}))
    .sort((a,b)=>a.start-b.start);
  const onsets=lyricGuess&&midi?.vocal?.length?onsetsFromNotes(midi.vocal):null;
  const lyrics=measures.length?lyricLines(content,measures,onsets):{lines:[],unplaced:0};
  const f=features(raw);
  return {title,key,duration:content.duration||music?.duration||0,chords,bars,sections,lyrics,midi:noteStrengths(midiTracks(midi),f),features:f};
}
export function withFeatures(scene,raw){const f=features(raw);return {...scene,features:f,midi:noteStrengths(scene.midi,f)};}

// The MIDI the model writes has no dynamics (every velocity is 100), so each note's `strength` (0..1) is measured instead: how loud its
// own stem is as the note starts (the vocal melody from the vocals stem; instrumental notes from the loudest of the other pitched stems),
// spread over that track's own range so its quiet notes are near 0 and its loud ones near 1. Until stem data is loaded, and for songs
// without stems, every strength is 1. `velocity` is kept as the file has it.
const STRENGTH_SOURCES={vocal:['vocals'],instrumental:['lead','piano','other','rhythm','bass']};
export function noteStrengths(midi,f){
  if(!f)return midi;
  const loudness=(roles,t)=>{                       // loudest of these stems in the first 80 ms of the note (0..1)
    let best=0;const from=Math.max(0,Math.round(t*f.fps)),to=Math.min(f.frames-1,from+Math.round(0.08*f.fps));
    for(const role of roles){const level=f.tracks[role]?.level;if(!level)continue;for(let i=from;i<=to;i++)best=Math.max(best,level[i]);}
    return best/255;
  };
  const vocalStarts=(midi.vocal?.notes||[]).map(n=>n.start);
  const sourceOf=(name,note)=>name==='vocal'||(name==='melody'&&vocalStarts.some(t=>Math.abs(t-note.start)<0.03))?STRENGTH_SOURCES.vocal:STRENGTH_SOURCES.instrumental;
  const out={};
  for(const [name,track] of Object.entries(midi)){
    const raw=track.notes.map(n=>loudness(sourceOf(name,n),n.start)),sorted=[...raw].sort((a,b)=>a-b);
    const lo=sorted[Math.floor(sorted.length*0.1)]??0,hi=sorted[Math.floor(sorted.length*0.95)]??1,span=hi-lo;
    out[name]={...track,notes:track.notes.map((n,i)=>({...n,strength:span>1e-3?Math.max(0,Math.min(1,(raw[i]-lo)/span)):(raw[i]>0?1:0)}))};
  }
  return out;
}

// Effective level of each mixer channel (0 when muted, or when another channel is soloed), as the player applies it.
export function mixGains(mix){
  const gains=mix?.gains||[],mutes=mix?.mutes||[],solos=mix?.solos||[],master=Number.isFinite(mix?.master)?mix.master:1,soloing=solos.some(Boolean);
  const out={};
  STEM_ORDER.forEach((role,i)=>{const on=soloing?!!solos[i]:!mutes[i];out[role]=on?(Number.isFinite(gains[i])?gains[i]:1)*master:0;});
  out.original=master;
  return out;
}

function chordAt(chords,t){
  const i=lastStartingBy(chords,t),current=i>=0&&t<chords[i].end?chords[i]:null;
  const upcoming=[];
  for(let j=i+1;j<chords.length&&upcoming.length<UPCOMING;j++)if(chords[j].label!==null)upcoming.push({label:chords[j].label,start:chords[j].start,in:chords[j].start-t});
  const next=upcoming[0]||null;
  return {label:current?.label??null,start:current?.start??null,end:current?.end??null,index:current?i:-1,
    progress:current?(t-current.start)/(current.end-current.start):0,next,timeToNext:next?next.start-t:null,upcoming};
}
function beatAt(bars,t){
  const i=lastStartingBy(bars,t),bar=i>=0&&t<bars[i].end?bars[i]:null;
  if(!bar)return {bar:null,beat:null,beats:null,phase:0,barPhase:0,bpm:null};
  const points=[...bar.beats,bar.end];let b=0;while(b<bar.beats.length-1&&points[b+1]<=t)b++;
  const length=points[b+1]-points[b];
  return {bar:bar.number,beat:b+1,beats:bar.beats.length,phase:length>0?(t-points[b])/length:0,barPhase:(t-bar.start)/(bar.end-bar.start),bpm:length>0?60/length:null};
}
function sectionAt(sections,t){
  const i=lastStartingBy(sections,t),current=i>=0&&t<sections[i].end?sections[i]:null,next=sections[i+1]||null;
  return {name:current?.name??null,index:current?i:-1,progress:current?(t-current.start)/(current.end-current.start):0,next:next?{name:next.name,in:next.start-t}:null};
}
function lyricAt(lyrics,t){
  const lines=lyrics.lines;let i=lastStartingBy(lines,t);
  while(i>0&&t>=lines[i].end&&lines[i-1].end>t)i--;                    // overlapping lines: the one still being sung
  const line=i>=0&&t<lines[i].end?lines[i]:null,next=lines[lastStartingBy(lines,t)+1]||null;   // the next line to start
  const result={line:null,word:null,words:[],next:next?{text:next.text,in:next.start-t}:null,unplaced:lyrics.unplaced};
  if(!line)return result;
  const w=lastStartingBy(line.words,t),word=w>=0?line.words[w]:null;
  result.line={text:line.text,section:line.section,start:line.start,end:line.end,progress:(t-line.start)/(line.end-line.start||1),index:i};
  result.word=word&&t<word.end?{text:word.text,index:w,start:word.start,end:word.end,progress:(t-word.start)/(word.end-word.start||1)}:null;
  result.words=line.words.map((x,n)=>({text:x.text,start:x.start,end:x.end,state:n<w||(n===w&&t>=x.end)?'sung':n===w?'now':'ahead'}));
  return result;
}
function notesAt(track,t){
  const notes=track.notes,active=[];
  for(let i=lastStartingBy(notes,t);i>=0&&notes[i].start>=t-track.longest;i--){
    const n=notes[i];if(t<n.end)active.push({pitch:n.pitch,velocity:n.velocity,strength:n.strength,start:n.start,end:n.end,progress:(t-n.start)/(n.end-n.start)});
  }
  const next=notes[lastStartingBy(notes,t)+1]||null;
  return {active,next:next?{pitch:next.pitch,strength:next.strength,in:next.start-t}:null,low:track.low,high:track.high};
}
function trackAt(feature,frame,t,gain){
  const shift=gain>0?20*Math.log10(gain)/60:-Infinity;                  // the mixer's level, in the same 0..1 (-60..0 dB) scale
  const scaled=byte=>Math.max(0,Math.min(1,byte/255+shift));
  const bands=new Array(BAND_COUNT);for(let b=0;b<BAND_COUNT;b++)bands[b]=gain>0?scaled(feature.bands[frame*BAND_COUNT+b]):0;
  const h=lastStartingBy(feature.hits,t),hit=h>=0?feature.hits[h]:null,since=hit?t-hit.start:Infinity;
  return {level:gain>0?scaled(feature.level[frame]):0,bands,brightness:feature.brightness[frame]/255,flux:gain>0?feature.flux[frame]/255:0,
    sinceHit:since,hit:hit?hit.strength:0,hitIndex:h,pulse:hit&&gain>0?hit.strength*Math.exp(-since/0.12):0,gain};
}

/** Everything a visual needs for one moment. t: song seconds; state: {playing, rate (1 = normal), mix (the transport's mix)}. */
export function sampleFrame(scene,t,{playing=false,rate=1,mix=null}={}){
  const time=Math.max(0,Math.min(scene.duration||Infinity,t));
  const frame={time,playing,rate,duration:scene.duration,title:scene.title,key:scene.key,
    chord:chordAt(scene.chords,time),beat:beatAt(scene.bars,time),section:sectionAt(scene.sections,time),
    lyric:lyricAt(scene.lyrics||{lines:[],unplaced:0},time),tracks:{},notes:{}};
  const f=scene.features;
  if(f){
    const index=Math.max(0,Math.min(f.frames-1,Math.round(time*f.fps))),gains=mixGains(mix);
    for(const [role,feature] of Object.entries(f.tracks))frame.tracks[role]=trackAt(feature,index,time,gains[role]??1);
  }
  for(const [name,track] of Object.entries(scene.midi))frame.notes[name]=notesAt(track,time);
  return frame;
}
