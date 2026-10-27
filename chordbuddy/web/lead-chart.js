// The lead sheet shows the chord chart's chords and section names, as it shows its words: the chart is their one home. Pure: no DOM.
// The score's own chord symbols are taken out and the chart's chords written onto the notes (and rests) where they start, in recording
// time; the chart's sections name the bars where they begin. The notes themselves stay the score's.
import {secondsAtQuarter} from './lead-lyrics.js';
import {isNoChordLabel} from './chart-layout.js';

const EARLY=.08;          // a chord or section a hair before a note still starts on it (beat tracking is not perfect)

// Where the score's own chord symbols are: "..." in the music, but not the annotations ("^text", "_text", "<text", ">text", "@text"),
// and nothing in the header, in field lines (V:, w: ...) or comments.
export function chordSymbolSpans(abc){
  const spans=[];let at=0,body=false;
  for(const line of abc.split('\n')){
    const start=at;at+=line.length+1;
    if(!body){if(/^\s*K:/.test(line))body=true;continue;}
    if(/^\s*(%|[A-Za-z]:)/.test(line))continue;
    const music=line.split('%')[0];
    for(const m of music.matchAll(/"([^"]*)"/g))if(!/^[\^_<>@]/.test(m[1]))spans.push([start+m.index,start+m.index+m[0].length]);
  }
  return spans;
}

// When each score event (note or rest of the melody voice) starts. measures: the chart's bars, in recording time.
export function eventTimes(analysis,measures){
  return analysis.events.map(e=>{const m=measures[e.timeMeasure];return m?secondsAtQuarter(m,(e.offset||0)*4):null;});
}

// The score with the chart's chords in place of its own, and the chart's section names by score bar.
// chart: {chords:[{id,label,start,end}], sections:[{name,start}]}. spell: how a chord name is written for the key.
// Returns {abc, chords:[{id,label,start,end,abc_index}], sections:[{name,measure}]}; abc_index is where the chord sits in the new abc.
export function placeChartOnScore(abc,analysis,measures,chart,spell=label=>label){
  const times=eventTimes(analysis,measures),order=analysis.events.map((e,i)=>i).filter(i=>Number.isFinite(times[i]));
  const taken=new Map();       // event index -> chord
  // each chord starts on the first event inside it; a chord no event starts inside (it begins mid-note) takes the event sounding then
  const sounding=t=>{let best=null;for(const i of order)if(times[i]<=t+EARLY)best=i;return best;};
  for(const chord of [...(chart.chords||[])].sort((a,b)=>a.start-b.start)){
    if(!chord.label||isNoChordLabel(chord.label))continue;
    const inside=order.find(i=>times[i]>=chord.start-EARLY&&times[i]<chord.end-EARLY);
    const at=inside??sounding(chord.start);
    if(at!==null&&at!==undefined&&!taken.has(at))taken.set(at,chord);
  }
  const inserts=[...taken].map(([i,chord])=>({at:analysis.events[i].startChar,chord})).sort((a,b)=>a.at-b.at);
  const spans=chordSymbolSpans(abc);
  let out='',from=0,s=0,k=0;const chords=[];
  // walk the text once: drop the old symbols, write the new ones just before their note
  while(from<=abc.length){
    const nextSpan=spans[s]?.[0]??Infinity,nextInsert=inserts[k]?.at??Infinity,next=Math.min(nextSpan,nextInsert,abc.length);
    out+=abc.slice(from,next);from=next;
    if(nextInsert===next){const {chord}=inserts[k++];chords.push({id:chord.id,label:chord.label,start:chord.start,end:chord.end,abc_index:out.length});out+='"'+spell(chord.label)+'"';continue;}
    if(nextSpan===next){from=spans[s++][1];continue;}
    break;
  }
  const sections=[];
  for(const section of [...(chart.sections||[])].sort((a,b)=>a.start-b.start)){
    const i=order.find(i=>times[i]>=section.start-EARLY);if(i===undefined)continue;
    const measure=analysis.events[i].measure;
    if(!sections.some(x=>x.measure===measure))sections.push({name:section.name,measure});
  }
  return {abc:out,chords,sections};
}
