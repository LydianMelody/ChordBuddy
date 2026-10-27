// The in-time view: the same chart, drawn true to time. Each bar gets its own width (wide enough that nothing overlaps), chords sit
// at their onsets, and every lyric line is a lane of word chips. A click plays from there; with Shift a word or a chord can be dragged
// to another beat (a dragged word becomes a pin, and the unpinned words between its neighbours slide with it; Shift+click a pin to
// release the word). With Ctrl the barlines can be moved, removed (click) or added (a beat's +).
import {addressAtSeconds,secondsAtAddress,musicalPosition} from './musical-grid.js';
import {mapToDisplay,sourceMeasureFor} from './chart-model.js';
import {placeWord} from './chart-layout.js';
import {isFixed,dragLimits,allowedTime,nearestAllowed,previewTimes,barWidthsAtZoom,barTargets,nearestTarget,beatToX,beatPx,SNAPS,autoSnap} from './timing-geometry.js';
import {planPageEdit} from './chart-edits.js';
import {icon} from './icons.js';
import {spellChord} from './spelling.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const finite=Number.isFinite;
const DRAG_PIXELS=4,GAP=8;
const PASS_COLORS=4;   // passes of a repeated row each get one of four colors (chart-page.css), then start over
const ROW_HEIGHT=28;   // the height of one line of words
let canvas;
function textWidth(text,font,padding){
  if(canvas===undefined)canvas=typeof document!=='undefined'&&document.createElement?.('canvas')?.getContext?.('2d')||null;
  if(canvas){canvas.font=font;return canvas.measureText(text).width+padding;}
  return Array.from(text).length*(font.includes('25px')?15:9.2)+padding;
}

