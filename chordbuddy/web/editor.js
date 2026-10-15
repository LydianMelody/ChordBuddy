import {effectiveMeasures} from './chart-layout.js';

export function activeChord(chords, time) {
  if (!Number.isFinite(time)) return null;
  return (chords || []).find(chord => time >= chord.start && time < chord.end) || null;
}

export function isJobActive(job) {
  return !!job && ['starting', 'running', 'cancelling', 'preparing', 'separating', 'refining', 'validating'].includes(job.status);
}

export function jobProgress(job) {
  if(job?.status==='completed')return {percent:100,indeterminate:false};
  if(job?.stage==='notation')return {percent:95,indeterminate:false};
  const total=Number(job?.windows)||0;
  const finished=Math.max(0,(Number(job?.window)||0)-(job?.stage==='window_complete'?0:1));
  const percent=total?Math.min(90,90*finished/total):0;
  return {percent,indeterminate:isJobActive(job)&&percent===0};
}

export function abcChordTokens(abc) {
  const tokens=[];let offset=0;
  for(const line of abc.match(/[^\n]*\n|[^\n]+$/g) || []){
    if(!/^\s*[A-Za-z]:/.test(line)){
      const regex=/"([^"\r\n]*)"|%[^\r\n]*/g;let match;
      while((match=regex.exec(line))!==null){
        if(match[1]===undefined)break;
        if(match[1]&&!/^[\^_<>@]/.test(match[1]))tokens.push({index:offset+match.index,label:match[1]});
      }
    }
    offset+=line.length;
  }
  return tokens;
}

export function abcStructure(abc){
  for(const token of abcChordTokens(abc).reverse())abc=abc.slice(0,token.index)+abc.slice(token.index+token.label.length+2);
  return abc.replace(/^T:[^\r\n]*(?:\r?\n|$)/gm,'');
}

export function updateAbcDraft(content,abc,chords){
  const next={...content,abc,chords};
  if(content.engraving&&abcStructure(abc)!==abcStructure(content.abc))next.engraving={...content.engraving,anchors:[]};
  return next;
}

export function replaceAbcChord(abc, index, label) {
  if (typeof label !== 'string' || !label.trim() || /["\r\n\\]/.test(label) || label.length > 80) {
    throw new Error('Enter a chord label without quotes, line breaks, or backslashes.');
  }
  if (!Number.isInteger(index) || index < 0 || abc[index] !== '"') {
    throw new Error('This chord is not linked to an ABC token. Edit the notation directly.');
  }
  const end = abc.indexOf('"', index + 1);
  if (end < 0 || /[\r\n]/.test(abc.slice(index, end))) throw new Error('The linked ABC chord is incomplete.');
  return abc.slice(0, index + 1) + label.trim() + abc.slice(end);
}

export function validateNote(note) {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) return 'Pitch must be a whole MIDI number from 0 to 127.';
  if (!Number.isFinite(note.start) || note.start < 0) return 'Start must be zero or later.';
  if (!Number.isFinite(note.end) || note.end <= note.start) return 'End must be later than start.';
  if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) return 'Velocity must be a whole number from 1 to 127.';
  if (!Number.isInteger(note.track) || note.track < 0) return 'Track must be a nonnegative whole number.';
  return null;
}

export function pitchName(pitch) {
  return ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][pitch % 12] + (Math.floor(pitch / 12) - 1);
}

