/* Pure projection: canonical recording events are never compressed or retimed. */
import {effectiveMeasures} from './chart-layout.js';
const same=(a,b)=>typeof a===typeof b&&(typeof a==='number'?Math.abs(a-b)<=32*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)):Array.isArray(a)?Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i])):a===b);
const kind=label=>['N','?','UNKNOWN',''].includes(String(label??'').trim().toUpperCase())?'unknown':/^(N\.?C\.?|NO CHORD|REST)$/i.test(label)?'no-chord':'chord';
function coordinate(m,t){
 const points=[...m.beats,m.end],q=m.quarter_positions;
 if(t===m.end)return q?.at(-1)??m.beats.length;
 const i=points.findIndex((p,i)=>i<points.length-1&&t>=p&&t<points[i+1]);if(i<0)return NaN;
 const part=(t-points[i])/(points[i+1]-points[i]);
 return Number.isFinite(q?.[i])&&Number.isFinite(q?.[i+1])?q[i]+part*(q[i+1]-q[i]):i+part;
}
function fragment(content,section,m){
 const start=Math.max(section.start,m.start),end=Math.min(section.end,m.end),events=[];let cursor=start;
 for(const c of content.chords.filter(c=>c.start<end&&c.end>start)){
  const a=Math.max(start,c.start),b=Math.min(end,c.end);
  if(a>cursor)events.push({chordId:null,label:'?',start:cursor,end:a,kind:'unknown',continued:false});
  events.push({chordId:c.id,label:c.label,start:a,end:b,kind:kind(c.label),continued:c.start<a,line:c.line,offset:c.offset,sourceSectionId:c.section_id});cursor=b;
 }
 if(cursor<end)events.push({chordId:null,label:'?',start:cursor,end,kind:'unknown',continued:false});
 const q=m.quarter_positions,units=m.meter?.[0]*4/m.meter?.[1],known=Array.isArray(q)&&q.length===m.beats.length+1&&q.every((v,i)=>Number.isFinite(v)&&(!i||v>q[i-1]));
 const partialStart=start>m.start||/pickup/i.test(m.warning||'')||known&&!same(q[0],0),partialEnd=end<m.end||known&&!same(q.at(-1),units);
 const grid=Array.isArray(m.beats)&&m.beats.length>0&&m.beats[0]===m.start&&m.beats.every((t,i)=>Number.isFinite(t)&&t<m.end&&(!i||t>m.beats[i-1]));
 const eligible=grid&&known&&!partialStart&&!partialEnd&&Array.isArray(m.meter)&&same(q.at(-1),units)&&events.every(e=>e.kind!=='unknown');
 const signature=eligible?[m.meter,units,events.map(e=>[e.label,e.kind,e.continued,coordinate(m,e.start),coordinate(m,e.end)])]:null;
 return {measureId:m.id,start,end,partialStart,partialEnd,events,signature,number:m.number};
}
export const hasCompactPreferences=content=>Object.prototype.hasOwnProperty.call(content.layout||{},'compact');
export function resetCompactPreferences(content){const next=structuredClone(content);if(next.layout)delete next.layout.compact;return next;}
function invalidCompactPreferences(content,measures,exact=true){
 if(!hasCompactPreferences(content))return false;
 const pref=content.layout.compact,ids=new Set(),ranges=[];
 if(!pref||pref.version!==1||!Array.isArray(pref.groups)||pref.groups.length>measures.length+2*content.sections.length||('notice' in pref&&(typeof pref.notice!=='string'||pref.notice.length>1000)))return true;
 for(const g of pref.groups){
  const section=content.sections.find(s=>s.id===g?.section_id);
  if(!g||typeof g.id!=='string'||!g.id.length||g.id.length>300||ids.has(g.id)||(exact&&!section)||!['repeat','expanded'].includes(g.mode)||!Array.isArray(g.passes)||!g.passes.length||g.passes.length>measures.length)return true;
  ids.add(g.id);let last=null;
  for(const p of g.passes){
   if(!p||!Number.isFinite(p.start)||!Number.isFinite(p.end)||!(p.start<p.end)||(exact&&!(section.start<=p.start&&p.end<=section.end))||(last!==null&&last!==p.start))return true;
   const mids=measures.filter(m=>m.start<p.end&&m.end>p.start),cids=content.chords.filter(c=>c.start<p.end&&c.end>p.start).map(c=>c.id);
   if(!Array.isArray(p.measure_ids)||!p.measure_ids.length||!Array.isArray(p.chord_ids)||[p.measure_ids,p.chord_ids].some(ids=>ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length))return true;
   if(exact&&(!mids.length||mids[0].start>p.start||mids.at(-1).end<p.end||!same(p.measure_ids,mids.map(m=>m.id))||!same(p.chord_ids,cids)))return true;
   last=p.end;
  }
  const a=g.passes[0].start,b=g.passes.at(-1).end;if(ranges.some(([x,y])=>a<y&&b>x))return true;ranges.push([a,b]);
 }
 return false;
}
export function applyCompactGroupPreference(content,view,group,mode){
 if(!group||!['repeat','expanded'].includes(mode)||view.mappingKey!==JSON.stringify([content,JSON.parse(view.mappingKey)[1]]))throw Error('Choose a fresh phrase.');
 const next=structuredClone(content),pref=groupPreference(view,group,mode),groups=[];
 // Keep complete non-overlapping passes of existing phrase boundaries. Never nest ranges.
 for(const old of next.layout?.compact?.groups||[]){
  let run=[];const emit=()=>{if(run.length){groups.push({...old,id:old.id.split('@')[0]+'@'+run[0].start,passes:run});run=[];}};
  for(const pass of old.passes){if(pass.start<group.end&&pass.end>group.start)emit();else run.push(pass);}emit();
 }
 groups.push(pref);groups.sort((a,b)=>a.passes[0].start-b.passes[0].start);
 next.layout={bars_per_line:4,breaks:[],lines:[],bar_overrides:[],...next.layout,compact:{version:1,groups}};return next;
}
export function buildCompactChart(content,music){
 let measures=[],warnings=[];try{measures=effectiveMeasures(music,content.layout||{});}catch{warnings.push('Timing layout is unavailable; repeats remain expanded.');}
 if(!measures.length)warnings.push('Measure timing is unavailable. Original chord times remain available.');
 const pref=content.layout?.compact;if(typeof pref?.notice==='string')warnings.push(pref.notice);
 const invalidPref=invalidCompactPreferences(content,measures);
 if(invalidPref)warnings.push('Saved compact layout is unsupported. Reset compact layout to use automatic repeats.');
 const view={sections:[],groups:[],occurrences:[],warnings,mappingKey:JSON.stringify([content,music?.measures])};
 const breaks=new Set(content.layout?.breaks||[]);
 for(const section of content.sections){
  let bars=measures.filter(m=>m.start<section.end&&m.end>section.start).map(m=>fragment(content,section,m));
  // Include regions outside the grid; do not silently drop their chord events.
  const filled=[];let cursor=section.start;
  for(const b of bars){if(b.start>cursor)filled.push(fragment(content,section,{id:null,start:cursor,end:b.start,beats:[]}));filled.push(b);cursor=b.end;}
  if(cursor<section.end)filled.push(fragment(content,section,{id:null,start:cursor,end:section.end,beats:[]}));bars=filled;
  const own={...section,sectionId:section.id,groups:[],lyricLines:String(section.lyrics??'').split('\n')};view.sections.push(own);
  const preferences=[];
  for(const p of invalidPref?[]:pref?.groups||[]){
   if(p.section_id!==section.id)continue;
   const valid=['repeat','expanded'].includes(p.mode)&&Array.isArray(p.passes)&&p.passes.length&&p.passes.every((pass,i)=>Number.isFinite(pass.start)&&Number.isFinite(pass.end)&&pass.start<pass.end&&pass.start>=section.start&&pass.end<=section.end&&(!i||p.passes[i-1].end===pass.start)&&Array.isArray(pass.measure_ids)&&Array.isArray(pass.chord_ids)&&same(pass.measure_ids,bars.filter(b=>b.start>=pass.start&&b.end<=pass.end).map(b=>b.measureId))&&same(pass.chord_ids,[...new Set(bars.filter(b=>b.start>=pass.start&&b.end<=pass.end).flatMap(b=>b.events.map(e=>e.chordId).filter(Boolean)))]));
   if(valid)preferences.push(p);else warnings.push('A saved grouping no longer matches this chart; affected material is expanded.');
  }
  let budget=150000;
  const blocked=bars.map(b=>invalidPref||((pref?.groups||[]).some(p=>p.section_id===section.id)&&preferences.length!==(pref?.groups||[]).filter(p=>p.section_id===section.id).length)||preferences.some(p=>p.mode==='expanded'&&b.start>=p.passes[0].start&&b.end<=p.passes.at(-1).end));
  function candidate(i){const preferred=preferences.filter(p=>p.mode==='repeat').flatMap(p=>p.passes).find(p=>p.start===bars[i].start);const fixed=preferred?bars.filter(b=>b.start>=preferred.start&&b.end<=preferred.end).length:0;let best={unit:fixed||1,count:1,fixed:!!fixed};if(blocked[i]||!bars[i].signature)return best;
   for(let n=fixed||1;n<=(fixed||Math.floor((bars.length-i)/2));n++){
    if(--budget<0)return best;
    if(bars.slice(i,i+n).some((b,j)=>!b.signature||blocked[i+j]||(j&&breaks.has(b.measureId))))break;
    let count=1;
    while(i+(count+1)*n<=bars.length){let equal=true;for(let k=0;k<n;k++){if(--budget<0){equal=false;break;}const at=i+count*n+k;const a=bars[i+k].signature,b=bars[at].signature,ending=n>=3&&k===n-1&&a&&b&&same(a.slice(0,2),b.slice(0,2));if(blocked[at]||breaks.has(bars[at].measureId)||!same(a,b)&&!ending){equal=false;break;}}if(!equal)break;count++;}
    if(count>1&&n*count>best.unit*best.count)best={unit:n,count,fixed:!!fixed};
   }
   return best;
  }
  for(let i=0;i<bars.length;){let {unit,count,fixed}=candidate(i);
   if(count===1&&!fixed){while(unit<4&&i+unit<bars.length&&!breaks.has(bars[i+unit].measureId)&&candidate(i+unit).count===1)unit++;}
   const id=section.id+':'+i,g={id,sectionId:section.id,slots:[],passes:[],folded:count>1,bars:bars.slice(i,i+unit),start:bars[i].start,end:bars[i+unit*count-1].end};
   const endingSignatures=[],variantAt=[];
   for(let p=0;p<count;p++){const signature=bars[i+(p+1)*unit-1].signature;let variant=endingSignatures.findIndex(s=>same(s,signature));if(variant<0){variant=endingSignatures.length;endingSignatures.push(signature);}variantAt.push(variant);}
   g.endingVariants=endingSignatures.length>1?endingSignatures.map((_,v)=>({id:v,passNumbers:variantAt.flatMap((x,p)=>x===v?[p+1]:[])})):[];
   for(let p=0;p<count;p++){
    const batch=bars.slice(i+p*unit,i+(p+1)*unit),pass={number:p+1,start:batch[0].start,end:batch.at(-1).end,measureIds:batch.map(b=>b.measureId).filter(Boolean),occurrenceIds:[]};let slot=0;
    for(const b of batch)for(const e of b.events){const ending=g.endingVariants.length&&b===batch.at(-1),slotId=id+(ending?':ending'+variantAt[p]+':slot':':slot')+slot,oid=id+':p'+(p+1)+':'+slot,o={...e,id:oid,groupId:id,slotId,passNumber:p+1,sectionId:section.id,measureId:b.measureId,ending:!!ending,endingVariant:ending?variantAt[p]:null,partialStart:b.partialStart,partialEnd:b.partialEnd};view.occurrences.push(o);pass.occurrenceIds.push(oid);if(p===0||ending&&!g.slots.some(s=>s.id===slotId))g.slots.push({...o,id:slotId,beatLabel:b.signature?String(1+coordinate(measures.find(m=>m.id===b.measureId),e.start)):'',barNumber:b.number});slot++;}
    g.passes.push(pass);
   }
   own.groups.push(g);view.groups.push(g);i+=unit*count;
  }
  if(budget<=0)warnings.push('Long section: some repeats are expanded to keep the chart responsive.');
 }
 // Canonical holds may extend into a gap after their owning section. Preserve every
 // uncovered interval as an explicit, unfolded continuation in that section's card.
 for(const c of content.chords){
  const mapped=view.occurrences.filter(o=>o.chordId===c.id).sort((a,b)=>a.start-b.start);let cursor=c.start,index=0;
  const add=end=>{if(end<=cursor)return;const own=view.sections.find(s=>s.id===c.section_id);if(!own)return;
   const id=own.id+':continuation:'+c.id+':'+index++,slotId=id+':slot0',oid=id+':p1:0';
   const o={id:oid,chordId:c.id,label:c.label,start:cursor,end,kind:kind(c.label),continued:cursor>c.start,line:c.line,offset:c.offset,sourceSectionId:c.section_id,sectionId:own.id,groupId:id,slotId,passNumber:1,measureId:null,partialStart:true,partialEnd:true};
   const g={id,sectionId:own.id,continuation:true,folded:false,start:cursor,end,bars:[],slots:[{...o,id:slotId,beatLabel:''}],passes:[{number:1,start:cursor,end,measureIds:[],occurrenceIds:[oid]}]};
   view.occurrences.push(o);view.groups.push(g);own.groups.push(g);
  };
  for(const o of mapped){add(o.start);cursor=Math.max(cursor,o.end);}add(c.end);
 }
 view.groups.sort((a,b)=>a.start-b.start);view.occurrences.sort((a,b)=>a.start-b.start);for(const s of view.sections)s.groups.sort((a,b)=>a.start-b.start);
 return view;
}
export function locateCompactPlayback(view,seconds){if(!Number.isFinite(seconds))return null;const o=view.occurrences.find(o=>seconds>=o.start&&seconds<o.end);if(!o)return null;const g=view.groups.find(g=>g.id===o.groupId);return {sectionId:o.sectionId,groupId:o.groupId,slotId:o.kind==='unknown'?null:o.slotId,occurrenceId:o.kind==='unknown'?null:o.id,passNumber:o.passNumber,passCount:g.passes.length};}
export function compactJumpTargets(view,{sectionId,groupId,slotId}){if(!groupId){const s=view.sections.find(s=>s.sectionId===sectionId);return s?[{seconds:s.start,label:s.name,passNumber:1,occurrenceId:null}]:[];}const g=view.groups.find(g=>g.id===groupId);if(!g)return [];return g.passes.map(p=>{const o=slotId?view.occurrences.find(o=>o.groupId===g.id&&o.slotId===slotId&&o.passNumber===p.number):null;if(slotId&&!o)return null;return {seconds:o?.start??p.start,label:'Pass '+p.number,passNumber:p.number,occurrenceId:o?.id??p.occurrenceIds[0]};}).filter(Boolean);}
export function compactEditTargets(view,{groupId,slotId,passNumber,scope}){const g=view.groups.find(g=>g.id===groupId);if(!g||!Number.isInteger(passNumber)||!g.passes.some(p=>p.number===passNumber))throw Error('Choose an explicit pass to edit.');if(!['occurrence','all-matching'].includes(scope))throw Error('Choose an edit scope.');const occurrences=view.occurrences.filter(o=>o.groupId===groupId&&o.slotId===slotId&&(scope==='all-matching'||o.passNumber===passNumber));if(!occurrences.length||occurrences.some(o=>!o.chordId))throw Error('No canonical chord at this position.');const ids=[...new Set(occurrences.map(o=>o.chordId))];if(scope==='occurrence'&&view.occurrences.some(o=>ids.includes(o.chordId)&&o.passNumber!==passNumber&&o.groupId===groupId))throw Error('This held chord is shared across passes. Edit the canonical chord in timing view.');return {chordIds:ids,passes:occurrences.map(o=>o.passNumber)};}
export function groupPreference(view,group,mode){return {id:group.id,section_id:group.sectionId,mode,passes:group.passes.map(p=>({start:p.start,end:p.end,measure_ids:p.measureIds,chord_ids:[...new Set(p.occurrenceIds.map(id=>view.occurrences.find(o=>o.id===id)?.chordId).filter(Boolean))]}))};}
export function reconcileCompactPreferences(content,music){const next=structuredClone(content);if(!hasCompactPreferences(next))return {content:next,warnings:[]};
 if(invalidCompactPreferences(next,effectiveMeasures(music,next.layout||{}),false))throw Error('Reset unsupported compact layout before editing.');
 const pref=next.layout.compact,warnings=[];pref.groups=pref.groups.filter(group=>{const candidate=structuredClone(next);candidate.layout.compact.groups=[group];const v=buildCompactChart(candidate,music);const valid=!invalidCompactPreferences(candidate,effectiveMeasures(music,next.layout||{}))&&!v.warnings.some(w=>w.includes('saved grouping'));if(!valid)warnings.push('A changed grouping is now expanded. Undo restores its layout preference.');return valid;});return {content:next,warnings};}


