/* Pure projection: canonical recording events are never compressed or retimed. */
import {chartPresentation} from './chart-presentation.js';
import {effectiveMeasures} from './chart-layout.js';
const same=(a,b)=>typeof a===typeof b&&(typeof a==='number'?Math.abs(a-b)<=32*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)):Array.isArray(a)?Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i])):a===b);
const kind=label=>['N','?','UNKNOWN',''].includes(String(label??'').trim().toUpperCase())?'unknown':/^(N\.?C\.?|NO CHORD|REST)$/i.test(label)?'no-chord':'chord';
// A bar whose beats were re-gridded (a corrected timing, a split or moved barline) has no stored quarter-note positions. Where its beats are
// regular, number them evenly so it can still be compared with, and folded into, the bars around it.
function quarters(m){
 const q=m.quarter_positions;
 if(Array.isArray(q)&&q.length===m.beats.length+1&&q.some(v=>Number.isFinite(v)))return q;
 const den=m.meter?.[1],n=m.beats.length;
 if(!(den>0)||!n||!(n===m.meter[0]||m.user_edited))return q;
 return [...m.beats.map((_,i)=>i*4/den),n*4/den];
}
function coordinate(m,t){
 const points=[...m.beats,m.end],q=quarters(m);
 if(t===m.end)return q?.at(-1)??m.beats.length;
 const i=points.findIndex((p,i)=>i<points.length-1&&t>=p&&t<points[i+1]);if(i<0)return NaN;
 const part=(t-points[i])/(points[i+1]-points[i]);
 return Number.isFinite(q?.[i])&&Number.isFinite(q?.[i+1])?q[i]+part*(q[i+1]-q[i]):i+part;
}
// A chord held over from the bar before (the last chord of the previous pass) does not make a repeated bar different.
// Chord changes within about a tenth of a beat of each other count as the same place when looking for repeats.
const beat8=x=>Math.round(x*8)/8;
function fragment(content,section,m){
 const start=Math.max(section.start,m.start),end=Math.min(section.end,m.end),events=[];let cursor=start;
 for(const c of content.chords.filter(c=>c.start<end&&c.end>start)){
  const a=Math.max(start,c.start),b=Math.min(end,c.end);
  if(a>cursor)events.push({chordId:null,label:'?',start:cursor,end:a,kind:'unknown',continued:false});
  events.push({chordId:c.id,label:c.label,start:a,end:b,kind:kind(c.label),continued:c.start<a,line:c.line,offset:c.offset,sourceSectionId:c.section_id});cursor=b;
 }
 if(cursor<end)events.push({chordId:null,label:'?',start:cursor,end,kind:'unknown',continued:false});
 const q=quarters(m),synthetic=q!==m.quarter_positions,units=synthetic?m.beats.length*4/m.meter[1]:m.meter?.[0]*4/m.meter?.[1],known=Array.isArray(q)&&q.length===m.beats.length+1&&q.every((v,i)=>Number.isFinite(v)&&(!i||v>q[i-1]));
 const partialStart=start>m.start||/pickup/i.test(m.warning||'')||known&&!same(q[0],0),partialEnd=end<m.end||known&&!same(q.at(-1),units);
 const grid=Array.isArray(m.beats)&&m.beats.length>0&&m.beats[0]===m.start&&m.beats.every((t,i)=>Number.isFinite(t)&&t<m.end&&(!i||t>m.beats[i-1]));
 const eligible=grid&&known&&!partialStart&&!partialEnd&&Array.isArray(m.meter)&&same(q.at(-1),units)&&events.every(e=>e.kind!=='unknown');
 const signature=eligible?[m.meter,units,events.map(e=>[e.label,e.kind,e.continued&&e.start>start,beat8(coordinate(m,e.start)),beat8(coordinate(m,e.end))])]:null;
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
export function applyCompactGroupPreference(content,view,group,mode,custom=null){
 if(!group||!['repeat','expanded'].includes(mode)||view.mappingKey!==JSON.stringify([content,JSON.parse(view.mappingKey)[1]]))throw Error('Choose a fresh phrase.');
 const next=structuredClone(content),pref=custom||groupPreference(view,group,mode),groups=[];
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
 // Silence before the song starts is not a bar: phrases of four are counted from the first bar with music in it.
 const musicStart=chartPresentation(content,measures).start;
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
  let lead=0;while(lead<bars.length-1&&bars[lead].end<=musicStart+1e-6)lead++;
  let budget=150000;
  const blocked=bars.map(b=>invalidPref||((pref?.groups||[]).some(p=>p.section_id===section.id)&&preferences.length!==(pref?.groups||[]).filter(p=>p.section_id===section.id).length)||preferences.some(p=>p.mode==='expanded'&&b.start>=p.passes[0].start&&b.end<=p.passes.at(-1).end));
  function candidate(i){const preferred=preferences.filter(p=>p.mode==='repeat').flatMap(p=>p.passes).find(p=>p.start===bars[i].start);const fixed=preferred?bars.filter(b=>b.start>=preferred.start&&b.end<=preferred.end).length:0;let best={unit:fixed||1,count:1,fixed:!!fixed};if(blocked[i]||!bars[i].signature)return best;
   for(let n=fixed||1;n<=(fixed||Math.floor((bars.length-i)/2));n++){
    if(--budget<0)return best;
    if(bars.slice(i,i+n).some((b,j)=>!b.signature||blocked[i+j]||(j&&breaks.has(b.measureId))))break;
    // A chord held across the bar line is only ignored when the repeating part has at least two chord changes of its own; one long chord is not a repeat.
    const starts=bars.slice(i,i+n).reduce((s,b)=>s+b.events.filter(e=>!e.continued).length,0),held=bars[i].events[0]?.continued;
    let count=1;
    while(i+(count+1)*n<=bars.length){let equal=starts>=2||bars[i+count*n].events[0]?.continued===held;for(let k=0;k<n;k++){if(--budget<0){equal=false;break;}const at=i+count*n+k;const a=bars[i+k].signature,b=bars[at].signature,ending=n>=3&&k===n-1&&a&&b&&same(a.slice(0,2),b.slice(0,2));if(blocked[at]||breaks.has(bars[at].measureId)||!same(a,b)&&!ending){equal=false;break;}}if(!equal)break;count++;}
    if(count>1&&n*count>best.unit*best.count)best={unit:n,count,fixed:!!fixed};
   }
   return best;
  }
  for(let i=0;i<bars.length;){let {unit,count,fixed}=candidate(i);
   if(count===1&&!fixed){while(unit<4+(i===0?lead:0)&&i+unit<bars.length&&!breaks.has(bars[i+unit].measureId)&&candidate(i+unit).count===1)unit++;}
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



// ---- Choosing how a repeating stretch is folded: the same bars as 2 bars x4, 4 bars x2, or not folded at all ----
export function compactFoldChoices(view,group){
 if(!group?.folded||!group.passes?.length)return [];
 const unit=group.bars.length,total=unit*group.passes.length,out=[];
 for(let u=unit;u<=Math.min(total/2,16);u+=unit){
  if(total%u||(u>unit&&group.endingVariants?.length>1))continue;
  out.push({unit:u,count:total/u,current:u===unit,label:u+(u===1?' bar':' bars')+' ×'+total/u});
 }
 out.push({expanded:true,current:false,label:'Not folded (write out every pass)'});
 return out;
}
export function applyCompactFold(content,music,view,group,choice){
 if(choice.expanded)return applyCompactGroupPreference(content,view,group,'expanded');
 const section=content.sections.find(s=>s.id===group.sectionId);if(!section)throw Error('Choose a fresh phrase.');
 const measures=effectiveMeasures(music,content.layout||{}),byId=new Map(measures.map(m=>[m.id,m]));
 const ids=group.passes.flatMap(p=>p.measureIds),bars=ids.map(id=>byId.get(id));
 if(bars.some(b=>!b)||ids.length%choice.unit)throw Error('Choose a fresh phrase.');
 const passes=[];
 for(let i=0;i<ids.length;i+=choice.unit){
  const frags=bars.slice(i,i+choice.unit).map(m=>fragment(content,section,m));
  passes.push({start:frags[0].start,end:frags.at(-1).end,measure_ids:ids.slice(i,i+choice.unit),chord_ids:[...new Set(frags.flatMap(f=>f.events.map(e=>e.chordId).filter(Boolean)))]});
 }
 return applyCompactGroupPreference(content,view,group,'repeat',{id:group.id,section_id:group.sectionId,mode:'repeat',passes});
}

// ---- Fix repeats by hand: pick the first and last bar of a stretch, then say how it repeats ----
function rangeBars(content,music,fromId,toId){
 const measures=effectiveMeasures(music,content.layout||{}),a=measures.findIndex(m=>m.id===fromId),b=measures.findIndex(m=>m.id===toId);
 if(a<0||b<0)return {problem:'Pick two bars on the chart.'};
 const lo=Math.min(a,b),hi=Math.max(a,b),span=measures.slice(lo,hi+1);
 const owner=m=>content.sections.find(s=>m.start<s.end&&m.end>s.start&&(m.start+m.end)/2>=s.start&&(m.start+m.end)/2<s.end);
 const section=owner(span[0]);
 if(!section||span.some(m=>owner(m)!==section))return {problem:'Pick bars inside one section. Repeats cannot cross a section name.'};
 return {section,span,bars:span.map(m=>fragment(content,section,m))};
}
export function compactRangeChoices(content,music,fromId,toId){
 const r=rangeBars(content,music,fromId,toId);if(r.problem)return r;
 const {section,span,bars}=r,L=bars.length,breaks=new Set(content.layout?.breaks||[]);
 const out={section,measureIds:span.map(m=>m.id),length:L,choices:[],problem:null};
 if(L<2){out.problem='Pick at least two bars.';return out;}
 if(bars.some(b=>!b.signature)){out.problem='Some of these bars cannot be compared (a pickup, a gap, or unclear timing), so they cannot be folded.';return out;}
 if(span.slice(1).some(m=>breaks.has(m.id))){out.problem='There is a manual line break inside these bars. Remove it first.';return out;}
 let firstMiss=null;
 for(let u=1;u<=L/2;u++){
  if(L%u)continue;
  let miss=null;const starts=bars.slice(0,u).reduce((s,b)=>s+b.events.filter(e=>!e.continued).length,0);
  for(let p=1;p<L/u&&!miss;p++)for(let k=0;k<u;k++){
   if(!k&&starts<2&&bars[p*u].events[0]?.continued!==bars[0].events[0]?.continued){miss=[span[0].number,span[p*u].number];break;}
   const x=bars[k].signature,y=bars[p*u+k].signature,ending=u>=3&&k===u-1&&same(x.slice(0,2),y.slice(0,2));
   if(!same(x,y)&&!ending){miss=[span[k].number,span[p*u+k].number];break;}
  }
  if(!miss)out.choices.push({unit:u,count:L/u,label:u+(u===1?' bar':' bars')+' ×'+L/u});
  else if(!firstMiss||u===L/2)firstMiss=miss;
 }
 if(!out.choices.length)out.problem=L%2&&L>1&&!firstMiss?'These bars do not split into equal passes.':'These bars do not repeat exactly'+(firstMiss?': bar '+firstMiss[1]+' differs from bar '+firstMiss[0]+'.':'.');
 out.choices.push({expanded:true,label:'Not folded (write out every pass)'});
 return out;
}
export function applyCompactRange(content,music,view,fromId,toId,choice){
 const r=rangeBars(content,music,fromId,toId);if(r.problem)throw Error(r.problem);
 const {section,span,bars}=r,unit=choice.expanded?bars.length:choice.unit;
 if(bars.length%unit)throw Error('Choose a fresh phrase.');
 const passes=[];
 for(let i=0;i<bars.length;i+=unit){
  const frags=bars.slice(i,i+unit);
  passes.push({start:frags[0].start,end:frags.at(-1).end,measure_ids:span.slice(i,i+unit).map(m=>m.id),chord_ids:[...new Set(frags.flatMap(f=>f.events.map(e=>e.chordId).filter(Boolean)))]});
 }
 const pref={id:section.id+'@'+passes[0].start,section_id:section.id,mode:choice.expanded?'expanded':'repeat',passes};
 return applyCompactGroupPreference(content,view,{start:passes[0].start,end:passes.at(-1).end},pref.mode,pref);
}
