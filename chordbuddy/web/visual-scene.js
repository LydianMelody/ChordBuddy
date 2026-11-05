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
  const standIn=!STEM_ORDER.some(role=>tracks[role])&&!!tracks.original;
  if(standIn)for(const role of STEM_ORDER)tracks[role]=standInTrack(tracks.original,STAND_IN_BANDS[role]);
  return {fps:raw.fps,frames:raw.frames,floorDb:raw.floor_db,bandEdges:raw.band_edges_hz,tracks,standIn};
}

// A song whose stems were never split has only the whole mix, so each stem is stood in for by the part of the mix where that
// instrument usually sits (bands: 30-80, 80-180, 180-400, 400-900, 900-2k, 2k-4.5k, 4.5k-10k, 10k-18k Hz). Visuals read them exactly
// like real stems; `frame.stems` is false for anyone who wants to tell. They are rough: "vocals" also moves with guitars in that range.
const STAND_IN_BANDS={bass:[0,1],drums:[0,6,7],other:[2,3,4,5,6],vocals:[3,4,5],piano:[3,4],lead:[4,5,6],rhythm:[2,3]};
const OUTSIDE=Math.round(18/60*255);            // bands outside the instrument's range are turned down 18 dB
function standInTrack(mix,chosen){
  const frames=mix.level.length,level=new Uint8Array(frames),bands=new Uint8Array(mix.bands.length);
  const power=byte=>10**((byte/255*60-60)/10);
  for(let i=0;i<frames;i++){
    let all=0,part=0;
    for(let b=0;b<BAND_COUNT;b++){
      const byte=mix.bands[i*BAND_COUNT+b],p=power(byte),inside=chosen.includes(b);all+=p;if(inside)part+=p;
      bands[i*BAND_COUNT+b]=inside?byte:Math.max(0,byte-OUTSIDE);
    }
    // the mix's loudness, less the share of it outside these bands (same -60..0 dB scale)
    level[i]=Math.max(0,Math.min(255,Math.round(mix.level[i]+10*Math.log10(part/all)/60*255)));
  }
  return {level,bands,brightness:mix.brightness,flux:mix.flux,hits:mix.hits,peakDb:mix.peakDb};
}
// One track of notes, ready to look up by time. A note may carry per-note expression (MPE, or key pressure) as [{time,value}] curves.
function noteTrack(notes,user=false){
  const list=(notes||[]).filter(n=>Number.isFinite(n.start)&&Number.isFinite(n.end)&&n.end>n.start&&Number.isFinite(n.pitch))
    .map(n=>{const out={start:n.start,end:n.end,pitch:n.pitch,velocity:Number.isFinite(n.velocity)?n.velocity:100,strength:1,mine:user||!!n.mine};
      for(const k of ['bend','pressure','slide'])if(n[k]?.length)out[k]=n[k];return out;}).sort((a,b)=>a.start-b.start);
  let longest=0;for(const n of list)longest=Math.max(longest,n.end-n.start);
  let low=Infinity,high=-Infinity;for(const n of list){low=Math.min(low,n.pitch);high=Math.max(high,n.pitch);}
  // your own MIDI (midi-user.js) has real dynamics: its velocity is its strength, unless every one of its notes has the same velocity
  // (then it is measured like the model's). `played` marks the notes whose strength is their velocity.
  const mine=list.filter(n=>n.mine),dynamic=mine.some(n=>n.velocity!==mine[0].velocity);
  for(const n of list){n.played=dynamic&&n.mine;if(n.played)n.strength=Math.max(0,Math.min(1,n.velocity/127));delete n.mine;}
  return {notes:list,longest,low:list.length?low:null,high:list.length?high:null,user,dynamic:dynamic&&mine.length===list.length};
}
function midiTracks(midi,user=new Set()){
  const out={};
  for(const [name,notes] of Object.entries(midi||{}))out[name]=noteTrack(notes,user.has(name));
  return out;
}
// Extra parts from your own MIDI files: each a track of notes plus the controls it really has (sustain, mod wheel, bend...), typed.
function extraParts(extras){
  return (extras||[]).map(x=>({name:x.name,kind:x.kind,signals:x.signals||[],track:noteTrack(x.notes,true),
    hits:(x.notes||[]).map(n=>({start:n.start,strength:Math.max(0,Math.min(1,(n.velocity??100)/127))})).sort((a,b)=>a.start-b.start),
    controls:Object.fromEntries(Object.entries(x.controls||{}).map(([k,points])=>[k,[...points].sort((a,b)=>a.time-b.time)]))}));
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
export function buildScene({content={},music={},midi={},user=[],extras=[],features:raw=null,title='',key=null,lyricGuess=false}={}){
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
  // cues ("pick scratch", "count-in": chart-cues.js) are words, never chords: each shows while the chord it falls on lasts (2 s in silence)
  const cues=(content.cues||[]).filter(c=>Number.isFinite(c.start)&&c.text).map(c=>{
    const under=chords.find(ch=>ch.start<=c.start+1e-6&&c.start<ch.end);
    return {text:String(c.text),start:c.start,end:under&&under.label!==null?under.end:c.start+2};
  }).sort((a,b)=>a.start-b.start);
  return {title,key,duration:content.duration||music?.duration||0,chords,cues,bars,sections,lyrics,midi:noteStrengths(midiTracks(midi,new Set(user)),f),
    extras:extraParts(extras),features:f};
}
export function withFeatures(scene,raw){const f=features(raw);return {...scene,features:f,midi:noteStrengths(scene.midi,f)};}

// The MIDI the model writes has no dynamics (every velocity is 100), so each note's `strength` (0..1) is measured instead: how loud its
// own stem is as the note starts (the vocal melody from the vocals stem; instrumental notes from the loudest of the other pitched stems),
// spread over that track's own range so its quiet notes are near 0 and its loud ones near 1 (from the stand-ins when the stems
// were never split). Until the sound data is loaded, every strength is 1. `velocity` is kept as the file has it.
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
    if(track.dynamic){out[name]=track;continue;}      // your own MIDI with real velocities keeps them
    const raw=track.notes.map(n=>loudness(sourceOf(name,n),n.start)),sorted=[...raw].sort((a,b)=>a-b);
    const lo=sorted[Math.floor(sorted.length*0.1)]??0,hi=sorted[Math.floor(sorted.length*0.95)]??1,span=hi-lo;
    out[name]={...track,notes:track.notes.map((n,i)=>n.played?n:{...n,strength:span>1e-3?Math.max(0,Math.min(1,(raw[i]-lo)/span)):(raw[i]>0?1:0)})};
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
// the cue showing now: {text, start, end, progress}, or null
function cueAt(cues,t){
  const i=lastStartingBy(cues,t),cue=i>=0&&t<cues[i].end?cues[i]:null;
  return cue?{text:cue.text,start:cue.start,end:cue.end,progress:(t-cue.start)/(cue.end-cue.start)}:null;
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
// The value of a [{time,value}] curve at t (the last point at or before it), or `fallback` before the first.
function curveAt(points,t,fallback){
  let lo=0,hi=points.length-1,found=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(points[mid].time<=t){found=mid;lo=mid+1;}else hi=mid-1;}
  return found>=0?points[found].value:fallback;
}
function notesAt(track,t){
  const notes=track.notes,active=[];
  for(let i=lastStartingBy(notes,t);i>=0&&notes[i].start>=t-track.longest;i--){
    const n=notes[i];if(t>=n.end)continue;
    const note={pitch:n.pitch,velocity:n.velocity,strength:n.strength,start:n.start,end:n.end,progress:(t-n.start)/(n.end-n.start)};
    if(n.bend)note.bend=curveAt(n.bend,t,0);if(n.pressure)note.pressure=curveAt(n.pressure,t,0);if(n.slide)note.slide=curveAt(n.slide,t,0);
    active.push(note);
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

// An extra part at a moment: its notes (as frame.notes has them), its last note start (hit: 0..1 velocity, sinceHit, pulse) and the value
// of every control it really has, by key (cc64, cc1, bend, pressure...): gates as true/false, amounts 0..1, bends -1..1.
function extraAt(part,t){
  const out={kind:part.kind,...notesAt(part.track,t),values:{}};
  const h=lastStartingBy(part.hits,t),hit=h>=0?part.hits[h]:null,since=hit?t-hit.start:Infinity;
  out.hit=hit?hit.strength:0;out.sinceHit=since;out.hitIndex=h;out.pulse=hit?hit.strength*Math.exp(-since/0.12):0;
  for(const sig of part.signals){
    const points=part.controls[sig.key];if(!points)continue;
    out.values[sig.key]=sig.type==='gate'?curveAt(points,t,0)>=0.5:curveAt(points,t,0);   // before its first point: off, 0, centered
  }
  return out;
}

/** Everything a visual needs for one moment. t: song seconds; state: {playing, rate (1 = normal), mix (the transport's mix)}. */
// The loop the player is repeating, as a visual sees it (null when none): its range and kind ('section' from R, 'bars' from L, 'custom' from
// the handles), how far through it the song is (0-1), its bars (count) and which of them is playing (1-based, null outside), and pass: which
// time around this is (1 = the first; counted by frameEvents, which sees the wraps).
function loopAt(bars,loop,t){
  if(!loop||!(loop.end>loop.start))return null;
  const inside=bars.filter(bar=>bar.start>=loop.start-0.05&&bar.start<loop.end-0.05),now=inside.findIndex(bar=>t>=bar.start&&t<bar.end);
  return {start:loop.start,end:loop.end,kind:loop.kind||'custom',length:loop.end-loop.start,progress:Math.max(0,Math.min(1,(t-loop.start)/(loop.end-loop.start))),
    bars:inside.length,bar:now>=0?now+1:null,inside:t>=loop.start&&t<loop.end,pass:1};
}
export function sampleFrame(scene,t,{playing=false,rate=1,mix=null,loop=null}={}){
  const time=Math.max(0,Math.min(scene.duration||Infinity,t));
  const frame={time,playing,rate,duration:scene.duration,title:scene.title,key:scene.key,
    chord:chordAt(scene.chords,time),beat:beatAt(scene.bars,time),section:sectionAt(scene.sections,time),
    lyric:lyricAt(scene.lyrics||{lines:[],unplaced:0},time),loop:loopAt(scene.bars,loop,time),cue:cueAt(scene.cues||[],time),tracks:{},notes:{}};
  const f=scene.features;
  frame.stems=!!f&&!f.standIn;
  if(f){
    const index=Math.max(0,Math.min(f.frames-1,Math.round(time*f.fps))),gains=mixGains(mix);
    // without split stems only the recording plays, so the stand-ins follow its level, not the stem channels
    for(const [role,feature] of Object.entries(f.tracks))frame.tracks[role]=trackAt(feature,index,time,(f.standIn?gains.original:gains[role])??1);
  }
  for(const [name,track] of Object.entries(scene.midi))frame.notes[name]=notesAt(track,time);
  frame.midi={};for(const part of scene.extras||[])frame.midi[part.name]=extraAt(part,time);
  return frame;
}
