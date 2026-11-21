// The chart as a page: sections -> repeat groups -> bars -> chord chunks, with every lyric word sitting under the chord it
// falls within. Pure (no DOM). The grouping, bar clipping and pass mapping are the proven rules of the compact chart;
// word times come from word-layout.js (pins, then even spacing between pins).
import {chartPresentation} from './chart-presentation.js';
import {BARLINE_SLACK} from './compact-chart.js';
import {usualBeats,isOddBar} from './bar-lengths.js';
import {buildCompactChart} from './compact-chart.js';
import {effectiveMeasures} from './chart-layout.js';
import {layoutLine} from './word-layout.js';
import {musicalPosition,secondsAtMusicalPosition} from './musical-grid.js';

const finite=Number.isFinite;
const EPS=1e-7;

// trueTiming: every word is drawn in the row where it is sung, so a pickup (words sung in the last bar of the row before) lands there.
// Without it each word stays with its own lyric line: a pickup is drawn at the start of its line's row, whatever the timing says.
export function buildChartModel(content,music,{onsets=null,trueTiming=false}={}){
  const projection=buildCompactChart(content,music);
  let measures=[];try{measures=effectiveMeasures(music,content.layout||{});}catch{measures=[];}
  const presentation=chartPresentation(content,measures,music?.sound_start,music?.sound_end);
  // Silence before the song starts is not a bar: bar 1 is the first bar with music in it. (Numbers stored with the bars never change; this is only what is shown.)
  // A bar that only reaches a few ms into the music (the same wobble as compact-chart.js allows at barlines) is still silence.
  const barOffset=measures.filter(m=>m.end<=presentation.start+BARLINE_SLACK).length;
  const usual=usualBeats(measures);
  const ctx={content,music,projection,measures,presentation,onsets,barOffset,usual,trueTiming,layouts:new Map()};
  // A section that lies wholly in the hidden silence before or after the music is not shown either (nor counted).
  const audible=section=>section.end>presentation.start+BARLINE_SLACK&&section.start<presentation.end-BARLINE_SLACK;
  const sections=projection.sections.filter(audible).map((section,index)=>({
    id:section.id,name:section.name,number:index+1,start:section.start,end:section.end,
    groups:section.groups.map(group=>buildGroup(ctx,section,group)).filter(Boolean),
  }));
  return {projection,measures,presentation,sections,barOffset,usualBeats:usual,warnings:projection.warnings};
}

function barsOf(ctx,section,group,rep){
  const {projection,measures,presentation}=ctx;
  let bars=rep.measureIds.map(id=>measures.find(m=>m.id===id)).filter(Boolean)
    .map(m=>({...m,viewStart:Math.max(m.start,rep.start,section.start),viewEnd:Math.min(m.end,rep.end,section.end)}));
  const unmapped=projection.occurrences.filter(o=>o.groupId===group.id&&o.passNumber===rep.number&&!o.measureId&&presentation.visible(o));
  for(const o of unmapped)if(!bars.some(m=>o.start>=m.start&&o.end<=m.end))bars.push({id:'unmapped:'+o.id,start:o.start,end:o.end,viewStart:o.start,viewEnd:o.end,number:'',beats:[],meter:null});
  bars.sort((a,b)=>a.start-b.start);
  if(!bars.length)bars=[{id:'unmapped:'+group.id,start:rep.start,end:rep.end,viewStart:rep.start,viewEnd:rep.end,number:'',beats:[],meter:null}];
  return bars.filter(m=>(m.viewEnd??m.end)>presentation.start+BARLINE_SLACK&&(m.viewStart??m.start)<presentation.end-BARLINE_SLACK);
}

