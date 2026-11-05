// Fetches what one song needs to be performed: its bars, sections, audio details and saved arrangement. Used by Prepare and by a running show.
// api(path, body?) is the app's own API call. Reads only.
import {effectiveMeasures} from './chart-layout.js';
import {buildCompactChart} from './compact-chart.js';
import {detectFadeIn,detectFadeOut} from './fade-out.js';
import {sectionLoopRange} from './loop-range.js';
import {defaultMix} from './pcm-mixer-core.js';
import {compilePerformance} from './performance-compiler.js';
import {newPerformance} from './performance-model.js';

const RATE=44100;

/** The song's bars and sections, as the chart has them now. Returns {song, measures, sections, manifest, frames, trim}. */
export async function loadSongGrid(api,songId){
  const detail=await api('/api/song/'+encodeURIComponent(songId));
  const chart=(detail.documents||detail.docs||[]).find(d=>d.kind==='chart');
  if(!chart)throw Error('This song has no chart yet. Analyze it first.');
  const doc=await api('/api/document/'+encodeURIComponent(chart.id));
  const measures=effectiveMeasures(doc.music,doc.content?.layout||{});
  if(!measures.length)throw Error('This song has no bars yet. Analyze it first.');
  const sections=buildCompactChart(doc.content,doc.music).sections.map(s=>({id:s.id,name:s.name,start:s.start,end:s.end}));
  const playback=await api('/api/playback/'+encodeURIComponent(songId));
  const manifest=playback.ready?playback.active:null;
  let trim=null;
  try{
    const wave=manifest?await api('/api/waveform/'+encodeURIComponent(manifest.run_id)):null;
    if(wave?.peaks){
      const beats=measures.flatMap(m=>m.beats||[]);
      const fades={fadeIn:detectFadeIn(wave.peaks,wave.duration,beats),fadeOut:detectFadeOut(wave.peaks,wave.duration,beats)};
      trim=section=>sectionLoopRange(section,measures,{...fades,musicStart:measures[0].start});
    }
  }catch{/* no waveform: R simply loops the whole section */}
  return {song:detail.song,measures,sections,manifest,frames:manifest?.frames??Math.round(measures.at(-1).end*RATE),trim,cues:doc.content?.cues||[]};
}

/** One show entry, ready for the controller. An entry with no performance plays the Original arrangement. */
export async function loadEntry(api,entry){
  const grid=await loadSongGrid(api,entry.songId);
  const performance=entry.performanceId?(await api(`/api/performance/${encodeURIComponent(entry.performanceId)}?revision=${entry.revision}`)).body:newPerformance({songId:entry.songId,id:'original'});
  const compiled=compilePerformance(performance,{measures:grid.measures,frames:grid.frames});
  return {song:grid.song,performance,compiled,grid:{measures:grid.measures,frames:grid.frames},sections:grid.sections,manifest:grid.manifest,trim:grid.trim,baseMix:defaultMix(),cues:grid.cues};
}