// env: {getData, getModel, getSnap, getZoom, refs, commit(candidate,label), fail(error), say(text), blocked(), rerender(), editBars(change),
//       seek(seconds,group,pass), seekChunk(group,chunk), moveChord(group,chunk,address), pickBar(group,bar), regroup(group),
//       splitZone(barNode,group,bar), zone(node,name,keys), dragEnded()}  (all but the first eight are optional)
export function createTiming(env){
  let drag=null;

  function barSpec(g){
    return g.bars.map(bar=>({id:bar.id,beats:bar.measure?.beats?.length||0,bar}));
  }
  // A moment on a barline (or within a few milliseconds of it) belongs to the bar that starts there. Drawn at the end of the bar before, a word would hang over the next
  // bar, which sits on top of it and takes its clicks.
  const beatOfSeconds=(measures,seconds,rowIds)=>{
    const a=addressAtSeconds(measures,seconds);if(!a)return null;
    const at=measures.findIndex(m=>m.id===a.measure_id),next=measures[at+1];
    if(at>=0&&next&&(!rowIds||rowIds.has(next.id))&&a.beat>=measures[at].beats.length-.02)return {measureId:next.id,beat:0};
    return {measureId:a.measure_id,beat:a.beat};
  };

  // Display address (bar of the displayed pass + beat) of a moment in the lane's own pass.
  function displayAddress(g,lane,seconds){
    const {measures}=env.getModel(),rep=g.passes[0],source=g.passes.find(p=>p.number===lane.passNumber)||rep;
    const at=addressAtSeconds(measures,Math.min(seconds,(measures.at(-1)?.end??seconds)-1e-9));if(!at)return null;
    const shown=mapToDisplay(measures,rep,source,seconds,at.measure_id);if(!finite(shown.displaySeconds))return null;
    const disp=addressAtSeconds(measures,shown.displaySeconds);return disp?{measureId:disp.measure_id,beat:disp.beat,seconds:shown.displaySeconds}:null;
  }
  const sourcePassOf=(g,lane)=>g.passes.find(p=>p.number===lane.passNumber)||g.passes[0];

  // ---------------- rendering ----------------
  // Overlay melody: the sung notes, faint, behind the chords and words of a bar, high notes higher, so a word can be dropped on its note.
  function melodyOverlay(node,measure,width,n){
    const notes=env.getData()?.melody;if(!notes?.length||!measure||!n)return;
    const inside=notes.filter(note=>note.end>measure.start&&note.start<measure.end);if(!inside.length)return;
    let low=Infinity,high=-Infinity;for(const note of notes){low=Math.min(low,note.pitch);high=Math.max(high,note.pitch);}
    const layer=el('div','tmelody');layer.setAttribute('aria-hidden','true');
    const beatAt=t=>{const a=addressAtSeconds([measure],Math.min(Math.max(t,measure.start),measure.end-1e-6));return a?a.beat:null;};
    for(const note of inside){
      const a=beatAt(note.start),b=note.end>=measure.end?n:beatAt(note.end);if(a===null||b===null)continue;
      const bar=el('i');bar.style.left=beatToX(a,width,n)+'px';bar.style.width=Math.max(3,beatToX(b,width,n)-beatToX(a,width,n)-1)+'px';
      bar.style.top=(high>low?(high-note.pitch)/(high-low)*100:50)+'%';layer.append(bar);
    }
    node.firstChild?node.insertBefore(layer,node.firstChild):node.append(layer);   // first, so it paints under the chords and words that follow
  }
  function renderGroup(section,g){
    const {measures}=env.getModel(),perBeat=beatPx(env.getZoom()),refs=env.refs,perLine=Math.max(1,env.getData()?.content?.layout?.bars_per_line||4);
    const row=el('div','row trow'+(g.lanes.length?' has-lyrics':''));let bars=el('div','bars');const lines=[bars];row.dataset.group=g.id;
    const rowIds=new Set(g.bars.map(b=>b.id));
    refs.groups.push({node:row,model:g});
    const placedLanes=g.lanes.filter(l=>!l.flow);
    // widths: chord labels and each lyric line are separate lanes of items
    const chordItems=[],wordLanes=placedLanes.map(()=>[]);
    for(const bar of g.bars)for(const chunk of bar.chunks){
      const a=beatOfSeconds(measures,chunk.start,rowIds);if(a&&a.measureId===bar.id)chordItems.push({barId:bar.id,beat:a.beat,width:textWidth(spellChord(chunk.label),'800 25px "Bricolage Grotesque"',22)});
    }
    placedLanes.forEach((lane,i)=>{
      for(const t of lane.tokens){
        if(!finite(t.displaySeconds))continue;const a=beatOfSeconds(measures,t.displaySeconds,rowIds);
        if(a)wordLanes[i].push({barId:a.measureId,beat:a.beat,width:textWidth(t.text,'15px "Courier Prime"',30)});
      }
    });
    const specs=barSpec(g),widths=barWidthsAtZoom(specs.map(s=>({id:s.id,beats:s.beats||4})),[chordItems,...wordLanes],env.getZoom(),{gap:GAP});
    const laneEls=new Map();   // lane index -> Map(barId -> lane element)
    const barEls=[];
    g.bars.forEach((bar,index)=>{
      const n=bar.measure?.beats?.length||0,width=widths.get(bar.id)||perBeat*4,node=el('div','bar tbar'+(index===g.bars.length-1?' last':''));
      node.dataset.bar=bar.id;node.style.width=width+'px';if(env.picked?.(bar.id))node.classList.add('rt-sel');   // picked to fold a repeat
      const bp=n?width/n:width/4;node.style.setProperty?.('--bp',bp+'px');node.style.setProperty?.('--sp',bp*stepBeats(gridSnap())+'px');
      const offset=env.getModel().barOffset||0,numbers=g.passes.map(p=>measures.find(m=>m.id===p.measureIds[g.bars.indexOf(bar)])?.number).filter(v=>v!==undefined).map(v=>v-offset);
      // the bar number plays from the bar; Shift+click picks it as one end of a part that repeats
      const no=el('span','tno',numbers.length>1?numbers.join(' · '):String(bar.number));
      env.zone?.(no,'fold','shift');no.onclick=e=>{if(e?.shiftKey)env.pickBar?.(g,bar);else if(!e?.ctrlKey)env.seek?.(bar.start);};
      node.append(no);
      env.splitZone?.(node,g,bar);
      if(env.editBars&&bar.measure&&bar.mapped&&n)addBarControls(node,bar,width,n,measures);
      const chords=el('div','tchords');
      for(const chunk of bar.chunks){
        const a=beatOfSeconds(measures,chunk.start,rowIds),cell=el('span','chunk tchord');cell.dataset.chunk=chunk.key;
        cell.style.left=(n&&a?beatToX(a.beat,width,n):0)+'px';
        const chord=el('span','chord',chunk.continued?'('+spellChord(chunk.label)+')':spellChord(chunk.label));cell.append(chord);
        if(chunk.repeat>1){const count=el('span','repeat','(×'+chunk.repeat+')');env.zone?.(count,'regroup','shift');count.onclick=e=>{if(e?.shiftKey){e.stopPropagation?.();env.regroup?.(g);}};
          count.onpointerdown=e=>e?.stopPropagation?.();         // the count sits inside the chord: pressing it regroups, never starts a chord drag
          cell.append(count);}
        if(!chunk.continued&&chunk.chordId)wireChord(cell,g,chunk);
        else cell.onclick=e=>{if(!e?.shiftKey&&!e?.ctrlKey)env.seekChunk?.(g,chunk);};
        chords.append(cell);refs.chunks.push({node:cell,group:g,chunk});
      }
      node.append(chords);
      melodyOverlay(node,bar.measure,width,n);
      placedLanes.forEach((lane,i)=>{
        const laneEl=el('div','tlane');laneEl.dataset.lane=String(i);laneEl.dataset.pass=String(lane.passNumber);
        // A repeated row holds one lane per pass. Each pass has its own color and every bar of its lane carries its name, so the words can be told
        // apart wherever the row is scrolled to.
        if(g.passCount>1){laneEl.dataset.label='Pass '+lane.passNumber;laneEl.dataset.slot=String((lane.passNumber-1)%PASS_COLORS+1);}
        if(!laneEls.has(i))laneEls.set(i,new Map());laneEls.get(i).set(bar.id,laneEl);node.append(laneEl);
      });
      bars.append(node);barEls.push({node,bar,width,n,id:bar.id,chords});
      // a long row (a repeat folded over eight bars, say) wraps like the chart: bars-per-line to a line, so no row is wider than the rest
      // (each line is its own box: a wrapping row would still count as one long line when the page measures its width)
      if((index+1)%perLine===0&&index<g.bars.length-1){bars=el('div','bars');lines.push(bars);}
    });
    // word chips
    const chips=[];
    placedLanes.forEach((lane,laneIndex)=>{
      lane.tokens.forEach((token,tokenIndex)=>{
        if(!finite(token.displaySeconds))return;
        const a=beatOfSeconds(measures,token.displaySeconds,rowIds),entry=barEls.find(b=>b.id===a?.measureId),laneEl=laneEls.get(laneIndex)?.get(a?.measureId);
        if(!a||!entry||!laneEl||!entry.n)return;
        const chip=makeChip(g,lane,laneIndex,token,tokenIndex);chip.style.left=beatToX(a.beat,entry.width,entry.n)+'px';
        laneEl.append(chip);chips.push({node:chip,token,tokenIndex,laneIndex,lane});refs.words.push({node:chip,token,group:g,lane});
      });
    });
    // The words of one pass always share one line: a run of quick syllables widens its bar instead of dropping words onto a second row, so a
    // lower line can only ever mean another pass.
    for(const item of chips){item.node.style.top='4px';item.node.row=0;}
    for(const lanes of laneEls.values())for(const laneEl of lanes.values())laneEl.style.height=(ROW_HEIGHT+6)+'px';
    const ctx={g,barEls,laneEls,placedLanes,chips,row};
    row._timing=ctx;
    row.append(...lines);
    // lines that were never placed: plain text with a way to put them on this row
    for(const lane of g.lanes.filter(l=>l.flow)){
      const flow=el('div','flow-line'),text=el('span','flow-text',lane.tokens.map(t=>t.text).join(' ')||lane.text);flow.append(text);
      if(lane.tokens.length){const place=el('button','add-lyrics','Place on this row');place.type='button';place.onclick=()=>placeFlow(g,lane);flow.append(place);}
      row.append(flow);
    }
    return row;
  }
  // ---------------- barlines: split a bar, join two bars, drag a barline to another beat ----------------
  // Corrections are saved with the song's timing (see editBars in app.js); the chart, lyrics and repeats then follow the new grid.
  function addBarControls(node,bar,width,n,measures){
    const measure=bar.measure,at=measures.findIndex(m=>m.id===measure.id);
    for(let j=1;j<n;j++){
      const split=el('button','beat-split','+');split.type='button';split.style.left=(beatToX(j,width,n)-8)+'px';
      split.dataset.tipTitle='Split the bar';split.dataset.tip='Start a new bar on this beat.';split.setAttribute('aria-label','Start a new bar on beat '+(j+1));
      split.onclick=e=>{e?.stopPropagation?.();if(!env.blocked())env.editBars({addBars:[measure.beats[j]]});};
      node.append(split);
    }
    if(at<=0)return;                                         // the first barline of the song stays where the recording starts
    const handle=el('button','bar-handle');handle.type='button';
    handle.dataset.tipTitle='Barline';handle.dataset.tip='Drag to move this barline to another beat. Click it to join this bar with the one before.';
    handle.setAttribute('aria-label','Barline before bar '+bar.number);
    handle.onclick=e=>{e?.stopPropagation?.();if(handle._dragged){handle._dragged=false;return;}if(!env.blocked())env.editBars({removeBars:[measure.start]});};
    let drag=null;
    const candidates=()=>{
      // every beat of this bar (and of the bar before it when it sits on the same line), as {time,x} on screen
      const list=[],here=node.getBoundingClientRect(),before=node.previousElementSibling?.classList?.contains('tbar')?node.previousElementSibling:null;
      for(let j=0;j<n;j++)list.push({time:measure.beats[j],x:here.left+beatToX(j,here.width,n)});
      const prev=measures[at-1];
      if(before&&prev){const r=before.getBoundingClientRect(),pn=prev.beats.length;for(let j=1;j<pn;j++)list.push({time:prev.beats[j],x:r.left+beatToX(j,r.width,pn)});}
      return list;
    };
    handle.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,moved:false,list:candidates(),target:null,mark:null};handle.setPointerCapture?.(e.pointerId);};
    handle.onpointermove=e=>{
      if(!drag)return;
      if(!drag.moved&&Math.abs(e.clientX-drag.x)<5)return;
      drag.moved=true;
      let best=null;for(const c of drag.list)if(!best||Math.abs(c.x-e.clientX)<Math.abs(best.x-e.clientX))best=c;
      drag.target=best;
      if(!drag.mark){drag.mark=el('div','bar-drop');document.body.append(drag.mark);}
      const box=node.getBoundingClientRect();drag.mark.style.left=best.x+'px';drag.mark.style.top=box.top+'px';drag.mark.style.height=box.height+'px';
    };
    const finish=async()=>{
      const d=drag;drag=null;d?.mark?.remove();
      if(d?.moved)handle._dragged=true;                          // the click that ends a drag does not also remove the barline
      if(!d||!d.moved||!d.target||Math.abs(d.target.time-measure.start)<1e-6||env.blocked())return;
      env.editBars({removeBars:[measure.start],addBars:[d.target.time]});
    };
    handle.onpointerup=finish;
    handle.onpointercancel=()=>{drag?.mark?.remove();drag=null;};
    node.append(handle);
  }
  // the grid drawn in each bar follows the zoom, whether or not the magnet is on
  const gridSnap=()=>env.getSnap()==='free'?autoSnap(env.getZoom()):env.getSnap();
  const stepBeats=snap=>({quarter:1,eighth:.5,sixteenth:.25,'thirty-second':.125}[snap]||.5);

  function makeChip(g,lane,laneIndex,token,tokenIndex){
    const chip=el('span','wchip'+(token.pinned?' pinned':'')+(token.kind==='chord'?' anchor':'')+(token.kind==='suggest'?' guess':''));
    chip.dataset.line=String(token.line);chip.dataset.offset=String(token.offset);
    env.zone?.(chip,'word','shift');
    const pin=el('span','pinb');pin.innerHTML=icon('pin');pin.title='Shift+click to release the pin';
    pin.onpointerdown=e=>{if(e?.shiftKey)e.stopPropagation?.();};
    pin.onclick=e=>{if(!e?.shiftKey)return;e.stopPropagation?.();release(g,lane,token);};
    chip.append(pin,document.createTextNode?document.createTextNode(token.text):token.text);
    chip.ondblclick=e=>{if(e?.shiftKey&&token.pinned)release(g,lane,token);};
    // a click plays from the word; Shift+drag moves it
    chip.onclick=e=>{if(e?.shiftKey||e?.ctrlKey||drag?.moved)return;if(finite(token.seconds))env.seek?.(token.seconds,g,token.passNumber);};
    chip.onpointerdown=e=>{if(e?.shiftKey)startDrag(e,chip,g,lane,laneIndex,token,tokenIndex);};
    chip.onpointermove=moveDrag;chip.onpointerup=endDrag;chip.onpointercancel=cancelDrag;
    chip.onkeydown=e=>{if(e.key==='Escape')cancelDrag(e);};
    return chip;
  }

  // ---------------- dragging ----------------
  function lineBounds(g,lane){
    const pass=sourcePassOf(g,lane);
    return {start:Math.max(lane.span?.start??pass.start,pass.start),end:Math.min(lane.span?.end??pass.end,pass.end)};
  }
  function startDrag(e,chip,g,lane,laneIndex,token,tokenIndex){
    if(e.button!==0||env.blocked())return;
    const ctx=chip.parent?.parent?.parent?._timing||findCtx(g);if(!ctx)return;
    e.preventDefault?.();
    const times=lane.tokens.map(t=>t.seconds),fixed=lane.tokens.map(t=>isFixed(t));
    const bounds=lineBounds(g,lane);
    drag={chip,g,lane,laneIndex,token,tokenIndex,ctx,pointer:e.pointerId,x0:e.clientX,y0:e.clientY,moved:false,times,fixed,bounds,
      limits:dragLimits(times,fixed,tokenIndex,bounds.start,bounds.end),drop:null,targetsByBar:new Map()};
    chip.setPointerCapture?.(e.pointerId);
  }
  const findCtx=g=>env.refs.groups.find(r=>r.model===g)?.node._timing;

  function hitBar(ctx,e){
    let best=null;
    for(const b of ctx.barEls){
      const r=b.node.getBoundingClientRect();
      const dx=e.clientX<r.left?r.left-e.clientX:e.clientX>r.right?e.clientX-r.right:0,dy=e.clientY<r.top-60?r.top-60-e.clientY:e.clientY>r.bottom+60?e.clientY-r.bottom-60:0;
      if(dy>0)continue;
      if(!best||dx<best.dx)best={b,rect:r,dx};
    }
    return best;
  }
  function targetsFor(b){
    if(drag.targetsByBar.has(b.id))return drag.targetsByBar.get(b.id);
    const g=drag.g,onsets=b.bar.chunks.map(c=>c.start).filter(finite);
    const pins=drag.lane.tokens.filter(t=>t.pinned&&t.measureId===b.id&&finite(t.displaySeconds)).map(t=>beatOfSeconds(env.getModel().measures,t.displaySeconds)?.beat).filter(finite);
    const list=barTargets(b.bar.measure,{snap:gridSnap(),onsets,pins});drag.targetsByBar.set(b.id,list);return list;
  }
  // A displayed grid point -> the same point in the lane's own pass: its address and recording time.
  function actualFor(b,target){
    const {measures}=env.getModel(),g=drag.g,rep=g.passes[0],source=sourcePassOf(g,drag.lane);
    const measureId=sourceMeasureFor(rep,source,b.id);
    let seconds;try{seconds=secondsAtAddress(measures,{measure_id:measureId,beat:target.beat});}catch{return null;}
    return {address:{measure_id:measureId,beat:target.beat},seconds,displayBar:b,displayBeat:target.beat};
  }
  // Every grid point of the row that the dragged word is allowed to land on.
  function allCandidates(){
    if(drag.candidates)return drag.candidates;
    const list=[];
    for(const b of drag.ctx.barEls)for(const target of targetsFor(b)){const a=actualFor(b,target);if(a)list.push(a);}
    return drag.candidates=list;
  }
  function moveDrag(e){
    if(!drag||e.pointerId!==drag.pointer)return;
    if(!drag.moved){
      if(Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0)<DRAG_PIXELS)return;
      drag.moved=true;drag.chip.classList.add('lifted');drag.ghost=el('span','wchip ghost',drag.token.text);(drag.ctx.row||document.body).append(drag.ghost);
    }
    const zoom=drag.ctx.row?.offsetWidth&&drag.ctx.row.getBoundingClientRect?drag.ctx.row.getBoundingClientRect().width/drag.ctx.row.offsetWidth||1:1;     // the page may be zoomed on screen
    drag.ghost.style.left=((e.clientX+8)/zoom)+'px';drag.ghost.style.top=((e.clientY+8)/zoom)+'px';
    const hit=hitBar(drag.ctx,e);if(!hit)return;
    const {b,rect}=hit,unit=b.node.offsetWidth?rect.width/b.node.offsetWidth:1,x=(e.clientX-rect.left)/unit;
    // magnet off: the exact beat under the pointer; on: the nearest grid point, chord or pin
    const target=env.getSnap()==='free'&&b.n?{beat:Math.max(0,Math.min(b.n,x/b.width*b.n))}:nearestTarget(targetsFor(b),x,b.width,b.n);if(!target)return;
    let actual=actualFor(b,target);if(!actual)return;
    // a word may never pass a pinned neighbour: if the pointer is past one, use the nearest grid point that is still between them
    if(!allowedTime(actual.seconds,drag.limits)){
      actual=nearestAllowed(allCandidates(),actual.seconds,drag.limits);
      if(!actual){drag.drop=null;env.say?.('There is no room between this word\'s pinned neighbours. Release one of them first.');return;}
    }
    drag.drop=actual;
    preview(actual);
  }
  function preview(actual){
    const g=drag.g,{measures}=env.getModel(),times=previewTimes(drag.times,drag.fixed,drag.tokenIndex,actual.seconds,drag.bounds.start,drag.bounds.end);
    drag.chips=drag.ctx.chips.filter(c=>c.laneIndex===drag.laneIndex);
    for(const c of drag.chips){
      if(c.tokenIndex===drag.tokenIndex)continue;
      const a=displayAddress(g,drag.lane,times[c.tokenIndex]);if(!a)continue;
      const entry=drag.ctx.barEls.find(b=>b.id===a.measureId),laneEl=drag.ctx.laneEls.get(drag.laneIndex)?.get(a.measureId);if(!entry||!laneEl||!entry.n)continue;
      if((c.node.parentNode||c.node.parent)!==laneEl&&laneEl.append)laneEl.append(c.node);
      c.node.style.left=beatToX(a.beat,entry.width,entry.n)+'px';
    }
    // the drop marker shows exactly where the word will land
    drag.mark?.remove?.();
    const b=drag.drop.displayBar,mark=el('i','drop-mark');
    const shown=displayAddress(g,drag.lane,actual.seconds);
    mark.style.left=beatToX(shown?.beat??drag.drop.displayBeat,b.width,b.n)+'px';
    const pos=shown?musicalPosition(measures,shown.seconds):null;
    mark.dataset.t=pos&&finite(pos.beat)?'Bar '+(pos.bar-(env.getModel().barOffset||0))+' · beat '+Number(pos.beat.toFixed(2)):'Bar '+b.bar.number;
    drag.ctx.laneEls.get(drag.laneIndex)?.get(shown?.measureId||b.id)?.append(mark);drag.mark=mark;
  }
  function finishVisuals(){drag?.mark?.remove?.();drag?.ghost?.remove?.();drag?.chip?.classList.remove('lifted');}
  async function endDrag(e){
    if(!drag||e.pointerId!==drag.pointer)return;
    const d=drag;drag=null;d.chip.releasePointerCapture?.(e.pointerId);
    finishVisuals();
    if(!d.moved||!d.drop){env.rerender?.();env.dragEnded?.();return;}
    const {measures}=env.getModel(),data=env.getData();
    try{
      const next=placeWord(data.content,d.token.sectionId,d.token.line,d.token.offset,d.drop.address.measure_id,d.drop.address.beat,measures);
      await env.commit(next,'Move word');
    }catch(error){env.fail(error);env.rerender?.();}
    env.dragEnded?.();
  }
  function cancelDrag(e){
    if(!drag)return;const d=drag;drag=null;d.chip.releasePointerCapture?.(d.pointer);finishVisuals();env.rerender?.();env.dragEnded?.();
  }

  // ---------------- Shift+drag a chord to another beat ----------------
  // The chord's start moves (the chord before it holds on until then). It stays after the start of the chord before it and before its
  // own end, inside its row, and lands on the grid (or anywhere, with the magnet off).
  function wireChord(cell,g,chunk){
    env.zone?.(cell,'chord','shift');
    cell.onclick=e=>{if(e?.shiftKey||e?.ctrlKey||cell._dragged){cell._dragged=false;return;}env.seekChunk?.(g,chunk);};
    cell.onpointerdown=e=>{
      if(e.button!==0||!e.shiftKey||env.blocked())return;
      const ctx=findCtx(g);if(!ctx)return;e.preventDefault?.();
      const {projection}=env.getModel(),o=chunk.occurrence,mine=projection.occurrences.filter(x=>x.groupId===g.id&&x.passNumber===o.passNumber).sort((a,b)=>a.start-b.start);
      const before=mine[mine.indexOf(o)-1];
      drag={kind:'chord',cell,g,chunk,ctx,pointer:e.pointerId,x0:e.clientX,y0:e.clientY,moved:false,drop:null,targetsByBar:new Map(),
        lo:before?before.start+1e-3:g.start-1e-6,hi:o.end-1e-3,lane:{tokens:[]}};
      cell.setPointerCapture?.(e.pointerId);
    };
    cell.onpointermove=e=>{
      if(drag?.kind!=='chord'||drag.cell!==cell||e.pointerId!==drag.pointer)return;
      // the chord stays where it is (moving the element would lose the pointer) and a copy follows the pointer, like a dragged word
      if(!drag.moved){
        if(Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0)<DRAG_PIXELS)return;
        drag.moved=true;cell.classList.add('lifted');drag.ghost=el('span','tchord-ghost',cell.textContent);(drag.ctx.row||document.body).append(drag.ghost);
      }
      const zoom=drag.ctx.row?.offsetWidth&&drag.ctx.row.getBoundingClientRect?drag.ctx.row.getBoundingClientRect().width/drag.ctx.row.offsetWidth||1:1;
      drag.ghost.style.left=((e.clientX+8)/zoom)+'px';drag.ghost.style.top=((e.clientY+8)/zoom)+'px';
      const hit=hitBar(drag.ctx,e);if(!hit)return;
      const {b,rect}=hit,unit=b.node.offsetWidth?rect.width/b.node.offsetWidth:1,x=(e.clientX-rect.left)/unit;
      const target=env.getSnap()==='free'&&b.n?{beat:Math.max(0,Math.min(b.n,x/b.width*b.n))}:nearestTarget(targetsFor(b),x,b.width,b.n);if(!target)return;
      let seconds;try{seconds=secondsAtAddress(env.getModel().measures,{measure_id:b.id,beat:target.beat});}catch{return;}
      if(!(seconds>drag.lo&&seconds<drag.hi)){drag.drop=null;drag.mark?.remove?.();env.say?.('A chord moves between the start of the chord before it and its own end.');return;}
      drag.drop={address:{measure_id:b.id,beat:target.beat},bar:b};
      // the marker says where it lands
      drag.mark?.remove?.();const mark=el('i','drop-mark');mark.style.left=beatToX(target.beat,b.width,b.n)+'px';
      const pos=musicalPosition(env.getModel().measures,seconds);mark.dataset.t=pos&&finite(pos.beat)?'Bar '+(pos.bar-(env.getModel().barOffset||0))+' · beat '+Number(pos.beat.toFixed(2)):'Bar '+b.bar.number;
      b.chords?.append?.(mark);drag.mark=mark;
    };
    const end=async e=>{
      if(drag?.kind!=='chord'||drag.cell!==cell||e.pointerId!==drag.pointer)return;
      const d=drag;drag=null;cell.releasePointerCapture?.(e.pointerId);d.mark?.remove?.();d.ghost?.remove?.();cell.classList.remove('lifted');
      if(d.moved)cell._dragged=true;
      if(!d.moved||!d.drop){if(d.moved)env.rerender?.();env.dragEnded?.();return;}
      await env.moveChord?.(g,chunk,d.drop.address);
      env.dragEnded?.();
    };
    cell.onpointerup=end;
    // the pointer was taken away (another window, the page redrawn): the drag ends and nothing moves
    cell.onpointercancel=cell.onlostpointercapture=e=>{if(drag?.kind!=='chord'||drag.cell!==cell)return;drag.mark?.remove?.();drag.ghost?.remove?.();drag=null;cell.classList.remove('lifted');env.rerender?.();env.dragEnded?.();};
  }

  // ---------------- pins and unplaced lines ----------------
  async function release(g,lane,token){
    if(env.blocked())return;
    try{
      const next=planPageEdit.releaseWord({content:env.getData().content,sectionId:token.sectionId,line:token.line,offset:token.offset});
      await env.commit(next,'Release word');
      env.say?.('Released. This word now spreads out between its neighbours.');
    }catch(error){env.fail(error);}
  }
  async function placeFlow(g,lane){
    if(env.blocked())return;
    try{
      const pass=g.passes.find(p=>p.number===(lane.passNumber||1))||g.passes[0];
      await env.commit(planPageEdit.placeOnRow({content:env.getData().content,music:env.getData().music,group:g,pass,lane}),'Place lyric line');
    }catch(error){env.fail(error);}
  }

  return {renderGroup,isDragging:()=>!!drag?.moved,cancel:()=>cancelDrag({})};
}
export {SNAPS};
