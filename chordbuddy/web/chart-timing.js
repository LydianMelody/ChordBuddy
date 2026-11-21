// The in-time view: the same chart, drawn true to time. Each bar gets its own width (wide enough that nothing overlaps), chords sit
// at their onsets, and every lyric line is a lane of word chips. A click plays from there. With the Timing tool (or Shift held) a word
// or a chord can be dragged to another beat (a dragged word becomes a pin, and the unpinned words between its neighbours slide with it;
// click a pin to release the word) and a repeat count regrouped. Folding a repeat picks bar numbers (Fold a repeat, or Shift+click).
// With the Edit tool (or Ctrl held) the barlines can be moved, removed (click) or added (a beat's +).
import {addressAtSeconds,secondsAtAddress,musicalPosition} from './musical-grid.js';
import {mapToDisplay,sourceMeasureFor} from './chart-model.js';
import {placeWord,pickupStart} from './chart-layout.js';
import {layoutLine} from './word-layout.js';
import {isFixed,dragLimits,allowedTime,nearestAllowed,previewTimes,layoutRowBars,xOfKnots,beatOfKnots,barTargets,nearestTarget,beatToX,beatPx,SNAPS,autoSnap} from './timing-geometry.js';
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
//       splitZone(barNode,group,bar), zone(node,name,keys), dragEnded(), isTime(event), isEdit(event), folding()}  (all but the first eight are
//       optional). isTime: whether a press works in time (the Timing tool, or Shift); isEdit: whether it edits (the Edit tool, or Ctrl).
export function createTiming(env){
  let drag=null;
  const timeAct=e=>env.isTime?env.isTime(e):!!e?.shiftKey,editAct=e=>env.isEdit?env.isEdit(e):!!e?.ctrlKey;

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
  // A repeated row draws every pass's notes, each in its lane's color (what that lane's words snap to); the pass being played is drawn
  // strongest (chart-page.js marks it). The height is shared by the row: its lowest note at the bottom, its highest at the top.
  function rowPitchRange(g){
    const notes=env.getData()?.melody;if(!notes?.length)return null;
    const {measures}=env.getModel(),spans=g.passes.flatMap(p=>p.measureIds).map(id=>measures.find(m=>m.id===id)).filter(Boolean);
    let low=Infinity,high=-Infinity;
    for(const note of notes)if(spans.some(m=>note.end>m.start&&note.start<m.end)){low=Math.min(low,note.pitch);high=Math.max(high,note.pitch);}
    return low<=high?{low:low-1,high:high+1}:null;
  }
  function melodyOverlay(node,g,barIndex,width,n,range,xOf){
    const notes=env.getData()?.melody;if(!notes?.length||!range||!n)return;
    const {measures}=env.getModel(),layers=[];
    for(const pass of g.passes){
      const measure=measures.find(m=>m.id===pass.measureIds[barIndex]);if(!measure)continue;
      const inside=notes.filter(note=>note.end>measure.start&&note.start<measure.end);if(!inside.length)continue;
      const layer=el('div','tmelody');layer.setAttribute('aria-hidden','true');layer.dataset.pass=String(pass.number);
      if(g.passCount>1)layer.dataset.slot=String((pass.number-1)%PASS_COLORS+1);
      const beatAt=t=>{const a=addressAtSeconds([measure],Math.min(Math.max(t,measure.start),measure.end-1e-6));return a?a.beat:null;};
      for(const note of inside){
        const a=beatAt(note.start),b=note.end>=measure.end?n:beatAt(note.end);if(a===null||b===null)continue;
        const bar=el('i');bar.style.left=xOf(a)+'px';bar.style.width=Math.max(3,xOf(b)-xOf(a)-1)+'px';
        bar.style.top=((range.high-note.pitch)/(range.high-range.low)*100)+'%';layer.append(bar);
      }
      layers.push(layer);
    }
    for(const layer of layers.reverse())node.firstChild?node.insertBefore(layer,node.firstChild):node.append(layer);   // first, so they paint under the chords and words
  }
  function renderGroup(section,g){
    const {measures}=env.getModel(),perBeat=beatPx(env.getZoom()),refs=env.refs,perLine=Math.max(1,env.getData()?.content?.layout?.bars_per_line||4);
    const row=el('div','row trow'+(g.lanes.length?' has-lyrics':''));let bars=el('div','bars');const lines=[bars];row.dataset.group=g.id;
    const rowIds=new Set(g.bars.map(b=>b.id)),pitchRange=rowPitchRange(g);
    refs.groups.push({node:row,model:g});
    const placedLanes=g.lanes.filter(l=>!l.flow);
    // widths: chord labels and each lyric line are separate lanes of items
    const chordItems=[],wordLanes=placedLanes.map(()=>[]);
    for(const bar of g.bars)for(const chunk of bar.chunks){
      const a=beatOfSeconds(measures,chunk.start,rowIds);if(a&&a.measureId===bar.id)chordItems.push({barId:bar.id,beat:a.beat,width:textWidth(chunk.continued?'':spellChord(chunk.label),'800 25px "Bricolage Grotesque"',22)});
    }
    placedLanes.forEach((lane,i)=>{
      for(const t of lane.tokens){
        if(!finite(t.displaySeconds))continue;const a=beatOfSeconds(measures,t.displaySeconds,rowIds);
        if(a)wordLanes[i].push({barId:a.measureId,beat:a.beat,width:textWidth(t.text,'15px "Courier Prime"',30)});
      }
    });
    const specs=barSpec(g),layout=layoutRowBars(specs.map(s=>({id:s.id,beats:s.beats||4})),[chordItems,...wordLanes],perBeat,{gap:GAP});
    const laneEls=new Map();   // lane index -> Map(barId -> lane element)
    const barEls=[];
    g.bars.forEach((bar,index)=>{
      const n=bar.measure?.beats?.length||0,laid=layout.get(bar.id),width=laid?.width||perBeat*4,xOf=beat=>laid?xOfKnots(laid.knots,beat):beatToX(beat,width,n),beatOf=x=>laid?beatOfKnots(laid.knots,x):x/width*n,node=el('div','bar tbar'+(index===g.bars.length-1?' last':''));
      node.dataset.bar=bar.id;node.style.width=width+'px';node._xOf=xOf;if(env.picked?.(bar.id))node.classList.add('rt-sel');   // picked to fold a repeat
      node.append(gridLines(n,xOf));
      // the bar's place in each pass, found by its measure: the row's bars leave out hidden ones (silence before the music) that passes still list
      const passIndex=g.passes[0]?.measureIds.indexOf(bar.id)??-1;
      const offset=env.getModel().barOffset||0,numbers=g.passes.map(p=>measures.find(m=>m.id===p.measureIds[passIndex])?.number).filter(v=>v!==undefined).map(v=>v-offset);
      // the bar number plays from the bar; while folding a repeat (or with Shift) it is picked as one end of the part that repeats
      const no=el('span','tno',numbers.length>1?numbers.join(' · '):String(bar.number));
      env.zone?.(no,'fold','fold');no.onclick=e=>{if(e?.shiftKey||env.folding?.())env.pickBar?.(g,bar);else if(!editAct(e))env.seek?.(bar.start);};
      node.append(no);
      env.splitZone?.(node,g,bar);
      if(env.editBars&&bar.measure&&bar.mapped&&n)addBarControls(node,bar,width,n,measures,xOf);
      const chords=el('div','tchords');
      for(const chunk of bar.chunks){
        const a=beatOfSeconds(measures,chunk.start,rowIds),cell=el('span','chunk tchord');cell.dataset.chunk=chunk.key;
        cell.style.left=(n&&a?xOf(a.beat):0)+'px';
        const chord=el('span','chord'+(chunk.continued?' held':''),chunk.continued?'':spellChord(chunk.label));if(chunk.continued)chord.title='Still holding '+spellChord(chunk.label);cell.append(chord);
        const cues=env.cuesAt?.(chunk.key)||[];       // cues are written with the Cue tool on the chart as written; here they show where they fall
        if(cues.length){const lane=el('span','cue-lane');for(const {cue,passNumber} of cues){const b=el('button',cue.plan?'cue plan':'cue',cue.text);b.type='button';b.title=(cue.plan?`A note in the arrangement “${cue.plan}”`:'Cue')+(g.passCount>1?', pass '+passNumber:'');b.onclick=e=>{e?.stopPropagation?.();env.seek?.(cue.start,g,passNumber);};b.onpointerdown=e=>e?.stopPropagation?.();refs.cues?.push({node:b,cue,chunkKey:chunk.key,passNumber});lane.append(b);}cell.append(lane);}
        if(chunk.repeat>1){const count=el('span','repeat','(×'+chunk.repeat+')');env.zone?.(count,'regroup','time');count.onclick=e=>{if(timeAct(e)){e.stopPropagation?.();env.regroup?.(g);}};
          count.onpointerdown=e=>e?.stopPropagation?.();         // the count sits inside the chord: pressing it regroups, never starts a chord drag
          cell.append(count);}
        if(!chunk.continued&&chunk.chordId)wireChord(cell,g,chunk);
        else cell.onclick=e=>{if(!e?.shiftKey&&!editAct(e))env.seekChunk?.(g,chunk);};
        chords.append(cell);refs.chunks.push({node:cell,group:g,chunk});
      }
      node.append(chords);
      melodyOverlay(node,g,passIndex,width,n,pitchRange,xOf);
      placedLanes.forEach((lane,i)=>{
        const laneEl=el('div','tlane');laneEl.dataset.lane=String(i);laneEl.dataset.pass=String(lane.passNumber);
        // A repeated row holds one lane per pass. Each pass has its own color and every bar of its lane carries its name, so the words can be told
        // apart wherever the row is scrolled to.
        if(g.passCount>1){laneEl.dataset.label='Pass '+lane.passNumber;laneEl.dataset.slot=String((lane.passNumber-1)%PASS_COLORS+1);}
        if(!laneEls.has(i))laneEls.set(i,new Map());laneEls.get(i).set(bar.id,laneEl);node.append(laneEl);
      });
      bars.append(node);barEls.push({node,bar,width,n,id:bar.id,chords,xOf,beatOf});
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
        const chip=makeChip(g,lane,laneIndex,token,tokenIndex);chip.style.left=entry.xOf(a.beat)+'px';
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
  function addBarControls(node,bar,width,n,measures,xOf){
    const measure=bar.measure,at=measures.findIndex(m=>m.id===measure.id);
    for(let j=1;j<n;j++){
      const split=el('button','beat-split','+');split.type='button';split.style.left=(xOf(j)-8)+'px';
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
      for(let j=0;j<n;j++)list.push({time:measure.beats[j],x:here.left+xOf(j)*here.width/width});
      const prev=measures[at-1];
      if(before&&prev){const r=before.getBoundingClientRect(),pn=prev.beats.length,prevX=before._xOf,prevWidth=parseFloat(before.style.width)||r.width;for(let j=1;j<pn;j++)list.push({time:prev.beats[j],x:r.left+(prevX?prevX(j)*r.width/prevWidth:beatToX(j,r.width,pn))});}
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
  // The beat lines of a bar (strong) and the lines of the grid steps between them (faint), drawn where the bar's own spacing puts them.
  function gridLines(n,xOf){
    const wrap=el('div','tgrid');wrap.setAttribute('aria-hidden','true');
    if(!n)return wrap;
    const step=stepBeats(gridSnap());let lastX=-99;
    for(let beat=0;beat<n-1e-9;beat+=step){
      const whole=Math.abs(beat-Math.round(beat))<1e-9,x=xOf(beat);
      if(!whole&&x-lastX<5)continue;             // squeezed too close to be told apart
      const line=el('i',whole?'tg-beat':'tg-step');line.style.left=x+'px';wrap.append(line);lastX=x;
    }
    return wrap;
  }
  // the grid drawn in each bar follows the zoom, whether or not the magnet is on
  const gridSnap=()=>env.getSnap()==='free'?autoSnap(env.getZoom()):env.getSnap();
  const stepBeats=snap=>({quarter:1,eighth:.5,sixteenth:.25,'thirty-second':.125}[snap]||.5);

  function makeChip(g,lane,laneIndex,token,tokenIndex){
    const chip=el('span','wchip'+(token.pinned?' pinned':'')+(token.kind==='chord'?' anchor':'')+(token.kind==='suggest'?' guess':''));
    chip.dataset.line=String(token.line);chip.dataset.offset=String(token.offset);
    env.zone?.(chip,'word','time');
    const pin=el('span','pinb');pin.innerHTML=icon('pin');pin.title='Click to release the pin: the word goes back to spreading out between its neighbors';
    pin.onpointerdown=e=>{if(timeAct(e))e.stopPropagation?.();};
    pin.onclick=e=>{if(!timeAct(e))return;e.stopPropagation?.();release(g,lane,token);};
    chip.append(pin,document.createTextNode?document.createTextNode(token.text):token.text);

    chip.ondblclick=e=>{if(timeAct(e)&&token.pinned)release(g,lane,token);};
    // a click plays from the word; dragging it (Timing tool, or Shift) moves it
    chip.onclick=e=>{if(e?.shiftKey||editAct(e)||drag?.moved)return;if(finite(token.seconds))env.seek?.(token.seconds,g,token.passNumber);};
    chip.onpointerdown=e=>{if(e.button===0)env.positioning?.(g,lane.passNumber);if(timeAct(e))startDrag(e,chip,g,lane,laneIndex,token,tokenIndex);};   // its pass's melody lights up
    chip.onpointermove=moveDrag;chip.onpointerup=endDrag;chip.onpointercancel=cancelDrag;
    chip.onkeydown=e=>{if(e.key==='Escape')cancelDrag(e);};
    return chip;
  }

  // ---------------- dragging ----------------
  // A word is dragged as part of its whole lyric line, not of the row it is drawn in: it can land in any row (a pickup goes to the bar
  // before its section starts), and the words that are not pinned spread out between the pins on either side.
  const allCtxs=()=>(env.refs.groups||[]).map(r=>r.node?._timing).filter(Boolean);
  function startDrag(e,chip,g,lane,laneIndex,token,tokenIndex){
    if(e.button!==0||env.blocked())return;
    const ctx=chip.parent?.parent?.parent?._timing||findCtx(g);if(!ctx)return;
    const {measures}=env.getModel(),content=env.getData().content,full=layoutLine(content,measures,token.sectionId,token.line);
    const index=full?.placed?full.tokens.findIndex(t=>t.offset===token.offset):-1;if(index<0)return;
    e.preventDefault?.();
    const section=content.sections.find(s=>s.id===token.sectionId);
    const times=full.tokens.map(t=>t.seconds),fixed=full.tokens.map(t=>isFixed(t));
    // the first word may go back into the bar before its section (a pickup); the others stay after the line's start
    const bounds={start:index===0&&section?Math.min(full.start,pickupStart(measures,section)):full.start,end:section?Math.max(full.end,section.end):full.end};
    drag={chip,g,lane,laneIndex,token,tokenIndex:index,ctx,pointer:e.pointerId,x0:e.clientX,y0:e.clientY,moved:false,times,fixed,bounds,spreadEnd:full.end,
      indexByOffset:new Map(full.tokens.map((t,i)=>[t.offset,i])),
      limits:dragLimits(times,fixed,index,bounds.start,bounds.end),drop:null,targetsByBar:new Map()};
    chip.setPointerCapture?.(e.pointerId);
  }
  const findCtx=g=>env.refs.groups.find(r=>r.model===g)?.node._timing;

  // The bar under the pointer, in any row (or only in `list`), with its row's context.
  function hitBar(e,list=allCtxs()){
    let best=null;
    for(const ctx of list)for(const b of ctx.barEls){
      const r=b.node.getBoundingClientRect();
      const dx=e.clientX<r.left?r.left-e.clientX:e.clientX>r.right?e.clientX-r.right:0,dy=e.clientY<r.top?r.top-e.clientY:e.clientY>r.bottom?e.clientY-r.bottom:0;
      if(dy>60)continue;
      if(!best||dy<best.dy-1e-6||(Math.abs(dy-best.dy)<1e-6&&dx<best.dx))best={b,rect:r,dx,dy,ctx};
    }
    return best;
  }
  // How much bigger or smaller the page is drawn than laid out (the page zoom), from a bar's width on screen against the width it was
  // given. offsetWidth is not used: under CSS zoom some engines report it zoomed and others not, which put the drop point and the ghost
  // short of the pointer (at 83% zoom, about a fifth of the way back towards the bar's start).
  function screenScale(ctx){
    for(const b of ctx.barEls){const w=b.node.getBoundingClientRect?.().width;if(w>0&&b.width>0)return w/b.width;}
    return 1;
  }
  // The pointer's distance from the start of the bar it is over, in the bar's own (laid out) pixels.
  const pointerX=({b,rect},e)=>rect.width>0?(e.clientX-rect.left)/rect.width*b.width:0;
  // Which pass of a row the dragged word lands in. A folded row shows its bars once for every pass, so the pass is chosen by time: the
  // one closest to where the word may go (its line, or the bar before its section for a pickup), then the one nearest to where it is
  // sung now. In its own row that is the pass it is sung in; in the row before its section it is the last pass, which holds the bar just
  // before the section (matching pass numbers put a Chorus word's pickup in the first pass there, bars too early to be allowed).
  const passIn=gb=>{
    const now=drag.times?.[drag.tokenIndex],lo=drag.bounds?.start,hi=drag.bounds?.end;
    if(!finite(now)||!finite(lo)||!finite(hi)||gb.passes.length<2)return gb.passes.find(p=>p.number===(drag.token?.passNumber??drag.lane?.passNumber))||gb.passes[0];
    const gap=p=>Math.max(0,lo-p.end,p.start-hi),away=p=>Math.max(0,p.start-now,now-p.end);
    return gb.passes.reduce((best,p)=>gap(p)<gap(best)-1e-6||(Math.abs(gap(p)-gap(best))<=1e-6&&away(p)<away(best))?p:best);
  };
  function targetsFor(b,ctx=drag.ctx){
    if(drag.targetsByBar.has(b.id))return drag.targetsByBar.get(b.id);
    const gb=ctx.g,onsets=b.bar.chunks.map(c=>c.start).filter(finite);
    // The start of every melody note of the line's own pass is a drop point too (the faint purple bars): a note in that pass's bar sits at
    // the same beat of the bar shown.
    const notes=env.getData()?.melody;
    if(notes?.length&&b.bar.measure){
      const {measures}=env.getModel(),sourceId=sourceMeasureFor(gb.passes[0],passIn(gb),b.id),sm=measures.find(m=>m.id===sourceId);
      if(sm)for(const note of notes){
        if(!(note.start>=sm.start&&note.start<sm.end))continue;
        const at=addressAtSeconds([sm],note.start);if(!at)continue;
        try{onsets.push(secondsAtAddress([b.bar.measure],{measure_id:b.id,beat:at.beat}));}catch{/* the shown bar has no such beat */}
      }
    }
    const mine=t=>t.sectionId===drag.token?.sectionId&&t.line===drag.token?.line;
    const pins=(drag.token?ctx.placedLanes.flatMap(l=>l.tokens).filter(t=>mine(t)&&t.pinned&&t.measureId===b.id&&finite(t.displaySeconds)):[])
      .map(t=>beatOfSeconds(env.getModel().measures,t.displaySeconds)?.beat).filter(finite);
    const list=barTargets(b.bar.measure,{snap:gridSnap(),onsets,pins});drag.targetsByBar.set(b.id,list);return list;
  }
  // A displayed grid point -> the same point in the line's own pass: its address and recording time.
  // `pass` is the pass to land in (the one whose lane is under the pointer); without it the pass is found by time (passIn).
  function actualFor(b,target,ctx,pass=passIn(ctx.g)){
    const {measures}=env.getModel(),gb=ctx.g,rep=gb.passes[0];
    const measureId=sourceMeasureFor(rep,pass,b.id);
    let seconds;try{seconds=secondsAtAddress(measures,{measure_id:measureId,beat:target.beat});}catch{return null;}
    return {address:{measure_id:measureId,beat:target.beat},seconds,displayBar:b,displayBeat:target.beat,ctx,passNumber:pass?.number??1};
  }
  // The pass whose lane is under the pointer in a repeated row (each pass has its own lane of words), or null.
  function laneUnder(e,{b,ctx}){
    if(ctx.g.passes.length<2)return null;
    for(const lanes of ctx.laneEls.values()){
      const laneEl=lanes.get(b.id),r=laneEl?.getBoundingClientRect?.();
      if(r&&r.height>0&&e.clientY>=r.top&&e.clientY<=r.bottom)return ctx.g.passes.find(p=>p.number===Number(laneEl.dataset.pass))||null;
    }
    return null;
  }
  // Every grid point of every row that the dragged word is allowed to land on.
  function allCandidates(){
    if(drag.candidates)return drag.candidates;
    const list=[];
    for(const ctx of allCtxs())for(const b of ctx.barEls)for(const target of targetsFor(b,ctx)){const a=actualFor(b,target,ctx);if(a)list.push(a);}
    return drag.candidates=list;
  }
  const inBounds=s=>s>=drag.bounds.start-1e-6&&s<=drag.bounds.end+1e-6;
  function moveDrag(e){
    if(!drag||e.pointerId!==drag.pointer)return;
    if(!drag.moved){
      if(Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0)<DRAG_PIXELS)return;
      drag.moved=true;drag.chip.classList.add('lifted');drag.ghost=el('span','wchip ghost',drag.token.text);(drag.ctx.row||document.body).append(drag.ghost);
    }
    const zoom=screenScale(drag.ctx);     // the page may be zoomed on screen
    drag.ghost.style.left=((e.clientX+8)/zoom)+'px';drag.ghost.style.top=((e.clientY+8)/zoom)+'px';
    const hit=hitBar(e);if(!hit)return;
    const {b,ctx}=hit,x=pointerX(hit,e);
    // magnet off: the exact beat under the pointer; on: the nearest grid point, chord or pin
    const target=env.getSnap()==='free'&&b.n?{beat:Math.max(0,Math.min(b.n,b.beatOf(x)))}:nearestTarget(targetsFor(b,ctx),x,b.width,b.n,b.beatOf);if(!target)return;
    // over a pass's lane in a repeated row: that pass, if the word may go there; otherwise the pass found by time
    const lanePass=laneUnder(e,hit);
    let actual=lanePass?actualFor(b,target,ctx,lanePass):null;
    if(!actual||!inBounds(actual.seconds)||!allowedTime(actual.seconds,drag.limits))actual=actualFor(b,target,ctx);
    if(!actual)return;
    // a word may never pass a pinned neighbour: if the pointer is past one, use the nearest grid point that is still between them
    if(!allowedTime(actual.seconds,drag.limits)){
      actual=nearestAllowed(allCandidates(),actual.seconds,drag.limits);
      if(!actual){drag.drop=null;env.say?.('There is no room between this word\'s pinned neighbors. Release one of them first.');return;}
    }
    drag.drop=actual;
    preview(actual);
  }
  function preview(actual){
    const {measures}=env.getModel(),times=previewTimes(drag.times,drag.fixed,drag.tokenIndex,actual.seconds,drag.bounds.start,drag.spreadEnd);
    // the other words of the line slide, in whichever row they are drawn
    for(const ctx of allCtxs())for(const c of ctx.chips){
      if(c.token.sectionId!==drag.token.sectionId||c.token.line!==drag.token.line||c.token.offset===drag.token.offset)continue;
      const at=drag.indexByOffset.get(c.token.offset);if(at===undefined)continue;
      const a=displayAddress(ctx.g,c.lane,times[at]);if(!a)continue;
      const entry=ctx.barEls.find(b=>b.id===a.measureId),laneEl=ctx.laneEls.get(c.laneIndex)?.get(a.measureId);if(!entry||!laneEl||!entry.n)continue;
      if((c.node.parentNode||c.node.parent)!==laneEl&&laneEl.append)laneEl.append(c.node);
      c.node.style.left=entry.xOf(a.beat)+'px';
    }
    // the drop marker shows exactly where the word will land, in whichever row that is
    drag.mark?.remove?.();
    const dropCtx=drag.drop.ctx,b=drag.drop.displayBar,mark=el('i','drop-mark');
    const shown=displayAddress(dropCtx.g,{passNumber:actual.passNumber},actual.seconds);
    mark.style.left=b.xOf(shown?.beat??drag.drop.displayBeat)+'px';
    const pos=shown?musicalPosition(measures,shown.seconds):null;
    mark.dataset.t=pos&&finite(pos.beat)?'Bar '+(pos.bar-(env.getModel().barOffset||0))+' · beat '+Number(pos.beat.toFixed(2)):'Bar '+b.bar.number;
    const barId=shown?.measureId||b.id,lanes=[...dropCtx.laneEls.values()].map(m=>m.get(barId)).filter(Boolean);
    const laneEl=(dropCtx.g.passes.length>1?lanes.find(l=>Number(l.dataset.pass)===actual.passNumber):null)||dropCtx.laneEls.get(drag.laneIndex)?.get(barId)||lanes[0];
    if(laneEl)laneEl.append(mark);else{mark.className+=' in-bar';(dropCtx.barEls.find(x=>x.id===barId)?.node||b.node).append(mark);}   // a row with no lyrics has no lane: the marker stands in the bar
    drag.mark=mark;
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

  // ---------------- drag a chord to another beat (Timing tool, or Shift) ----------------
  // The chord's start moves (the chord before it holds on until then). It stays after the start of the chord before it and before its
  // own end, inside its row, and lands on the grid (or anywhere, with the magnet off).
  function wireChord(cell,g,chunk){
    env.zone?.(cell,'chord','time');
    cell.onclick=e=>{if(e?.shiftKey||editAct(e)||cell._dragged){cell._dragged=false;return;}env.seekChunk?.(g,chunk);};
    cell.onpointerdown=e=>{
      if(e.button!==0||!timeAct(e)||env.blocked())return;
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
      const zoom=screenScale(drag.ctx);
      drag.ghost.style.left=((e.clientX+8)/zoom)+'px';drag.ghost.style.top=((e.clientY+8)/zoom)+'px';
      const hit=hitBar(e,[drag.ctx]);if(!hit)return;
      const {b}=hit,x=pointerX(hit,e);
      const target=env.getSnap()==='free'&&b.n?{beat:Math.max(0,Math.min(b.n,b.beatOf(x)))}:nearestTarget(targetsFor(b,drag.ctx),x,b.width,b.n,b.beatOf);if(!target)return;
      let seconds;try{seconds=secondsAtAddress(env.getModel().measures,{measure_id:b.id,beat:target.beat});}catch{return;}
      if(!(seconds>drag.lo&&seconds<drag.hi)){drag.drop=null;drag.mark?.remove?.();env.say?.('A chord moves between the start of the chord before it and its own end.');return;}
      drag.drop={address:{measure_id:b.id,beat:target.beat},bar:b};
      // the marker says where it lands
      drag.mark?.remove?.();const mark=el('i','drop-mark');mark.style.left=b.xOf(target.beat)+'px';
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
      env.say?.('Released. This word now spreads out between its neighbors.');
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
