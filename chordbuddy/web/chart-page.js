// The chart page. There are no modes: the tool you hold decides what a click means, and which view the chart is drawn in.
//   Navigate (default): click any chord, word, bar number or section name to seek there. The playing chord and word light up.
//   Write, Split, Join, Repeat: the chart as written. Write retypes chords, words and section names; Split and Join split and glue
//         sections; Repeat folds repeating bars.
//   Time, Barlines: the same chart drawn true to time, with draggable words and fixable barlines (see chart-timing.js).
// (Internally `mode` is still nav / edit / timing, derived from the tool, because that is the view being drawn.)
// Playback decides which repeat pass is highlighted; the page itself never rearranges while it plays.
import {buildChartModel,playbackTarget} from './chart-model.js';
import {isNoChordLabel} from './chart-layout.js';
import {currentWordIndex} from './word-layout.js';
import {planChartChordDelete,planChartChordEdit,planSectionEdit} from './practice-edit.js';
import {addressAtSeconds} from './musical-grid.js';
import {addChartChord} from './editor.js';
import {spellChord} from './spelling.js';
import {applyCompactFold,applyCompactRange,compactRangeChoices,compactEditTargets,compactFoldChoices,compactJumpTargets,hasCompactPreferences,resetCompactPreferences} from './compact-chart.js';
import {planPageEdit} from './chart-edits.js';
import {copyTargets,copyGroup,copySectionLyrics} from './chart-copy.js';
import {applyRows} from './row-layout.js';
import {beatsLabel} from './bar-lengths.js';
import {createTiming} from './chart-timing.js';
import {DEFAULT_ZOOM,stepZoom,ZOOM_LEVELS,autoSnap} from './timing-geometry.js';
import {TOOLS,TOOL_GROUPS,TOOL_NAMES,DEFAULT_TOOL,MODE_OF,TOOL_FOR_KEY,toolCursor,toolIcon} from './tool-icons.js';
import {renderRail,watchRail} from './tool-rail.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const finite=Number.isFinite;
const pad2=n=>String(n).padStart(2,'0');
const clock=s=>finite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'';
export const CHORD_SUGGESTIONS=['C','Cm','C7','Cmaj7','D','Dm','D7','Dsus4','E','Em','E7','F','Fm','F#','F#m','G','G7','Gsus4','A','Am','A7','Asus4','B','Bm','Bb','Eb','Ab','Db','C/E','D/F#','G/B','Am7','Dm7','Em7','Bm7','Cadd9','N'];
const nameKey=name=>String(name||'').toLowerCase().replace(/[^a-z]/g,'');
const joinWords=tokens=>tokens.map((t,i)=>t.text+(i<tokens.length-1&&!t.text.endsWith('-')?' ':'')).join('');

