// The visualizer's view of a song: everything a visual might react to, looked up by song time. Pure, so it can be tested.
// buildScene() gathers the chart (chords, bars, beats, sections), the MIDI tracks and the per-stem features once; sampleFrame() then answers
// "what is happening at this moment" for any time, playing or not. Visuals only ever read frames, so any look can sit on top of this.
import {effectiveMeasures} from './chart-layout.js';
import {chartPresentation} from './chart-presentation.js';
import {spellChord} from './spelling.js';

// The mixer's seven channels, in the player's order (pcm-mixer-core.js). Never reorder.
export const STEM_ORDER=['bass','drums','other','vocals','piano','lead','rhythm'];
export const BAND_COUNT=8;
const UPCOMING=4;                               // chords listed after the current one
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
      .map(n=>({start:n.start,end:n.end,pitch:n.pitch,velocity:Number.isFinite(n.velocity)?n.velocity:100})).sort((a,b)=>a.start-b.start);
    let longest=0;for(const n of list)longest=Math.max(longest,n.end-n.start);
    let low=Infinity,high=-Infinity;for(const n of list){low=Math.min(low,n.pitch);high=Math.max(high,n.pitch);}
    out[name]={notes:list,longest,low:list.length?low:null,high:list.length?high:null};
  }
  return out;
}

/**
 * content, music: the chart document (as the chart page has them). midi: {name: [{start,end,pitch,velocity}]}, e.g. vocal, instrumental.
 * features: the server's /api/visual-features answer, or null while it loads. key: the song's key name, for spelling chords.
 */
export function buildScene({content={},music={},midi={},features:raw=null,title='',key=null}={}){
  const measures=music?.measures?.length?effectiveMeasures(music,content.layout||{}):[];
  const shown=chartPresentation(content,measures);
  const chords=(content.chords||[]).filter(c=>shown.visible(c)&&Number.isFinite(c.start)&&c.end>c.start)
    .map(c=>({start:c.start,end:c.end,label:placeholder(c.label)?null:spellChord(String(c.label))})).sort((a,b)=>a.start-b.start);
  const first=Math.max(0,measures.findIndex(m=>m.end>shown.start+1e-6));
  const bars=measures.map((m,i)=>({start:m.start,end:m.end,number:i-first+1,beats:m.beats?.length?m.beats:[m.start]}));
  const sections=(content.sections||[]).filter(s=>Number.isFinite(s.start)&&s.end>s.start).map(s=>({start:s.start,end:s.end,name:s.name||''}))
    .sort((a,b)=>a.start-b.start);
  return {title,key,duration:content.duration||music?.duration||0,chords,bars,sections,midi:midiTracks(midi),features:features(raw)};
}
export function withFeatures(scene,raw){return {...scene,features:features(raw)};}

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
function notesAt(track,t){
  const notes=track.notes,active=[];
  for(let i=lastStartingBy(notes,t);i>=0&&notes[i].start>=t-track.longest;i--){
    const n=notes[i];if(t<n.end)active.push({pitch:n.pitch,velocity:n.velocity,start:n.start,end:n.end,progress:(t-n.start)/(n.end-n.start)});
  }
  const next=notes[lastStartingBy(notes,t)+1]||null;
  return {active,next:next?{pitch:next.pitch,in:next.start-t}:null,low:track.low,high:track.high};
}
function trackAt(feature,frame,t,gain){
  const shift=gain>0?20*Math.log10(gain)/60:-Infinity;                  // the mixer's level, in the same 0..1 (-60..0 dB) scale
  const scaled=byte=>Math.max(0,Math.min(1,byte/255+shift));
  const bands=new Array(BAND_COUNT);for(let b=0;b<BAND_COUNT;b++)bands[b]=gain>0?scaled(feature.bands[frame*BAND_COUNT+b]):0;
  const h=lastStartingBy(feature.hits,t),hit=h>=0?feature.hits[h]:null,since=hit?t-hit.start:Infinity;
  return {level:gain>0?scaled(feature.level[frame]):0,bands,brightness:feature.brightness[frame]/255,flux:gain>0?feature.flux[frame]/255:0,
    sinceHit:since,hit:hit?hit.strength:0,pulse:hit&&gain>0?hit.strength*Math.exp(-since/0.12):0,gain};
}

/** Everything a visual needs for one moment. t: song seconds; state: {playing, rate (1 = normal), mix (the transport's mix)}. */
export function sampleFrame(scene,t,{playing=false,rate=1,mix=null}={}){
  const time=Math.max(0,Math.min(scene.duration||Infinity,t));
  const frame={time,playing,rate,duration:scene.duration,title:scene.title,key:scene.key,
    chord:chordAt(scene.chords,time),beat:beatAt(scene.bars,time),section:sectionAt(scene.sections,time),tracks:{},notes:{}};
  const f=scene.features;
  if(f){
    const index=Math.max(0,Math.min(f.frames-1,Math.round(time*f.fps))),gains=mixGains(mix);
    for(const [role,feature] of Object.entries(f.tracks))frame.tracks[role]=trackAt(feature,index,time,gains[role]??1);
  }
  for(const [name,track] of Object.entries(scene.midi))frame.notes[name]=notesAt(track,time);
  return frame;
}