function buildGroup(ctx,section,group){
  const {projection,measures,presentation}=ctx,rep=group.passes[0];
  const rawBars=barsOf(ctx,section,group,rep);
  if(!rawBars.length&&!section.lyrics)return null;
  const repeatTail=group.folded?projection.occurrences.filter(o=>o.groupId===group.id&&o.passNumber===rep.number&&presentation.visible(o)).at(-1):null;   // at the closing repeat sign, after the first ending if there is one
  const bars=rawBars.map((m,index)=>{
    const start=m.viewStart??m.start,end=m.viewEnd??m.end;
    const events=projection.occurrences.filter(o=>o.groupId===group.id&&o.passNumber===rep.number&&(o.measureId===m.id||!o.measureId&&!m.beats.length)&&o.start<end&&o.end>start&&presentation.visible(o));
    const first=start<=presentation.start+BARLINE_SLACK;     // nothing is held over into the first bar shown (a chord that began in the hidden silence starts here)
    const chunks=events.map((o,i)=>({
      key:group.id+':'+o.slotId,slotId:o.slotId,occurrence:o,chordId:o.chordId||null,label:o.label??'?',
      continued:!first&&(!!o.continued||o.start<start),start:Math.max(start,o.start),end:events[i+1]?Math.max(start,events[i+1].start):end,
      repeat:repeatTail&&o.id===repeatTail.id&&o.end<=end?group.passes.length:0,
      lanes:{},
    }));
    const previous=rawBars[index-1],previousMeasure=measures[measures.findIndex(v=>v.id===m.id)-1];
    return {
      id:m.id,measure:m,number:m.number-ctx.barOffset,meter:m.meter||null,beatCount:m.beats.length,odd:isOddBar(m,ctx.usual),
      meterChange:!!(m.meter&&previousMeasure&&!(previousMeasure===measures[0]&&previousMeasure.beats.length<ctx.usual)&&JSON.stringify(m.meter)!==JSON.stringify(previousMeasure.meter)),   // a short first bar (a pickup) is not a meter the song changed from
      start,end,mapped:!String(m.id).startsWith('unmapped:'),chunks,previous:previous?.id??null,
    };
  });
  const lanes=groupLanes(ctx,section,group,rep,bars);
  // Put every placed word under the chord chunk it falls within.
  lanes.forEach((lane,laneIndex)=>{
    for(const token of lane.tokens){
      if(token.flow||!finite(token.displaySeconds))continue;
      const bar=bars.find(b=>b.id===token.measureId);if(!bar||!bar.chunks.length)continue;
      let chunk=bar.chunks[0];for(const c of bar.chunks)if(c.start<=token.displaySeconds+EPS)chunk=c;
      token.chunkKey=chunk.key;token.barId=bar.id;
      (chunk.lanes[laneIndex]??=[]).push(token);
    }
  });
  return {
    id:group.id,sectionId:section.id,folded:!!group.folded,passCount:group.passes.length,passes:group.passes,
    start:group.start,end:group.end,bars,lanes,
    endings:endingsOf(ctx,group),repeat:group.folded?group.passes.length:0,
  };
}

// Where a moment in a pass is drawn on the group's displayed bars: the same bar position (index within the pass) and
// the same musical beat, in the displayed pass. Returns {measureId, displaySeconds} (measureId is the displayed bar).
export function mapToDisplay(measures,rep,sourcePass,seconds,sourceMeasureId){
  const at=Math.max(0,sourcePass?.measureIds.indexOf(sourceMeasureId)??0),displayMeasure=rep.measureIds[at]||rep.measureIds[0];
  const target=measures.find(m=>m.id===displayMeasure);
  if(!target)return {measureId:displayMeasure??null,displaySeconds:null};
  let displaySeconds=null;
  const position=musicalPosition(measures,seconds);
  try{displaySeconds=position?.beat!==null&&position?.beat!==undefined?secondsAtMusicalPosition(measures,target.number,position.beat):null;}catch{displaySeconds=null;}
  if(!finite(displaySeconds)){
    const source=measures.find(m=>m.id===sourceMeasureId);
    displaySeconds=source?target.start+(seconds-source.start)/(source.end-source.start)*(target.end-target.start):target.start;
  }
  return {measureId:displayMeasure,displaySeconds};
}
// The inverse: the bar of a source pass that is drawn at a displayed bar.
export function sourceMeasureFor(rep,sourcePass,displayMeasureId){
  const at=rep.measureIds.indexOf(displayMeasureId);
  return at>=0&&sourcePass?.measureIds[at]?sourcePass.measureIds[at]:displayMeasureId;
}

