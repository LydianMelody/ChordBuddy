// Cues: short notes on the chart ("pick scratch", "count-in", "feedback"), each at a moment of the recording and kept apart from the
// chords (content.cues: [{id, text, start}], sorted by start; chart.py checks them). A cue never changes a chord, and a chord edit never
// moves a cue. On the page a cue sits in a thin lane above the chord being played at its moment, in its own pass. Pure.
import {playbackTarget} from './chart-model.js';

export const CUE_LENGTH=40;

// What was typed, as a cue's words: one line, spaces tidied. '' means no cue. Throws when it is too long to read at a glance.
export function cueWords(typed){
  const text=String(typed??'').replace(/\s+/g,' ').trim();
  if(text.length>CUE_LENGTH)throw Error('Keep a cue short: '+CUE_LENGTH+' letters at most, like “pick scratch” or “count-in”.');
  return text;
}

// Where each cue is drawn: Map(chunk key -> [{cue, passNumber}]). A cue in silence the chart hides (before the first chord, after the
// last) goes on the nearest chord, so it is never lost.
export function placeCues(model,cues){
  const out=new Map(),occurrences=model?.projection?.occurrences||[];
  if(!occurrences.length)return out;
  for(const cue of cues||[]){
    if(!Number.isFinite(cue?.start))continue;
    let target=playbackTarget(model,cue.start);
    if(!target){
      const o=occurrences.find(o=>o.start>cue.start)||occurrences.at(-1);
      target={chunkKey:o.groupId+':'+o.slotId,passNumber:o.passNumber};
    }
    if(!out.has(target.chunkKey))out.set(target.chunkKey,[]);
    out.get(target.chunkKey).push({cue,passNumber:target.passNumber});
  }
  return out;
}

const sorted=cues=>[...cues].sort((a,b)=>a.start-b.start);
// A new cue at each of these times (one per pass picked), unless the same words are already there.
export function addCues(content,starts,text,newId){
  const next=structuredClone(content),cues=next.cues||[];
  for(const start of starts)if(Number.isFinite(start)&&!cues.some(c=>c.text===text&&Math.abs(c.start-start)<1e-6))cues.push({id:newId(),text,start});
  next.cues=sorted(cues);return next;
}
// Retype a cue; no words removes it.
export function editCue(content,id,text){
  const next=structuredClone(content),cues=next.cues||[],at=cues.findIndex(c=>c.id===id);
  if(at<0)throw Error('That cue is no longer on the chart.');
  if(text)cues[at].text=text;else cues.splice(at,1);
  next.cues=cues;return next;
}