export function displayChordLabel(value) {
  const match=/^([A-G](?:#{1,2}|b{1,2})?):?([^/]*)(?:\/(.+))?$/.exec(value || '');if(!match)return value;
  const qualities={maj:'',min:'m',dim:'dim',aug:'aug','7':'7',maj7:'maj7',min7:'m7',dim7:'dim7',hdim7:'m7b5',sus4:'sus4',sus2:'sus2',maj6:'6',min6:'m6','sus4(b7)':'7sus4',minmaj7:'m(maj7)'};
  const root=match[1];let quality=match[2],bass=match[3];
  if(Object.hasOwn(qualities,quality))quality=qualities[quality];else if(!Object.values(qualities).includes(quality))return value;
  if(bass&&!/^[A-G](?:#{1,2}|b{1,2})?$/.test(bass)){
    const degree=/^(#{0,2}|b{0,2})([1-9]|1[0-3])$/.exec(bass);if(!degree)return value;
    const naturals={C:0,D:2,E:4,F:5,G:7,A:9,B:11},letters='CDEFGAB',number=Number(degree[2]);
    const accidental=string=>(string.match(/#/g)||[]).length-(string.match(/b/g)||[]).length;
    const pitch=(naturals[root[0]]+accidental(root)+[0,2,4,5,7,9,11][(number-1)%7]+accidental(degree[1])+120)%12;
    const letter=letters[(letters.indexOf(root[0])+number-1)%7],difference=(pitch-naturals[letter]+18)%12-6;if(Math.abs(difference)>2)return value;
    bass=letter+(difference>0?'#'.repeat(difference):'b'.repeat(-difference));
  }
  return root+quality+(bass?'/'+bass:'');
}

export function editChordContent(content, chordId, label) {
  const next = structuredClone(content);
  const chord = next.chords.find(item => item.id === chordId);
  if (!chord) throw new Error('Chord could not be found.');
  const oldLength = next.abc.length;
  next.abc = replaceAbcChord(next.abc, chord.abc_index, label);
  const difference = next.abc.length - oldLength;
  for (const item of next.chords) if (item.abc_index > chord.abc_index) item.abc_index += difference;
  chord.label = label.trim();
  return next;
}

export function validateChart(content) {
  if (!Number.isFinite(content.duration) || content.duration <= 0) return 'The chart needs a positive recording duration.';
  let previousEnd=0;const ids=new Set();
  for(const section of content.sections || []){
    if(!section.id || ids.has(section.id))return 'Each section needs its own identifier.';
    ids.add(section.id);
    if(typeof section.name!=='string'||!section.name.trim())return 'Give every section a name.';
    if(!Number.isFinite(section.start)||!Number.isFinite(section.end)||section.start<previousEnd||section.end<=section.start||section.end>content.duration+0.001)return 'Sections must be ordered, must not overlap, and must stay within the recording.';
    if(typeof section.lyrics!=='string')return 'Section lyrics must be text.';
    previousEnd=section.end;
  }
  let chordEnd=0;const chordIds=new Set();
  for(const chord of content.chords || []){
    if(!chord.id||chordIds.has(chord.id))return 'Each chord needs its own identifier.';chordIds.add(chord.id);
    if(typeof chord.label!=='string'||!chord.label.trim()||/[\x00\r\n]/.test(chord.label))return 'Enter a nonblank chord label without line breaks.';
    if(!Number.isFinite(chord.start)||!Number.isFinite(chord.end)||chord.start<0||chord.end<=chord.start||chord.end>content.duration+0.001)return 'Every chord needs a valid start and end within the recording.';
    if(chord.start<chordEnd)return 'Chord times must stay ordered without overlapping.';chordEnd=chord.end;
    const section=content.sections.find(item=>item.id===chord.section_id);
    if(!section||chord.start<section.start||chord.start>=section.end)return 'A chord starts outside its section. Adjust the boundaries or chord time.';
    if(chord.line!==null||chord.offset!==null){const line=section.lyrics.split('\n')[chord.line];if(!Number.isInteger(chord.line)||!Number.isInteger(chord.offset)||chord.line<0||chord.offset<0||line===undefined||chord.offset>Array.from(line).length)return 'Place the chord on an existing lyric word.';}
  }
  return null;
}

export function reassignChartChords(content) {
  const next=structuredClone(content);
  for(const chord of next.chords){const section=next.sections.find(item=>chord.start>=item.start&&chord.start<item.end);if(!section)throw new Error('A section boundary would leave a chord outside the chart.');if(chord.section_id!==section.id){chord.section_id=section.id;chord.line=null;chord.offset=null;}}
  const error=validateChart(next);if(error)throw new Error(error);return next;
}

export function reconcileChartLayout(content,music){
  if(!content.layout)return content;
  const measures=effectiveMeasures(music,content.layout);
  content.layout.lines=content.layout.lines.filter(p=>{
    const section=content.sections.find(s=>s.id===p.section_id);
    if(!section||section.lyrics.split('\n')[p.line]===undefined)return false;
    return [p.start_measure,p.end_measure].every(id=>{const m=measures.find(m=>m.id===id);return m&&m.end>section.start+1e-6&&m.start<section.end-1e-6;});
  });return content;
}
export function splitChartSection(content,id,time,newId,music) {
  const next=structuredClone(content);const index=next.sections.findIndex(section=>section.id===id);const section=next.sections[index];
  if(!section || !Number.isFinite(time) || time<=section.start || time>=section.end)throw new Error('Split time must be inside the section.');
  const second={id:newId,name:'New section',start:time,end:section.end,lyrics:''};section.end=time;next.sections.splice(index+1,0,second);return reassignChartChords(reconcileChartLayout(next,music));
}

export function mergeChartSection(content,id,music) {
  const next=structuredClone(content);const index=next.sections.findIndex(section=>section.id===id);const first=next.sections[index],second=next.sections[index+1];
  if(!first || !second)throw new Error('Choose a section with another section after it.');
  const prefix=first.lyrics&&second.lyrics?first.lyrics+'\n\n':first.lyrics||'';const shift=first.lyrics&&second.lyrics?prefix.split('\n').length-1:0;first.lyrics=prefix+second.lyrics;first.end=second.end;
  for(const chord of next.chords)if(chord.section_id===second.id){chord.section_id=first.id;if(chord.line!==null)chord.line+=shift;}
  for(const placement of next.layout?.lines||[])if(placement.section_id===second.id){placement.section_id=first.id;placement.line+=shift;}
  next.sections.splice(index+1,1);return reassignChartChords(next);
}

export function renameChartSection(content,id,name){
  if(typeof name!=='string'||!name.trim()||name.trim().length>200||/[\x00\r\n]/.test(name))throw new Error('Choose a section name from 1 to 200 characters.');
  const next=structuredClone(content),section=next.sections.find(s=>s.id===id);
  if(!section)throw new Error('Section not found.');
  section.name=name.trim();return next;
}

export function mergeAdjacentChartSections(content,id,direction,{acceptGap=false}={}){
  if(!['previous','next'].includes(direction))throw new Error('Choose previous or next.');
  const index=content.sections.findIndex(s=>s.id===id),firstIndex=direction==='previous'?index-1:index;
  const first=content.sections[firstIndex],second=content.sections[firstIndex+1];
  if(index<0||!first||!second)throw new Error('No adjacent section in that direction.');
  if(second.start<first.end)throw new Error('Overlapping sections cannot merge safely.');
  if(second.start>first.end&&!acceptGap)throw new Error('These sections have a gap. Confirm including it in the merged section.');
  return mergeChartSection(content,first.id);
}

export function editChartSection(content,id,fields,music) {
  const next=structuredClone(content);const index=next.sections.findIndex(section=>section.id===id);const section=next.sections[index];if(!section)throw new Error('Section not found.');
  const previous=next.sections[index-1],following=next.sections[index+1];
  if(previous && previous.end===section.start && fields.start!==undefined)previous.end=fields.start;
  if(following && following.start===section.end && fields.end!==undefined)following.start=fields.end;
  Object.assign(section,fields);return reassignChartChords(reconcileChartLayout(next,music));
}

export function editChartChord(content,id,fields) {
  const next=structuredClone(content);const index=next.chords.findIndex(chord=>chord.id===id);const chord=next.chords[index];if(!chord)throw new Error('Chord not found.');
  const previous=next.chords[index-1],following=next.chords[index+1];
  if(previous && previous.end===chord.start && fields.start!==undefined)previous.end=fields.start;
  if(following && following.start===chord.end && fields.end!==undefined)following.start=fields.end;
  Object.assign(chord,fields);return reassignChartChords(next);
}

export function startChordAtMeasure(chords,id,measure) {
  const chord=(chords || []).find(item=>item.id===id),start=measure?.start,end=measure?.end;
  const noChord=label=>{const value=String(label??'').trim().toUpperCase().replace(/[\s.]/g,'');return !value||value==='N'||value==='NC'||value==='NOCHORD';};
  if(!chord||noChord(chord.label)||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||!Number.isFinite(chord.start)||!Number.isFinite(chord.end)||chord.end<=chord.start||chord.start<=start+1e-6||chord.start>=end-1e-6)return null;
  const realChordBefore=(chords || []).some(item=>item.id!==id&&Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start<chord.start-1e-6&&item.end>start+1e-6&&!noChord(item.label));
  return realChordBefore?null:{start,end:chord.end};
}

export function addChartChord(content,time,id,label='C') {
  const next=structuredClone(content);const section=next.sections.find(item=>time>=item.start&&time<item.end);if(!section)throw new Error('Choose a playback time inside a section.');
  if(next.chords.some(chord=>chord.start===time))throw new Error('A chord already starts here. Select it to edit, or choose a later playback time.');
  const containing=next.chords.find(chord=>time>chord.start&&time<chord.end);let end;
  if(containing){end=containing.end;containing.end=time;}
  else end=Math.min(section.end,next.chords.find(chord=>chord.start>time)?.start ?? section.end,time+2);
  next.chords.push({id,label,start:time,end,section_id:section.id,line:null,offset:null});next.chords.sort((a,b)=>a.start-b.start);return reassignChartChords(next);
}

export function settleHistoryResult(record,doc,requestVersion) {
  record.doc=doc;record.error=null;
  if(record.version===requestVersion){record.draft=structuredClone(doc.content);record.dirty=false;}
}
export async function runSectionAction(flush,currentDocument,action=()=>{}){
  const id=currentDocument(),result=await flush();
  if(!result.ok)throw new Error('Finish saving your edits before changing a section.');
  if(currentDocument()!==id)throw new Error('Selected chart changed.');
  return action();
}