export function compactLyricTargets(content,music,view,ref){
 const section=content.sections.find(s=>s.id===ref.sectionId);if(!section)return {targets:[],matchingLines:[],shared:false};
 const measures=effectiveMeasures(music,content.layout||{});
 const targetsFor=line=>{const anchors=[];const placement=content.layout?.lines?.find(p=>p.section_id===ref.sectionId&&p.line===line);
  for(const w of placement?.words||[]){const m=measures.find(m=>m.id===w.measure_id),i=Math.floor(w.beat);if(!m)continue;const points=[...m.beats,m.end];if(points[i+1]!==undefined)anchors.push({seconds:points[i]+(w.beat-i)*(points[i+1]-points[i]),offset:w.offset});}
  if(!anchors.length)for(const c of content.chords.filter(c=>c.section_id===ref.sectionId&&c.line===line))anchors.push({seconds:c.start,offset:c.offset,chordId:c.id});
  const result=[];for(const a of anchors){const at=locateCompactPlayback(view,a.seconds);if(!at)continue;let target=result.find(t=>t.groupId===at.groupId&&t.passNumber===at.passNumber);if(!target){target={...at,seconds:a.seconds,label:'Pass '+at.passNumber,chordIds:[],offsets:[]};result.push(target);}target.seconds=Math.min(target.seconds,a.seconds);target.offsets.push(a.offset);if(a.chordId)target.chordIds.push(a.chordId);}
  return result;
 };
 const targets=targetsFor(ref.line),shared=targets.length>1&&targets.every(t=>t.chordIds.length&&t.offsets.includes(0))&&new Set(targets.map(t=>t.groupId)).size===1;
 const matchingLines=[],matchingPasses=[];const lines=section.lyrics.split('\n');
 if(targets.length===1)lines.forEach((text,line)=>{const ts=targetsFor(line);if(text===lines[ref.line]&&ts.length===1&&ts[0].groupId===targets[0].groupId&&!matchingPasses.includes(ts[0].passNumber)){matchingLines.push(line);matchingPasses.push(ts[0].passNumber);}});
 return {targets,shared,matchingLines:shared?[ref.line]:matchingLines,matchingPasses:shared?targets.map(t=>t.passNumber):matchingPasses};
}