// One lane per lyric line that belongs to this group: the words of the line, with each word's own (actual) time for seeking
// and a display time mapped onto the group's displayed bars. With true timing, a lane can also hold the words of another section's
// line that are sung here (a pickup): such a lane has `pickup:true`.
function groupLanes(ctx,section,group,rep,bars){
  const {content,projection,measures}=ctx,lanes=[],foreign=[];
  const layoutOf=(sec,line)=>{const key=sec.id+'|'+line;if(!ctx.layouts.has(key))ctx.layouts.set(key,layoutLine(content,measures,sec.id,line,{onsets:ctx.onsets}));return ctx.layouts.get(key);};
  const everyGroup=projection.sections.flatMap(s=>s.groups);
  const tokensOf=(sec,line)=>{
    const layout=layoutOf(sec,line);if(!layout)return null;
    const homes=projection.sections.find(s=>s.id===sec.id)?.groups||[];
    const rowAt=seconds=>homes.find(g=>finite(seconds)&&seconds>=g.start&&seconds<g.end);
    // Line by line: the first words of a line that are sung in the last bar of the row above (a pickup) belong to the row where the line goes on,
    // and are drawn at the start of it. (With true timing they stay where they are sung.)
    let lead=0,leadRow=null;
    if(!ctx.trueTiming&&layout.placed){
      const first=rowAt(layout.tokens[0]?.seconds);let k=0;
      while(first&&k<layout.tokens.length&&rowAt(layout.tokens[k].seconds)===first)k++;
      const next=k<layout.tokens.length?rowAt(layout.tokens[k].seconds):null;
      const lastBar=first?measures.find(m=>first.end-1e-6>=m.start&&first.end-1e-6<m.end):null;
      if(first&&next&&next!==first&&lastBar&&layout.tokens.slice(0,k).every(t=>t.seconds>=lastBar.start-1e-6)){lead=k;leadRow=next;}
    }
    return {layout,tokens:layout.tokens.map((t,index)=>{
      const seconds=layout.placed?t.seconds:null;
      const timed=index<lead?leadRow:rowAt(seconds);
      const owner=timed||(ctx.trueTiming&&finite(seconds)?everyGroup.find(g=>seconds>=g.start&&seconds<g.end):null)||homes[0];
      const sourcePass=owner?.passes.find(p=>finite(seconds)&&seconds>=p.start&&seconds<p.end)||owner?.passes[0];
      const mid=layout.placed?t.measureId:null;
      const shown=layout.placed&&finite(seconds)?mapToDisplay(measures,rep,sourcePass,seconds,mid):null;
      const displayMeasure=shown?shown.measureId:(rep.measureIds[0]??null);let displaySeconds=shown?shown.displaySeconds:null;
      // line by line: words sung before their row starts (a pickup) are drawn at the start of the row
      if(!ctx.trueTiming&&finite(seconds)&&owner&&seconds<owner.start-1e-6&&finite(displaySeconds))displaySeconds=rep.start;
      return {
        text:t.text,offset:t.offset,sectionId:sec.id,line,groupId:owner?.id,passNumber:sourcePass?.number??1,
        measureId:layout.placed?displayMeasure:null,seconds,displaySeconds,flow:!layout.placed,
        pinned:!!t.pinned,kind:t.kind,address:t.pinned&&t.measureId?{measure_id:t.measureId,beat:t.beat}:null,
      };
    }).filter(t=>t.groupId===group.id),all:layout.tokens};
  };
  const raw=section.lyrics?String(section.lyrics).split('\n'):[];
  const ownGroups=projection.sections.find(s=>s.id===section.id)?.groups||[];
  raw.forEach((text,line)=>{
    const made=tokensOf(section,line);if(!made)return;
    const {layout,tokens}=made,first=ownGroups[0];
    if(tokens.length||!text.trim()&&group.id===first?.id){
      const placed=tokens.filter(t=>!t.flow);
      lanes.push({line,text,flow:!!tokens.length&&tokens.every(t=>t.flow),passNumber:tokens[0]?.passNumber??1,tokens,span:placed.length?{start:layout.start,end:layout.end}:null});
    }
  });
  // in pass order, whatever order the lines were typed in (a line typed for pass 2 first still shows under pass 1); a line with no place
  // in time yet keeps its spot
  const slots=lanes.map((lane,i)=>lane.flow?null:i).filter(i=>i!==null),timed=slots.map(i=>lanes[i]).sort((a,b)=>a.passNumber-b.passNumber||a.line-b.line);
  slots.forEach((at,k)=>{lanes[at]=timed[k];});
  // true timing: the words of other sections' lines that are sung in this row
  if(ctx.trueTiming)for(const other of projection.sections){
    if(other.id===section.id)continue;
    const sec=ctx.content.sections.find(s=>s.id===other.id);if(!sec?.lyrics)continue;
    String(sec.lyrics).split('\n').forEach((text,line)=>{
      const made=tokensOf(sec,line),tokens=made?.tokens.filter(t=>!t.flow)||[];
      // the pickup is "now" only until the next word of its line (which is drawn in its own row) starts
      const after=made?.all.find(t=>t.offset>tokens.at(-1)?.offset&&finite(t.seconds));
      if(tokens.length)foreign.push({line,text:'',flow:false,pickup:true,sectionId:sec.id,passNumber:tokens[0].passNumber,tokens,span:{start:made.layout.start,end:after?after.seconds:made.layout.end}});
    });
  }
  return [...lanes,...foreign];
}

// Changed endings: the other passes' final chords, shown once beside the folded line.
function endingsOf(ctx,group){
  const {projection,measures,presentation}=ctx,result=[];
  if(!group.endingVariants?.length)return result;
  for(const variant of group.endingVariants){
    const other=group.passes.find(p=>p.number===variant.passNumbers[0]),measure=other&&measures.find(m=>m.id===other.measureIds.at(-1));
    if(!measure)continue;
    const chords=projection.occurrences.filter(o=>o.groupId===group.id&&o.passNumber===other.number&&o.ending&&presentation.visible(o));
    result.push({variant:variant.id,passNumbers:variant.passNumbers,measureNumber:measure.number-ctx.barOffset,chords});
  }
  return result;
}

// Which chunk and pass is playing right now, for highlighting. Playback decides the pass; the page never moves under the reader.
export function playbackTarget(model,seconds){
  if(!finite(seconds))return null;
  const o=model.projection.occurrences.find(o=>seconds>=o.start&&seconds<o.end);if(!o)return null;
  const group=model.projection.groups.find(g=>g.id===o.groupId);
  return {sectionId:o.sectionId,groupId:o.groupId,slotId:o.kind==='unknown'?null:o.slotId,passNumber:o.passNumber,passCount:group?.passes.length||1,chunkKey:o.groupId+':'+o.slotId,occurrenceId:o.id};
}