export function mountChartPage(root,handlers={}){
  const fixing={a:null,b:null};                      // the bars picked with the Repeat tool
  let fixSel={ids:new Set()},tool=DEFAULT_TOOL;
  let data=null,model=null,key=null,mode='nav',scope='occurrence',snapping=true,zoom=DEFAULT_ZOOM,draft=null,saving=false,last=null;
  const targetPass={},seekPass={};let pendingName=null;
  let refs={chunks:[],groups:[],sections:[],lanes:[],words:[],chords:[],slots:[],editors:[],endings:[]},occById=new Map();
  // The tool rail and the note beside it live outside the chart (the app hands in elements for them); on its own the page makes its own.
  const page=el('div','chart-flow'),notices=el('div','chart-notices'),message=el('p','chart-message'),dock=handlers.dock||el('div','tool-dock'),noteHost=handlers.note||el('div','tool-note'),statusHost=handlers.status||el('div','tool-status');message.setAttribute('role','status');
  root.replaceChildren(...(handlers.dock?[]:[dock]),...(handlers.note?[]:[noteHost]),...(handlers.status?[]:[statusHost]),notices,page);root.dataset.mode=mode;root.dataset.tool=tool;
  for(const name of Object.keys(TOOLS))root.style?.setProperty?.('--cur-'+name,toolCursor(name));
  root.onwheel=e=>{if(mode==='timing'&&e.ctrlKey){e.preventDefault?.();api.zoomBy(e.deltaY<0?1:-1);}};
  const suggestions=el('datalist');suggestions.id='chord-list';for(const c of CHORD_SUGGESTIONS){const o=el('option');o.value=c;suggestions.append(o);}

  const timing=createTiming({
    getData:()=>data,getModel:()=>model,getSnap:()=>snapping?autoSnap(zoom):'free',getZoom:()=>zoom,tool:()=>tool,get refs(){return refs;},
    editBars:handlers.onBarEdit?change=>Promise.resolve(handlers.onBarEdit(change)).catch(e=>fail(e)):null,commit:(candidate,label)=>commitPlain(candidate,label),fail:e=>fail(e),say:text=>{message.textContent=text;},blocked:()=>blocked(),rerender:()=>render(),
  });
  const notify=()=>handlers.onDraftChange?.({draft:!!draft?.dirty,saving,failed:!!draft?.failed});
  const fail=e=>{message.textContent=e?.message||String(e);handlers.onError?.(e);};
  const context=()=>({documentId:data.documentId,revision:data.revision});
  const group=id=>model?.projection.groups.find(g=>g.id===id);

  // ----- which pass? Playback wins while it is inside the group; otherwise the last pass you chose; otherwise the first. -----
  function playingPass(groupId){const t=last?.target;return t&&t.groupId===groupId?t.passNumber:null;}
  const passForSeek=g=>playingPass(g.id)??seekPass[g.id]??1;
  const passForEdit=g=>targetPass[g.id]??playingPass(g.id)??1;
  function occurrenceFor(groupId,slotId,pass){return model.projection.occurrences.find(o=>o.groupId===groupId&&o.slotId===slotId&&o.passNumber===pass)||null;}

  function seek(seconds){if(!finite(seconds))return;Promise.resolve(handlers.onSeek?.(seconds)).catch(fail);}
  function blocked(){
    if(saving){message.textContent='Saving… one moment.';return true;}
    if(draft?.dirty){message.textContent='Press Enter to keep your change or Esc to drop it first.';draft.node?.focus?.();return true;}
    return false;
  }

  // ======================= rendering =======================
  // no chord (a break in the music) is simply a gap; in the Write tool the gap can still be clicked to type a chord there
  function chordLabel(chunk){if(isNoChordLabel(chunk.label))return '';const shown=spellChord(chunk.label);return chunk.continued?'('+shown+')':shown;}
  function renderChord(g,bar,chunk){
    const holder=el('span','chord-line'),b=el('button','chord'+(isNoChordLabel(chunk.label)?' rest':''),chordLabel(chunk));b.type='button';b.dataset.chunk=chunk.key;
    b.title=mode==='edit'?'Type a new chord':'';
    b.onclick=()=>onChordClick(g,chunk,b);
    holder.append(b);
    if(chunk.repeat>1){const r=el('span','repeat','(×'+chunk.repeat+')');r.title='Played '+chunk.repeat+' times';holder.append(r);}
    refs.chords.push({node:b,chunk,group:g});return holder;
  }
  function renderLaneSlot(g,bar,chunk,lane,laneIndex,first){
    const tokens=chunk.lanes[laneIndex]||[],holder=el('span','lane'),slot=el('span','lyr');slot.dataset.lane=String(laneIndex);slot.dataset.pass=String(lane.passNumber);
    if(first&&g.passCount>1&&mode!=='timing'){
      const tag=el('span','lane-tag',String(lane.passNumber));tag.title='Pass '+lane.passNumber;
      tag.onclick=e=>{e?.stopPropagation?.();seekPass[g.id]=lane.passNumber;};
      refs.lanes.push({tag,group:g,lane});holder.append(tag);
    }
    holder.append(slot);refs.slots.push({node:slot,group:g,lane});
    tokens.forEach((t,i)=>{
      const w=el('span','w',t.text+(i<tokens.length-1&&!t.text.endsWith('-')?' ':''));
      w.dataset.line=String(t.line);w.dataset.offset=String(t.offset);
      w.onclick=()=>{if(finite(t.seconds)){seekPass[g.id]=t.passNumber;seek(t.seconds);}};
      refs.words.push({node:w,token:t,group:g,lane});slot.append(w);
    });
    return holder;
  }
  function renderChunk(g,bar,chunk,isLast){
    const node=el('span','chunk'),cell={node,group:g,chunk};node.dataset.chunk=chunk.key;
    node.append(renderChord(g,bar,chunk));
    if(mode!=='edit')g.lanes.forEach((lane,i)=>node.append(renderLaneSlot(g,bar,chunk,lane,i,bar===g.bars[0]&&chunk===bar.chunks[0])));
    if(mode==='edit'&&tool==='write'&&chunk.chordId){const add=el('button','add-chord','+');add.type='button';add.title='Add a chord after this one';add.onclick=e=>{e?.stopPropagation?.();addChordAfter(g,chunk);};node.append(add);}
    refs.chunks.push(cell);return node;
  }
  function renderBar(g,bar,index){
    const n=el('div','bar'+(index===g.bars.length-1?' last':''));n.dataset.bar=bar.id;
    const no=el('span','bar-no',String(bar.number));no.title='Jump to bar '+bar.number;
    no.onclick=e=>{if(mode==='edit'&&tool==='repeat'){e?.stopPropagation?.();pickBar(g,bar);return;}if(mode!=='nav')return;const o=g.bars&&occurrenceFor(g.id,bar.chunks[0]?.slotId,passForSeek(g.model||g));seek(o?.start??bar.start);};
    if(mode==='edit'&&tool==='repeat'){no.classList.add('pickable');no.title='Pick bar '+bar.number+' for the repeat';if(fixSel.ids.has(bar.id))n.classList.add('rt-sel');}
    n.append(no);
    // A bar that is shorter or longer than the usual one says so, informally; a real change of meter keeps its signature.
    if(bar.odd)n.append(el('span','bar-meter odd',beatsLabel(bar.beatCount)));
    else if(bar.meterChange&&bar.meter)n.append(el('span','bar-meter',bar.meter.join('/')));
    if(mode==='edit'&&tool==='cut'&&bar.mapped)n.append(cutZone(g,bar,index));
    for(const chunk of bar.chunks)n.append(renderChunk(g,bar,chunk,index===g.bars.length-1));
    if(!bar.chunks.length&&mode!=='edit')for(const [i,lane] of g.lanes.entries())n.append(renderLaneSlot(g,bar,{key:null,slotId:null,lanes:{}},lane,i,false));
    return n;
  }
  // A repeat sign is drawn from plain shapes (a rule and two dots), not gradients: gradients turn into grey blocks in a PDF.
  function repeatSign(side){const sign=el('span','rep-sign '+side);sign.append(el('i','rep-dot a'),el('i','rep-dot b'));return sign;}
  function renderGroup(section,g){
    if(mode==='timing')return timing.renderGroup(section,g);
    const row=el('div','row'+(g.lanes.length?' has-lyrics':'')),bars=el('div','bars');row.dataset.group=g.id;
    g.model=g;refs.groups.push({node:row,model:g});
    if(mode==='edit'&&tool==='write'&&g.passCount>1){
      const pick=el('span','pass-pick');pick.title='Which pass your chord changes apply to';
      for(let p=1;p<=g.passCount;p++){const s=el('button','',String(p));s.type='button';s.dataset.pass=String(p);s.onclick=()=>{targetPass[g.id]=p;paintTargets();};pick.append(s);}
      refs.lanes.push({pick,group:g});row.append(pick);
    }
    g.bars.forEach((bar,i)=>{
      const node=renderBar(g,bar,i);
      // a repeated progression starts and ends with repeat signs (the count stays after the last chord)
      if(g.repeat>1){if(i===0){node.classList.add('rep-start');node.append(repeatSign('start'));}if(i===g.bars.length-1){node.classList.add('rep-end');node.append(repeatSign('end'));}}
      bars.append(node);
    });
    // lyric lines that were never placed on the chart: plain text (in Edit they get a line of their own, below)
    if(mode!=='edit')for(const lane of g.lanes.filter(l=>l.flow)){
      const flow=el('div','flow-line'),text=el('span','flow-text',lane.tokens.map(t=>t.text).join(' ')||lane.text);
      flow.append(text);bars.append(flow);
    }
    row.append(bars);
    // Edit: choose how this repeating stretch is folded (2 bars x4, 4 bars x2, or written out).
    if(mode==='edit'&&tool==='repeat'&&g.repeat>1){
      const source=model.projection.groups.find(x=>x.id===g.id),choices=compactFoldChoices(model.projection,source);
      if(choices.length>1){
        const wrap=el('div','repeat-fold'),open=el('button','repeat-fold-open','Fold ▾');open.type='button';open.title='Choose how this repeating stretch is grouped';
        const list=el('div','repeat-fold-options hidden');
        for(const choice of choices){
          const b=el('button','repeat-fold-option'+(choice.current?' current':''),choice.label);b.type='button';b.disabled=choice.current;
          b.onclick=()=>{try{commitPlain(applyCompactFold(data.content,data.music,model.projection,source,choice),'Change repeat grouping');}catch(e){fail(e);}};
          list.append(b);
        }
        open.onclick=()=>list.classList.toggle('hidden');wrap.append(open,list);row.append(wrap);
      }
    }
    if(mode==='edit')row.append(renderLaneEditors(g,row));
    if(g.endings.length&&mode!=='timing'){
      const alts=el('div','alt-endings');
      for(const e of g.endings.filter(e=>!e.passNumbers.includes(1))){
        const item=el('div','alt-ending');item.append(el('span','ending-label',(e.passNumbers.length===1?'Ending ':'Endings ')+e.passNumbers.join(', ')),el('span','bar-no',String(e.measureNumber)));
        for(const o of e.chords){const rest=isNoChordLabel(o.label);const b=el('button','chord ending-chord'+(rest?' rest':''),rest?'':o.label);b.type='button';b.dataset.occurrence=o.id;b.onclick=()=>{if(mode==='nav')seek(o.start);else if(tool==='write')onEndingEdit(g,o,b);};refs.endings.push({node:b,occurrence:o});item.append(b);}
        alts.append(item);
      }
      if(alts.children.length)row.append(alts);
    }
    return row;
  }

  // ======================= the tool rail =======================
  if(handlers.dock)watchRail(handlers.dock);
  // The rail stands beside the chart (never on it). The tool you hold decides what a click means everywhere else, so the chart itself
  // stays free of little buttons. Esc puts the tool down (back to Navigate).
  function renderTools(){
    dock.dataset.owner='chart';
    renderRail(dock,{groups:TOOL_GROUPS,active:tool,onPick:name=>api.setTool(name)});
    // What the tool does is one quiet line under the chart; only a tool that has controls (Repeat) puts anything in the bar above it.
    const controls=el('div','tool-controls'),lines=[];
    if(tool==='repeat')fillRepeatHint(controls,lines);
    const say=el('span','status-hint',lines.length?lines.join(' \u00b7 '):(TOOLS[tool]?.hint||''));
    statusHost.replaceChildren(say);
    if(tool!==DEFAULT_TOOL){
      const back=el('button','tool-put-down');back.type='button';back.innerHTML='<kbd>Esc</kbd> put it down';back.onclick=()=>api.setTool(DEFAULT_TOOL);statusHost.append(back);
    }
    statusHost.append(message);
    noteHost.replaceChildren(...(controls.children.length?[controls]:[]));
  }

  // ---------------- Fix repeats by hand ----------------
  const barNumber=id=>{const m=model.measures.find(m=>m.id===id);return m?m.number-model.barOffset:'?';};
  const measureIndex=id=>model.measures.findIndex(m=>m.id===id);
  function pickBar(g,bar){
    const src=model.projection.groups.find(x=>x.id===g.id),folded=src?.folded&&src.passes?.length>1;
    const pick=folded?{start:src.passes[0].measureIds[0],end:src.passes.at(-1).measureIds.at(-1)}:{start:bar.id,end:bar.id};
    if(!pick.start||!pick.end)return;
    if(fixing.a&&fixing.b){fixing.a=pick;fixing.b=null;}else if(!fixing.a)fixing.a=pick;else fixing.b=pick;
    keepPlace(()=>render());
  }
  function fixRange(){
    if(!fixing.a)return null;
    const b=fixing.b||fixing.a,backwards=measureIndex(b.start)<measureIndex(fixing.a.start);
    return backwards?{from:b.start,to:fixing.a.end}:{from:fixing.a.start,to:b.end};
  }
  function fixSelection(){
    const range=fixRange(),none={ids:new Set(),info:null};
    if(!range||!fixing.b&&!fixing.a)return none;
    try{const info=compactRangeChoices(data.content,data.music,range.from,range.to);return {ids:new Set(info.measureIds||[range.from]),info,range};}catch{return none;}
  }
  // The Repeat tool: the steps go in the status line (`lines`), the choices and links in the bar above it (`controls`).
  function fillRepeatHint(controls,lines){
    const sel=fixSel;
    if(!fixing.a)lines.push('Click the number of the first bar of the part that repeats');
    else if(!fixing.b)lines.push('Bar '+barNumber(fixing.a.start)+' picked. Click the last bar to take in more, or choose below');
    if(fixing.a&&sel.info){
      const info=sel.info;
      if(info?.measureIds){
        lines.push(info.length===1?'Bar '+barNumber(info.measureIds[0]):'Bars '+barNumber(info.measureIds[0])+'\u2013'+barNumber(info.measureIds.at(-1))+' ('+info.length+' bars)');
        if(info.problem)lines.push(info.problem);
        for(const choice of info.choices||[]){
          const b=el('button','fix-choice'+(choice.expanded?' plain':''),choice.label);b.type='button';
          b.onclick=()=>{try{const next=applyCompactRange(data.content,data.music,model.projection,sel.range.from,sel.range.to,choice);fixing.a=fixing.b=null;commitPlain(next,choice.expanded?'Unfold repeat':'Fold repeat');}catch(e){fail(e);}};
          controls.append(b);
        }
      }else if(info?.problem)lines.push(info.problem);
    }
    if(fixing.a){const again=el('button','fix-link','Start over');again.type='button';again.onclick=()=>{fixing.a=fixing.b=null;keepPlace(()=>render());};controls.append(again);}
    if(hasCompactPreferences(data.content)){const reset=el('button','fix-link','Reset all my repeat choices');reset.type='button';reset.onclick=()=>{fixing.a=fixing.b=null;commitPlain(resetCompactPreferences(data.content),'Reset repeat grouping');};controls.append(reset);}
  }
  // Redrawing (a new mode, zoom, a saved edit) keeps the row nearest the top of the view exactly where it was.
  function keepPlace(fn){
    const desk=root.closest?.('.desk')||root.parentElement;
    const top=desk?.getBoundingClientRect?.().top??0,rows=refs.groups||[];
    const anchor=rows.find(r=>r.node.getBoundingClientRect?.().bottom>top+10);
    const id=anchor?.model.id,offset=anchor?anchor.node.getBoundingClientRect().top-top:0,left=desk?.scrollLeft;
    fn();
    const again=refs.groups.find(r=>r.model.id===id);
    if(again&&desk&&desk.scrollTop!==undefined)desk.scrollTo?.({top:desk.scrollTop+again.node.getBoundingClientRect().top-top-offset,left:left??0,behavior:'instant'});
  }
  // Every redraw keeps the chart where it is on screen: rebuilding empties the page for a moment, which would otherwise scroll it to the top.
  function render(){keepPlace(draw);}
  function draw(){
    if(!data)return;
    model=buildChartModel(data.content,data.music,{onsets:data.suggest?data.onsets:null});
    refs={chunks:[],groups:[],sections:[],lanes:[],words:[],chords:[],slots:[],editors:[],endings:[]};
    occById=new Map(model.projection.occurrences.map(o=>[o.id,o]));
    notices.replaceChildren();for(const w of model.warnings)notices.append(el('p','chart-notice',w));
    fixSel=mode==='edit'&&tool==='repeat'?fixSelection():{ids:new Set()};
    cutTimes=cutPoints();
    renderTools();
    page.replaceChildren();
    for(const section of model.sections){
      const sec=el('section','sec');sec.dataset.section=section.id;sec.dataset.name=nameKey(section.name);
      const head=el('header','sec-head'),num=el('span','sec-num',pad2(section.number)),name=el('h3','sec-name',section.name),time=el('span','sec-time',clock(section.start));
      head.append(num,name,time);
      if(mode==='edit'){
        if(tool==='write'){name.contentEditable='plaintext-only';wireSectionName(name,section);}
        else if(tool==='glue'&&refs.sections.length>0)glueHead(head,section);
      }
      else head.onclick=()=>{if(mode==='nav')seek(section.start);};
      if(mode==='edit'&&tool==='write'||mode==='timing')copyButtons(head,section);
      sec.append(head);refs.sections.push({node:sec,section});
      // Short rows share a line: a one-bar repeat and its neighbours sit side by side while together they fit in a line's worth of bars
      // (bars-per-line). Rows with lyrics keep a line of their own, and the Time tool draws every row on its own.
      const perLine=Math.max(1,data.content?.layout?.bars_per_line||4);let pack=null,packBars=0;
      for(const g of section.groups){
        const row=renderGroup(section,g),count=g.bars?.length||1;
        if(mode==='timing'||row.querySelector?.('.pass-pick')){pack=null;packBars=0;sec.append(row);continue;}
        // a row with lyrics keeps a line of its own (its words need the width) but still uses the same slots, so its barlines line up too
        const lyrics=!!g.lanes?.length;
        if(lyrics||!pack||packBars+count>perLine){pack=el('div','row-pack');sec.append(pack);packBars=0;}
        // every bar gets an equal share of a line, so barlines (and the end of every full line) line up from row to row
        row.dataset.slots=String(Math.min(perLine,count));row.classList.add('slotted');
        pack.append(row);packBars+=lyrics?perLine:count;
      }
      page.append(sec);
    }
    page.append(suggestions);
    layoutRows();
    if(pendingName){const node=page.querySelector?.('[data-section="'+pendingName+'"] .sec-name');pendingName=null;if(node){node.focus?.();getSelection?.()?.selectAllChildren?.(node);}}
    root.dataset.mode=mode;root.dataset.tool=tool;last=null;paintTargets();updatePlayback(data.transport);positionEditors();
  }

  // Share the bars of each row out evenly over its lines (2 + 2, not 3 + 1) and close every line with a barline.
  function layoutRows(){
    if(mode==='timing')return;
    // Each row takes whole slots (a line holds bars-per-line slots): one per bar, or more when its contents (repeat signs, a long
    // chord) need the room, so barlines stay on the same grid from row to row instead of spilling past it.
    const perLine=Math.max(1,data?.content?.layout?.bars_per_line||4);
    for(const pack of root.querySelectorAll?.('.row-pack')||[]){
      const slot=(pack.clientWidth||0)/perLine;
      for(const row of pack.children){
        if(!slot){row.style.width=(Number(row.dataset.slots||perLine)/perLine*100)+'%';continue;}
        row.classList.add('natural');row.style.width='';
        const natural=row.offsetWidth||0;row.classList.remove('natural');
        const slots=Math.min(perLine,Math.max(Number(row.dataset.slots||1),Math.ceil((natural+1)/slot)));
        row.style.width=(slots/perLine*100)+'%';
      }
    }
    for(const entry of refs.groups){const bars=entry.node.querySelector?.('.bars');if(bars)applyRows(bars);}
  }
  if(typeof ResizeObserver==='function'){
    let waiting=false,lastWidth=0;
    new ResizeObserver(()=>{if(waiting||Math.abs(root.clientWidth-lastWidth)<1)return;waiting=true;requestAnimationFrame(()=>{waiting=false;lastWidth=root.clientWidth;layoutRows();});}).observe(root);
    document.fonts?.ready?.then(()=>layoutRows());
  }

  // ======================= playback highlighting =======================
  function paintTargets(){
    for(const r of refs.lanes){
      if(r.tag){r.tag.classList.toggle('target',mode==='edit'&&passForEdit(r.group)===r.lane.passNumber);}
      if(r.pick)for(const b of r.pick.children)b.classList.toggle('on',passForEdit(r.group)===Number(b.dataset.pass));
    }
  }
  function updatePlayback(transport){
    if(!data)return;data.transport=transport;if(!model)return;
    const seconds=transport.seconds,target=playbackTarget(model,seconds);
    const occ=target?occById.get(target.occurrenceId):null,first=occ?model.projection.occurrences.find(o=>o.groupId===occ.groupId&&o.slotId===occ.slotId&&o.passNumber===1):null;
    const alt=!!occ&&!!occ.ending&&!!first&&first.endingVariant!==occ.endingVariant;      // the changed ending is playing, not the displayed one
    const sig=JSON.stringify([target?.chunkKey,target?.passNumber,target?.sectionId,alt,occ?.id]);
    const wordIndexes=new Map();
    for(const r of refs.groups)for(const [i,lane] of r.model.lanes.entries()){
      const live=!lane.flow&&lane.span&&seconds>=lane.span.start-1e-6&&seconds<lane.span.end&&(r.model.passCount===1||target?.groupId===r.model.id&&target.passNumber===lane.passNumber);
      const placed=lane.tokens.filter(t=>!t.flow);
      wordIndexes.set(lane,live?currentWordIndex(placed.map(t=>({seconds:t.seconds})),seconds):-1);
    }
    const wsig=sig+JSON.stringify([...wordIndexes.values()]);
    const changedTarget=!last||last.sig!==sig;
    if(last&&last.wsig===wsig&&last.mode===mode){last={...last,target};return;}
    last={sig,wsig,mode,target};
    for(const r of refs.sections)r.node.classList.toggle('now',r.section.id===target?.sectionId);
    for(const r of refs.groups){
      const here=target?.groupId===r.model.id;
      if(here)r.node.dataset.cur=String(target.passNumber);else delete r.node.dataset.cur;
      r.node.classList.toggle('now',here);
      if(here&&r.model.passCount>1)seekPass[r.model.id]=target.passNumber;
    }
    for(const r of refs.chunks)r.node.classList.toggle('now',!!target&&!alt&&r.chunk.key===target.chunkKey);
    for(const r of refs.endings)r.node.classList.toggle('now',!!occ&&r.occurrence.id===occ.id);
    for(const r of refs.slots)r.node.classList.toggle('dim',!!target&&target.groupId===r.group.id&&r.group.passCount>1&&target.passNumber!==r.lane.passNumber);
    for(const r of refs.words){
      const placed=r.lane.tokens.filter(t=>!t.flow),idx=wordIndexes.get(r.lane);
      r.node.classList.toggle('wnow',idx>=0&&placed[idx]===r.token);
    }
    for(const r of refs.lanes)if(r.tag)r.tag.classList.toggle('cur',target?.groupId===r.group.id&&target.passNumber===r.lane.passNumber);
    if(changedTarget&&mode==='nav'&&transport.playing&&target)followPlayback(target);
  }
  // Keep the playing row on screen while playing in Navigate, without fighting the reader.
  function followPlayback(target){
    const row=refs.groups.find(r=>r.model.id===target.groupId)?.node;if(!row?.getBoundingClientRect)return;
    const desk=root.closest?.('.desk')||root.parentElement;const box=desk?.getBoundingClientRect?.(),r=row.getBoundingClientRect();
    if(!box||desk.scrollHeight<=desk.clientHeight)return;
    if(r.top<box.top+box.height*.12||r.bottom>box.top+box.height*.8)row.scrollIntoView?.({block:'center',behavior:'smooth'});
  }

  // ======================= Navigate =======================
  function onChordClick(g,chunk,button){
    if(mode==='nav'){
      const pass=passForSeek(g),target=compactJumpTargets(model.projection,{groupId:g.id,slotId:chunk.slotId}).find(t=>t.passNumber===pass)||compactJumpTargets(model.projection,{groupId:g.id,slotId:chunk.slotId})[0];
      seekPass[g.id]=pass;seek(target?.seconds??chunk.start);return;
    }
    if(mode==='edit'&&tool==='write')startChordEdit(g,chunk,button);
  }

  // ======================= Edit: chords =======================
  async function commitPlain(candidate,label){
    if(saving)return false;saving=true;notify();
    try{await handlers.onCommit?.(candidate,label,context());message.textContent='';return true;}
    catch(e){fail(e);return false;}
    finally{saving=false;notify();}
  }
  function startChordEdit(g,chunk,button){
    if(blocked()||!chunk.chordId)return;
    if(handlers.canEdit?.()===false){message.textContent='Wait for the save, or reload the chart before editing again.';return;}
    const input=el('input','chord-input');input.value=chunk.label==='?'||isNoChordLabel(chunk.label)?'':spellChord(chunk.label);input.setAttribute('list','chord-list');input.setAttribute('aria-label','Chord');input.defaultValue=input.value;input.size=Math.max(3,input.value.length+1);
    draft={kind:'chord',node:input,dirty:false,failed:false};
    button.replaceWith?.(input);if(!button.replaceWith){button.parent?.children.splice(button.parent.children.indexOf(button),1,input);}
    let done=false;
    // Enter on an empty box deletes the chord; leaving an empty box any other way (Esc, a click elsewhere) changes nothing.
    const finish=async(save,remove=false)=>{
      if(done)return;done=true;const value=input.value.trim();draft=null;
      const same=value===(chunk.label==='?'?'':spellChord(chunk.label))||value===(chunk.label==='?'?'':chunk.label);
      if(!save||(!remove&&(same||!value))){render();notify();return;}
      try{
        const pass=passForEdit(g),occ=occurrenceFor(g.id,chunk.slotId,pass)||chunk.occurrence;
        const target={chordId:occ.chordId,scope,selection:{groupId:g.id,slotId:chunk.slotId,passNumber:occ.passNumber,chordId:occ.chordId},view:model.projection};
        const result=remove?planChartChordDelete(data.content,data.music,target):planChartChordEdit(data.content,data.music,{...target,label:value});
        if(result.conflicts.length){fail(Error(result.conflicts[0].message));render();return;}
        await commitPlain(result.candidate,remove?(scope==='all-matching'?'Delete chords in matching passes':'Delete chord'):scope==='all-matching'?'Edit chords in matching passes':'Edit chord');
      }catch(e){fail(e);}
      render();
    };
    input.oninput=()=>{draft.dirty=true;input.size=Math.max(3,input.value.length+1);};
    input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault?.();finish(true,!input.value.trim()&&!!input.defaultValue);}else if(e.key==='Escape'){e.preventDefault?.();finish(false);}};
    input.onblur=()=>finish(true);
    input.focus();input.select?.();notify();
  }
  function onEndingEdit(g,occurrence,button){
    const chunk={chordId:occurrence.chordId,label:occurrence.label??'?',slotId:occurrence.slotId,occurrence};
    targetPass[g.id]=occurrence.passNumber;startChordEdit(g,chunk,button);
  }
  async function addChordAfter(g,chunk){
    if(blocked())return;
    try{
      const pass=passForEdit(g),occ=occurrenceFor(g.id,chunk.slotId,pass)||chunk.occurrence;
      const targets=scope==='all-matching'?compactEditTargets(model.projection,{groupId:g.id,slotId:chunk.slotId,passNumber:occ.passNumber,chordId:occ.chordId,scope}).chordIds:[occ.chordId];
      let next=structuredClone(data.content);
      const base=data.content.chords.find(c=>c.id===occ.chordId);
      const time=splitTime(base,data.music);
      for(const id of targets){
        const c=data.content.chords.find(x=>x.id===id);next=addChartChord(next,c.start+(time-base.start),crypto.randomUUID(),'C');
      }
      await commitPlain(next,'Add chord');
    }catch(e){fail(e);}
  }

  // ======================= Edit: one line of words per pass =======================
  // Each pass of a row has one editable line under it. It is separate from the chords, so typing never moves them; the words are
  // spread between whatever pins exist when you leave the line. A new line starts at the chord you click and ends with the row.
  function laneItems(g){
    const items=g.lanes.map(lane=>({group:g,lane,passNumber:lane.passNumber,id:g.id+'|'+lane.line}));
    const have=new Set(g.lanes.filter(l=>!l.flow).map(l=>l.passNumber));
    const wanted=g.passCount>1?g.passes.map(p=>p.number).filter(n=>!have.has(n)):(g.lanes.length?[]:[1]);
    for(const n of wanted)items.push({group:g,lane:null,passNumber:n,id:g.id+'|new'+n});
    return items.sort((a,b)=>a.passNumber-b.passNumber);
  }
  function renderLaneEditors(g,row){
    const box=el('div','lane-edits');
    for(const item of laneItems(g)){
      const tokens=item.lane?.tokens||[],text=joinWords(tokens),line=el('div','lane-edit'),editor=el('span','lyr');
      if(g.passCount>1){
        const tag=el('span','lane-tag',String(item.passNumber));tag.title='Pass '+item.passNumber+' · click to make chord changes apply to it';
        tag.onclick=e=>{e?.stopPropagation?.();targetPass[g.id]=item.passNumber;paintTargets();};
        refs.lanes.push({tag,group:g,lane:{passNumber:item.passNumber}});line.append(tag);line.classList.add('tagged');
      }
      editor.contentEditable=tool==='write'?'plaintext-only':'false';
      editor.dataset.placeholder=item.lane?'…':(g.passCount>1?'Click and type the words for pass '+item.passNumber:'Click and type the words');
      editor.append(document.createTextNode?document.createTextNode(text):text);
      const ref={...item,node:editor,line,row,original:text,anchorKey:tokens[0]?.chunkKey??null};
      editor._lane=ref;refs.editors.push(ref);wireLane(ref);line.append(editor);
      if(item.lane?.flow){const place=el('button','add-lyrics','Place on this row');place.type='button';place.onclick=()=>placeFlowLine(g,item.lane);line.append(place);}
      box.append(line);
    }
    return box;
  }
  // Where a line starts: under the chord its first word is pinned or placed at (or the chord you clicked, for a new line).
  function positionEditors(){
    for(const ref of refs.editors){
      const chunk=refs.chunks.find(c=>c.chunk.key===ref.anchorKey)?.node,rowBox=ref.row.getBoundingClientRect?.(),box=chunk?.getBoundingClientRect?.();
      const x=rowBox&&box?Math.max(0,box.left-rowBox.left):0;
      ref.line.style?.setProperty?.('--start',x+'px');
    }
  }
  function wireLane(ref){
    const editor=ref.node;let done=false;
    editor.onfocus=()=>{draft={kind:'lyric',node:editor,dirty:false,failed:false};done=false;notify();};
    editor.oninput=()=>{if(draft?.node===editor)draft.dirty=editor.textContent.trim()!==ref.original.trim();notify();};
    editor.onmousedown=e=>{
      // a new line begins at the chord nearest the click
      if(ref.lane||ref.node.textContent||!finite(e?.clientX))return;
      const mine=refs.chunks.filter(c=>c.group===ref.group&&c.node.getBoundingClientRect);
      let best=null,gap=Infinity;for(const c of mine){const d=Math.abs(c.node.getBoundingClientRect().left-e.clientX);if(d<gap){gap=d;best=c;}}
      if(best){ref.anchorKey=best.chunk.key;positionEditors();}
    };
    const finish=async save=>{
      if(done)return false;done=true;
      const raw=editor.textContent;draft=null;
      if(!save||raw.replace(/\s+/g,' ').trim()===ref.original.trim()){editor.textContent=ref.original;notify();return false;}
      try{await commitLanes(ref,raw);}catch(e){fail(e);}
      render();return true;
    };
    editor.onkeydown=async e=>{
      if(e.key==='Enter'||e.key==='Tab'&&!e.shiftKey){
        e.preventDefault?.();
        const at=refs.editors.indexOf(ref),next=refs.editors[at+1]?.id;
        await finish(true);
        if(next){const target=refs.editors.find(r=>r.id===next);target?.node.focus?.();}
      }else if(e.key==='Escape'){e.preventDefault?.();finish(false);}
    };
    editor.onblur=()=>finish(true);
  }
  // Save what was typed. Several lines pasted at once flow into the next lines in order, so a whole song can be pasted into the first one.
  async function commitLanes(ref,raw){
    if(saving)return;
    const lines=String(raw).split(/\n+/).map(t=>t.replace(/\s+/g,' ').trim()),filled=lines.filter(Boolean);
    const multiple=filled.length>1,texts=multiple?filled:[filled[0]??''];
    const targets=refs.editors.slice(refs.editors.indexOf(ref));
    if(texts.length>targets.length)throw Error('That is '+texts.length+' lines of words but only '+targets.length+' lines to put them on from here. Trim the text or add rows first.');
    let content=data.content,lost=0;const labels=new Set(),touched=new Set();
    texts.forEach((text,k)=>{
      const target=targets[k];
      if(target.lane&&text===target.original.trim())return;
      const key=target.group.sectionId+':'+target.lane?.line;
      if(target.lane&&touched.has(key))throw Error('One lyric line runs across several rows here. Paste fewer lines, or fix it one row at a time.');
      const planned=planPageEdit.laneText({content,music:data.music,model,group:target.group,lane:target.lane,passNumber:target.passNumber,anchorKey:target.anchorKey,text});
      if(planned.conflicts?.length)throw Error(planned.conflicts[0].message);
      if(planned.candidate){content=planned.candidate;lost+=planned.lost||0;labels.add(planned.label);if(target.lane)touched.add(key);}
    });
    if(content===data.content)return;
    const saved=await commitPlain(content,multiple?'Add lyrics':[...labels][0]||'Edit lyrics');
    if(saved&&lost)message.textContent=lost===1?'One pinned word no longer exists, so its pin was removed. Undo brings it back.':lost+' pinned words no longer exist, so their pins were removed. Undo brings them back.';
  }
  async function placeFlowLine(g,lane){
    if(blocked())return;
    try{
      const pass=g.passes.find(p=>p.number===(lane.passNumber||1))||g.passes[0];
      const next=planPageEdit.placeOnRow({content:data.content,music:data.music,group:g,pass,lane});
      await commitPlain(next,'Place lyric line');
    }catch(e){fail(e);}
  }

  // ======================= Edit: split and join sections =======================
  // A section is never empty: a split must fall inside it, and joining removes the boundary instead of leaving a hole.
  // The Split tool: every bar gets two big halves; the half you point at shows a dashed split line on its edge.
  let cutTimes=[];
  function cutPoints(){
    if(mode!=='edit'||tool!=='cut'||!model)return [];
    const times=[];
    for(const section of model.sections)section.groups.forEach((g,i)=>{
      if(i>0)times.push(g.start);
      if(g.passCount===1)g.bars.forEach((bar,j)=>{if(j>0&&bar.mapped)times.push(bar.start);});
    });
    return times;
  }
  const canCut=t=>Number.isFinite(t)&&cutTimes.some(x=>Math.abs(x-t)<1e-6);
  function cutZone(g,bar,index){
    const zone=el('div','cut-zone'),last=index===g.bars.length-1;
    const sides=[['left',bar.start],['right',g.passCount===1?bar.end:last?g.end:NaN]];
    for(const [side,seconds] of sides){
      const half=el('button','cut-half '+side);half.type='button';
      if(canCut(seconds)){
        const snip=el('span','snip');snip.innerHTML=toolIcon('cut');half.append(snip);
        half.setAttribute('aria-label','Start a new section at the '+side+' edge of bar '+bar.number);
        half.onclick=e=>{e?.stopPropagation?.();splitAt(seconds);};
      }else{half.classList.add('off');half.tabIndex=-1;half.setAttribute('aria-hidden','true');}
      zone.append(half);
    }
    return zone;
  }
  // The Join tool: the whole section heading becomes a glue button for the section above it.
  function glueHead(head,section){
    head.classList.add('glue-able');
    const badge=el('span','glue-badge');badge.innerHTML=toolIcon('glue')+'<span>Glue to the section above</span>';head.append(badge);
    head.setAttribute('role','button');head.tabIndex=0;head.setAttribute('aria-label','Join '+section.name+' with the section above');
    head.onclick=e=>{e?.stopPropagation?.();joinWithPrevious(section);};
    head.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault?.();joinWithPrevious(section);}};
  }
  async function splitAt(seconds){
    if(blocked())return;
    try{
      const section=model.sections.find(s=>seconds>s.start+1e-9&&seconds<s.end-1e-9);
      const address=addressAtSeconds(model.measures,seconds);
      if(!section||!address)throw Error('Choose a bar inside a section to split it.');
      const newId=crypto.randomUUID();
      const result=planSectionEdit(data.content,data.music,{sectionId:section.id,operation:'split',fields:{address:{measure_id:address.measure_id,beat:address.beat},newId,name:'New section'}});
      if(result.conflicts?.length)return fail(Error(result.conflicts[0].message));
      // Straight after a cut the new section's name is ready to type, so the scissors are put down and Write takes over.
      pendingName=newId;tool='write';fixing.a=fixing.b=null;
      if(!await commitPlain(result.candidate,'Split section')){pendingName=null;tool='cut';keepPlace(render);}
    }catch(e){pendingName=null;fail(e);}
  }
  async function joinWithPrevious(section){
    if(blocked())return;
    try{
      const result=planSectionEdit(data.content,data.music,{sectionId:section.id,operation:'merge',fields:{direction:'previous',acceptGap:false}});
      if(result.conflicts?.length)return fail(Error(result.conflicts[0].message));
      await commitPlain(result.candidate,'Join sections');
    }catch(e){fail(e);}
  }

  // ======================= Copy a section's lyrics and timing onto its repeat =======================
  // A section with words, and another with the same name (Chorus / Chorus 2), offers to copy its lyrics and where every pinned word sits.
  // How a section is named in the button: by where it sits among the sections of that name, never by an internal number.
  function copyName(from,target){
    const same=copyGroup(data.content,from),order=same.findIndex(s=>s.id===target.id),here=same.findIndex(s=>s.id===from.id),total=same.length;
    const ordinal=n=>n+(['th','st','nd','rd'][(n%100>>3^1&&n%10<4)?n%10:0]||'th');
    const which=total===2?(order>here?'the next ':'the previous '):'the '+ordinal(order+1)+' ';
    return which+target.name;
  }
  function copyButtons(head,section){
    for(const target of copyTargets(data.content,section.id)){
      const label=copyName(section,target);
      const b=el('button','sec-copy','Copy lyrics to '+label+(String(target.lyrics||'').trim()?' (replaces)':''));b.type='button';
      b.title='Copies these words and their timing onto '+target.name+', bar for bar. '+(String(target.lyrics||'').trim()?'The words already there are replaced. ':'')+'Undo puts it back.';
      b.onclick=async event=>{
        event.stopPropagation?.();
        try{
          const {candidate,dropped}=copySectionLyrics(data.content,data.music,section.id,target.id);
          await commitPlain(candidate,'Copy lyrics to '+target.name);
          if(dropped)message.textContent=dropped+(dropped===1?' timed word was':' timed words were')+' left unpinned: '+target.name+' has no matching place for '+(dropped===1?'it':'them')+'.';
        }catch(e){fail(e);}
      };
      head.append(b);
    }
  }

  // ======================= Edit: section names =======================
  function wireSectionName(node,section){
    let done=false;
    const finish=async save=>{
      if(done)return;done=true;const name=node.textContent.replace(/\s+/g,' ').trim();draft=null;
      if(!save||!name||name===section.name){node.textContent=section.name;notify();return;}
      try{const result=planSectionEdit(data.content,data.music,{sectionId:section.id,operation:'edit',fields:{name}});
        if(result.conflicts?.length)fail(Error(result.conflicts[0].message));else await commitPlain(result.candidate,'Edit section');}
      catch(e){fail(e);}
      render();
    };
    node.onfocus=()=>{draft={kind:'section',node,dirty:false,failed:false};done=false;};
    node.oninput=()=>{if(draft?.node===node)draft.dirty=true;notify();};
    node.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault?.();finish(true);}else if(e.key==='Escape'){e.preventDefault?.();finish(false);}};
    node.onblur=()=>finish(true);
  }

  // ======================= public API =======================
  const api={
    getMode:()=>mode,getScope:()=>scope,getSnap:()=>snapping?autoSnap(zoom):'free',isSnapping:()=>snapping,getTool:()=>tool,
    // The rail and its note are shared with the lead sheet: take them back when the chart is shown again.
    showTools(){if(data&&dock.dataset?.owner!=='chart')renderTools();},
    // Kept for callers that think in views: asks for the tool that draws that view.
    setMode(next){const name={nav:'navigate',edit:'write',timing:'words'}[next];if(!name||next===mode)return mode;api.setTool(name);return mode;},
    setTool(next){
      if(!TOOL_NAMES.includes(next)||next===tool)return tool;
      if(blocked())return tool;
      const view=mode;tool=next;mode=MODE_OF[next];fixing.a=fixing.b=null;draft=null;keepPlace(render);
      if(mode!==view)handlers.onModeChange?.(mode);
      handlers.onToolChange?.(tool);return tool;
    },
    // Tool shortcuts (N W S J R T B) and Esc to put a tool down. Returns true when the key was used.
    handleKey(event){
      if(event.key==='Escape'){if(tool===DEFAULT_TOOL)return false;api.setTool(DEFAULT_TOOL);return true;}
      const name=TOOL_FOR_KEY[String(event.key||'').toUpperCase()];
      if(!name)return false;api.setTool(name);return true;
    },
    setScope(next){if(['occurrence','all-matching'].includes(next))scope=next;handlers.onScopeChange?.(scope);},
    // the magnet: on snaps to a grid that follows the zoom, off places words exactly where they are dropped
    setSnapping(on){snapping=!!on;if(mode==='timing')keepPlace(render);handlers.onTimingChange?.({snap:api.getSnap(),zoom});},
    getZoom:()=>zoom,
    // any zoom between the smallest and largest level: the bar under the desk zooms smoothly, Ctrl+wheel steps through the levels
    setZoom(next){const z=Number.isFinite(next)?Math.max(ZOOM_LEVELS[0],Math.min(ZOOM_LEVELS.at(-1),Math.round(next*100)/100)):zoom;if(z===zoom)return zoom;zoom=z;if(mode==='timing')keepPlace(render);handlers.onTimingChange?.({snap:api.getSnap(),zoom});return zoom;},
    zoomBy(direction){return api.setZoom(stepZoom(zoom,direction));},
    getProjection:()=>model?.projection||null,getModel:()=>model,
    getSelectedSeconds:()=>null,
    hasDraft:()=>!!draft?.dirty,hasPendingSave:()=>saving||!!draft?.dirty,canNavigate:()=>!blocked(),
    updatePlayback,
    update(value){
      const nextKey=JSON.stringify([value.documentId,value.revision,value.content,value.music,!!value.suggest,value.onsets?.length||0,value.onsets?.[0],value.melody?.length||0,value.key||null]);
      if(data?.documentId!==value.documentId){if(draft?.dirty)return;key=null;for(const k of Object.keys(targetPass))delete targetPass[k];for(const k of Object.keys(seekPass))delete seekPass[k];}
      data=value;
      if(nextKey!==key&&!draft&&!saving){key=nextKey;render();}else updatePlayback(value.transport);
    },
    dispose(){root.replaceChildren();},
  };
  return api;
}

// Where a new chord goes when you press "+": the beat nearest the middle of the chord's span, so the chord is split in two.
export function splitTime(chord,music){
  const measures=music?.measures||[],beats=measures.flatMap(m=>m.beats).filter(t=>t>chord.start+1e-6&&t<chord.end-1e-6);
  const mid=(chord.start+chord.end)/2;
  if(beats.length){let best=beats[0];for(const t of beats)if(Math.abs(t-mid)<Math.abs(best-mid))best=t;return best;}
  if(chord.end-chord.start>.5)return +(mid).toFixed(3);
  throw Error('This chord is too short to split. Make it longer first.');
}
