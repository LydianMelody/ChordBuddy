// The chart page. A click with no key held plays from there: any chord, word, bar number or section name. The keys you hold decide
// what else a click does, so the chart needs no tools:
//   Ctrl   edit what is written. The chords of a row (type them like words), its lyrics, a section name; the strip above a line to start
//          a new section at that bar, the strip above a section to join it to the one before; a barline to join two bars, a beat to
//          split a bar there.
//   Shift  the same chart drawn true to time while it is held (a quick tap keeps it, another tap puts it back). Drag a word or a chord to
//          another beat; Shift+click a bar number to fold a part that repeats, or a repeat count to regroup it.
// Every place that does something shows its own cursor and, after a moment's rest, a tooltip that says what it does.
// Playback decides which repeat pass is highlighted; the page itself never rearranges while it plays.
import {buildChartModel,playbackTarget} from './chart-model.js';
import {isNoChordLabel} from './chart-layout.js';
import {currentWordIndex} from './word-layout.js';
import {planChartChordEdit,planSectionEdit} from './practice-edit.js';
import {addressAtSeconds} from './musical-grid.js';
import {addChartChord,deleteChartChord,editChartChord,validateChart} from './editor.js';
import {spellChord} from './spelling.js';
import {applyCompactFold,applyCompactRange,compactRangeChoices,compactEditTargets,compactFoldChoices,compactJumpTargets,hasCompactPreferences,resetCompactPreferences} from './compact-chart.js';
import {planPageEdit} from './chart-edits.js';
import {copyTargets,copyGroup,copySectionLyrics} from './chart-copy.js';
import {applyRows} from './row-layout.js';
import {beatsLabel} from './bar-lengths.js';
import {createTiming} from './chart-timing.js';
import {DEFAULT_ZOOM,stepZoom,ZOOM_LEVELS,autoSnap} from './timing-geometry.js';
import {TOOL_ART,toolCursor} from './tool-icons.js';
import {detectFadeOut} from './fade-out.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const finite=Number.isFinite;
const pad2=n=>String(n).padStart(2,'0');
const clock=s=>finite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'';
export const CHORD_SUGGESTIONS=['C','Cm','C7','Cmaj7','D','Dm','D7','Dsus4','E','Em','E7','F','Fm','F#','F#m','G','G7','Gsus4','A','Am','A7','Asus4','B','Bm','Bb','Eb','Ab','Db','C/E','D/F#','G/B','Am7','Dm7','Em7','Bm7','Cadd9','N'];
const nameKey=name=>String(name||'').toLowerCase().replace(/[^a-z]/g,'');
const joinWords=tokens=>tokens.map((t,i)=>t.text+(i<tokens.length-1&&!t.text.endsWith('-')?' ':'')).join('');
const TAP_MS=300,SHIFT_DELAY=150;    // a Shift released this soon is a tap; the in-time view waits this long, so Shift+key shortcuts never flash it

// What each place on the chart does, for its tooltip (no keys: the key you are holding is why you are seeing it).
const ZONES={
  chords:{title:'Type the chords',art:'write',tip:'Type this row’s chords like words: A to G with # or b (Em7, F#m, Bb/D). Unchanged chords keep their timing; a new one splits the chord before it.'},
  words:{title:'Type the words',art:'write',tip:'Type this row’s lyrics. Words spread out between the ones you have pinned in time.'},
  name:{title:'Rename the section',art:'write',tip:'Type a new name for this section.'},
  split:{title:'Split the section',art:'cut',tip:'Start a new section at this bar. Nothing is lost, and joining puts them back together.'},
  join:{title:'Join sections',art:'glue',tip:'Glue this section onto the one above it.'},
  barline:{title:'Join two bars',art:'barlines',tip:'Remove this barline, so the bars on either side become one.'},
  beat:{title:'Split the bar',art:'barlines',tip:'Start a new bar on this beat.'},
  word:{title:'Move in time',art:'words',tip:'Drag the word onto a beat to pin it there. Words between pins spread out on their own.'},
  chord:{title:'Move in time',art:'words',tip:'Drag the chord to start on another beat. The chord before it holds on until then.'},
  fold:{title:'Fold a repeat',art:'repeat',tip:'Click the first and last bar of a part that repeats, then choose how it folds: 2 bars ×4, 4 bars ×2, or written out.'},
  regroup:{title:'Regroup the repeat',art:'repeat',tip:'Choose how this repeating part is grouped, or write it out in full.'},
};
function zone(node,name,keys){
  const z=ZONES[name];node.dataset.tipTitle=z.title;node.dataset.tip=z.tip;node.dataset.tipArt=TOOL_ART[z.art]||'';
  if(keys)node.dataset.tipKeys=keys;                                   // only while that key is held (tooltips.js)
  return node;
}

// A chord as it may be typed: a letter A to G, a sharp or flat, then anything (m7, sus4, /F#). N is a break in the music.
const CHORD=/^(N|[A-G](#|b)?[^\s]*)$/;
export function chordTokens(text){
  const tokens=String(text??'').replace(/♯/g,'#').replace(/♭/g,'b').trim().split(/\s+/).filter(Boolean);
  const bad=tokens.find(t=>!CHORD.test(t));
  if(bad)throw Error('“'+bad+'” is not a chord. Start each chord with a letter from A to G (with # or b after it), like Em7 or F#m.');
  return tokens;
}
// How the typed chords line up with the ones there were: unchanged chords keep their place, and what changed in between is retyped,
// removed or added. Returns [{type:'keep'|'replace'|'delete'|'insert', from (old index), to (new index)}] in order.
export function alignChords(before,after){
  const n=before.length,m=after.length,dp=Array.from({length:n+1},()=>new Array(m+1).fill(0));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=before[i]===after[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const ops=[];let i=0,j=0,dels=[],ins=[];
  const flush=()=>{const pair=Math.min(dels.length,ins.length);for(let k=0;k<pair;k++)ops.push({type:'replace',from:dels[k],to:ins[k]});
    for(const d of dels.slice(pair))ops.push({type:'delete',from:d});for(const a of ins.slice(pair))ops.push({type:'insert',to:a});dels=[];ins=[];};
  while(i<n||j<m){
    if(i<n&&j<m&&before[i]===after[j]){flush();ops.push({type:'keep',from:i,to:j});i++;j++;}
    else if(j<m&&(i===n||dp[i][j+1]>=dp[i+1][j]))ins.push(j++);
    else dels.push(i++);
  }
  flush();return ops;
}

export function mountChartPage(root,handlers={}){
  const fixing={a:null,b:null};                      // the bars picked with Shift+click on bar numbers (folding a repeat)
  let fixSel={ids:new Set()},foldGroup=null;
  let data=null,model=null,key=null,mode='nav',scope='occurrence',snapping=true,zoom=DEFAULT_ZOOM,draft=null,saving=false,last=null;
  let editing=null;                                  // the one row being typed into: {groupId, kind:'chords'|'words', focus}
  const held={ctrl:false,shift:false};let latched=false,shiftAt=0,shiftTap=false,shiftTimer=null;
  const targetPass={},seekPass={};let pendingName=null;
  let refs={chunks:[],groups:[],sections:[],lanes:[],words:[],chords:[],slots:[],editors:[],endings:[],repeats:[]},occById=new Map();
  // The note bar and the status line live outside the chart (the app hands in elements for them); on its own the page makes its own.
  const page=el('div','chart-flow'),notices=el('div','chart-notices'),message=el('p','chart-message'),dock=handlers.dock||el('div','tool-dock'),noteHost=handlers.note||el('div','tool-note'),statusHost=handlers.status||el('div','tool-status');message.setAttribute('role','status');
  root.replaceChildren(...(handlers.dock?[]:[dock]),...(handlers.note?[]:[noteHost]),...(handlers.status?[]:[statusHost]),notices,page);root.dataset.mode=mode;root.dataset.keys='';
  for(const name of Object.keys(TOOL_ART))root.style?.setProperty?.('--cur-'+name,toolCursor(name));
  root.style?.setProperty?.('--cur-glue-bars',toolCursor('glue',90));
  root.onwheel=e=>{
    if(mode!=='timing'||!e.ctrlKey)return;e.preventDefault?.();e.stopPropagation?.();     // the page's own zoom must not zoom as well
    if(handlers.onZoomWheel)handlers.onZoomWheel(e);else api.zoomBy(e.deltaY<0?1:-1);
  };
  const suggestions=el('datalist');suggestions.id='chord-list';for(const c of CHORD_SUGGESTIONS){const o=el('option');o.value=c;suggestions.append(o);}

  const timing=createTiming({
    getData:()=>data,getModel:()=>model,getSnap:()=>snapping?autoSnap(zoom):'free',getZoom:()=>zoom,get refs(){return refs;},
    editBars:handlers.onBarEdit?change=>Promise.resolve(handlers.onBarEdit(change)).catch(e=>fail(e)):null,commit:(candidate,label)=>commitPlain(candidate,label),fail:e=>fail(e),say:text=>{message.textContent=text;},blocked:()=>blocked(),rerender:()=>render(),
    seek:(seconds,g,pass)=>{if(g&&pass)seekPass[g.id]=pass;seek(seconds);},seekChunk:(g,chunk)=>seekChunk(g,chunk),moveChord:(g,chunk,address)=>moveChord(g,chunk,address),splitZone:(n,g,bar)=>barZones(n,g,bar,true),
    pickBar:(g,bar)=>pickBar(g,bar),picked:id=>fixSel.ids.has(id),regroup:g=>openFold(g),zone,dragEnded:()=>refreshView(),
  });
  const notify=()=>handlers.onDraftChange?.({draft:!!draft?.dirty,saving,failed:!!draft?.failed});
  const fail=e=>{message.textContent=e?.message||String(e);handlers.onError?.(e);};
  const context=()=>({documentId:data.documentId,revision:data.revision});

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

  // ======================= the keys you hold =======================
  // Ctrl and Shift are read from the keyboard (and from each click, in case a key went down while another window had focus).
  const typing=t=>!!t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||''));
  const active=()=>!!data&&(handlers.isActive?.()??true);
  function paintKeys(){root.dataset.keys=[held.ctrl&&'ctrl',held.shift&&'shift'].filter(Boolean).join(' ');paintLegend();}
  // The note above the chart ("Hold Ctrl for content editing tools and Shift for timing tools") lights up the tools in use: editing while
  // Ctrl is held or a row is being typed in, timing while Shift is held or the chart is shown in time.
  function paintLegend(){
    const legend=handlers.legend;if(!legend?.classList)return;
    legend.classList.toggle('editing',!!(held.ctrl||editing));legend.classList.toggle('timing',!!(held.shift||mode==='timing'));
  }
  function refreshView(){
    paintKeys();
    const wanted=latched||held.shift?'timing':'nav';
    if(wanted===mode||timing.isDragging()||draft?.dirty||saving||editing)return;
    mode=wanted;foldGroup=null;keepPlace(render);handlers.onModeChange?.(mode);
  }
  function keyDown(e){
    if(!active())return;
    if(e.key==='Control'){if(!held.ctrl){held.ctrl=true;paintKeys();}return;}
    if(e.key==='Shift'){
      if(e.repeat||typing(e.target))return;
      shiftAt=Date.now();shiftTap=!e.ctrlKey&&!e.altKey&&!e.metaKey;clearTimeout(shiftTimer);
      shiftTimer=setTimeout(()=>{shiftTimer=null;held.shift=true;refreshView();},SHIFT_DELAY);
      return;
    }
    shiftTap=false;                                                   // Shift+something: a shortcut, not the in-time view
    if(shiftTimer){clearTimeout(shiftTimer);shiftTimer=null;}
  }
  function keyUp(e){
    if(e.key==='Control'){held.ctrl=false;paintKeys();return;}
    if(e.key!=='Shift')return;
    if(shiftTimer){clearTimeout(shiftTimer);shiftTimer=null;}
    if(shiftTap&&Date.now()-shiftAt<TAP_MS&&active()&&!typing(e.target))latched=!latched;
    shiftTap=false;held.shift=false;refreshView();
  }
  function allUp(){held.ctrl=held.shift=false;shiftTap=false;if(shiftTimer){clearTimeout(shiftTimer);shiftTimer=null;}refreshView();}
  const doc=root.ownerDocument||(typeof document!=='undefined'?document:null);
  const onPointer=e=>{shiftTap=false;if(!!e.ctrlKey!==held.ctrl){held.ctrl=!!e.ctrlKey;paintKeys();}};
  doc?.addEventListener?.('keydown',keyDown,true);doc?.addEventListener?.('keyup',keyUp,true);doc?.addEventListener?.('pointerdown',onPointer,true);
  if(typeof window!=='undefined')window.addEventListener?.('blur',allUp);

  // ======================= rendering =======================
  // A break where the band stops (an N chord inside the song) is drawn as rest symbols for its length: a quarter rest for one beat
  // of 4/4, a whole rest for a whole bar. A length that is not a sum of a few plain rests shows only its space, as before.
  const RESTS=[[4,'\u{1D13B}','whole'],[2,'\u{1D13C}','half'],[1,'\u{1D13D}','quarter'],[.5,'\u{1D13E}','eighth'],[.25,'\u{1D13F}','sixteenth']];
  function restSymbols(chunk,bar){
    const m=bar.measure,n=m?.beats?.length;if(!n||!(m.end>m.start)||!(chunk.end>chunk.start))return null;
    const beats=(chunk.end-chunk.start)/((m.end-m.start)/n);
    if(beats>=n-.1)return {glyphs:RESTS[0][1],name:'Rest for the whole bar'};
    let quarters=beats*4/(m.meter?.[1]||4);const glyphs=[],names=[];
    for(const [size,glyph,name] of RESTS){while(quarters>=size-.08&&glyphs.length<3){glyphs.push(glyph);names.push(name);quarters-=size;}}
    if(!glyphs.length||Math.abs(quarters)>.08)return null;
    return {glyphs:glyphs.join(''),name:'Rest: '+names.join(' + ')+(names.length>1?' rests':' rest')};
  }
  // no chord (a break in the music) is simply a gap
  function chordLabel(chunk){if(isNoChordLabel(chunk.label))return '';const shown=spellChord(chunk.label);return chunk.continued?'('+shown+')':shown;}
  function renderChord(g,bar,chunk){
    const holder=el('span','chord-line'),b=el('button','chord'+(isNoChordLabel(chunk.label)?' rest':''),chordLabel(chunk));b.type='button';b.dataset.chunk=chunk.key;
    if(isNoChordLabel(chunk.label)){const r=restSymbols(chunk,bar);if(r){b.append(el('span','rest-glyph',r.glyphs));b.setAttribute('aria-label',r.name);b.title=r.name;}}
    zone(b,'chords','ctrl');
    b.onclick=e=>{if(e?.ctrlKey)startChords(g);else seekChunk(g,chunk);};
    holder.append(b);
    if(chunk.repeat>1){const r=el('span','repeat','(×'+chunk.repeat+')');r.title='Played '+chunk.repeat+' times';holder.append(r);refs.repeats.push({node:r,chunk,group:g,text:r.textContent});}
    refs.chords.push({node:b,chunk,group:g});return holder;
  }
  function renderLaneSlot(g,bar,chunk,lane,laneIndex,first){
    const tokens=chunk.lanes[laneIndex]||[],holder=el('span','lane'),slot=zone(el('span','lyr'),'words','ctrl');slot.dataset.lane=String(laneIndex);slot.dataset.pass=String(lane.passNumber);
    if(first&&g.passCount>1){
      const tag=el('span','lane-tag',String(lane.passNumber));tag.title='Pass '+lane.passNumber;
      tag.onclick=e=>{e?.stopPropagation?.();seekPass[g.id]=lane.passNumber;};
      refs.lanes.push({tag,group:g,lane});holder.append(tag);
    }
    slot.onclick=e=>{if(e?.ctrlKey){e.stopPropagation?.();startWords(g,lane.passNumber);}};
    holder.append(slot);refs.slots.push({node:slot,group:g,lane});
    tokens.forEach((t,i)=>{
      const w=el('span','w',t.text+(i<tokens.length-1&&!t.text.endsWith('-')?' ':''));
      w.dataset.line=String(t.line);w.dataset.offset=String(t.offset);
      w.onclick=e=>{if(e?.ctrlKey)return;if(finite(t.seconds)){seekPass[g.id]=t.passNumber;seek(t.seconds);}};
      refs.words.push({node:w,token:t,group:g,lane});slot.append(w);
    });
    return holder;
  }
  function renderChunk(g,bar,chunk,edit){
    const node=el('span','chunk'),cell={node,group:g,chunk};node.dataset.chunk=chunk.key;
    node.append(renderChord(g,bar,chunk));
    if(edit?.kind!=='words')g.lanes.forEach((lane,i)=>node.append(renderLaneSlot(g,bar,chunk,lane,i,bar===g.bars[0]&&chunk===bar.chunks[0])));
    refs.chunks.push(cell);return node;
  }
  // Ctrl's places on a bar: the strip above it starts a new section there, its barline joins it to the bar before, a beat splits it.
  function barZones(n,g,bar,splitOnly=false){
    if(canCut(bar.start)){
      const strip=zone(el('button','zone-split'),'split');strip.type='button';strip.tabIndex=-1;strip.setAttribute('aria-label','Start a new section at bar '+bar.number);
      strip.onclick=e=>{e?.stopPropagation?.();splitAt(bar.start);};n.append(strip);
    }
    if(splitOnly)return;
    const measures=model.measures,at=bar.measure&&bar.mapped?measures.findIndex(m=>m.id===bar.measure.id):-1;
    if(!handlers.onBarEdit||at<0)return;
    const measure=bar.measure,beats=measure.beats?.length||0;
    if(at>0){
      const line=zone(el('button','zone-barline'),'barline');line.type='button';line.tabIndex=-1;line.setAttribute('aria-label','Join bar '+bar.number+' with the bar before it');
      line.onclick=e=>{e?.stopPropagation?.();if(!blocked())handlers.onBarEdit({removeBars:[measure.start]});};n.append(line);
    }
    for(let j=1;j<beats;j++){
      const tick=zone(el('button','zone-beat'),'beat');tick.type='button';tick.tabIndex=-1;tick.style.left=(j/beats*100)+'%';tick.setAttribute('aria-label','Start a new bar on beat '+(j+1)+' of bar '+bar.number);
      tick.onclick=e=>{e?.stopPropagation?.();if(!blocked())handlers.onBarEdit({addBars:[measure.beats[j]]});};n.append(tick);
    }
  }
  function renderBar(g,bar,index,edit){
    const n=el('div','bar'+(index===g.bars.length-1?' last':''));n.dataset.bar=bar.id;
    const no=el('span','bar-no',String(bar.number));no.title='Jump to bar '+bar.number;
    no.onclick=e=>{if(e?.ctrlKey)return;const o=g.bars&&occurrenceFor(g.id,bar.chunks[0]?.slotId,passForSeek(g));seek(o?.start??bar.start);};
    n.append(no);
    // A bar that is shorter or longer than the usual one says so, informally; a real change of meter keeps its signature.
    if(bar.odd)n.append(el('span','bar-meter odd',beatsLabel(bar.beatCount)));
    else if(bar.meterChange&&bar.meter)n.append(el('span','bar-meter',bar.meter.join('/')));
    if(!edit)barZones(n,g,bar);
    for(const chunk of bar.chunks)n.append(renderChunk(g,bar,chunk,edit));
    if(!bar.chunks.length&&edit?.kind!=='words')for(const [i,lane] of g.lanes.entries())n.append(renderLaneSlot(g,bar,{key:null,slotId:null,lanes:{}},lane,i,false));
    return n;
  }
  // A repeat sign is drawn from plain shapes (a rule and two dots), not gradients: gradients turn into grey blocks in a PDF.
  function repeatSign(side){const sign=el('span','rep-sign '+side);sign.append(el('i','rep-dot a'),el('i','rep-dot b'));return sign;}
  function renderGroup(section,g){
    if(mode==='timing')return timing.renderGroup(section,g);
    const edit=editing?.groupId===g.id?editing:null;
    const row=el('div','row'+(g.lanes.length?' has-lyrics':'')+(edit?' editing':'')),bars=el('div','bars');row.dataset.group=g.id;
    g.model=g;refs.groups.push({node:row,model:g});
    if(edit&&g.passCount>1){
      const pick=el('span','pass-pick');pick.title='Which pass your chord changes apply to';
      for(let p=1;p<=g.passCount;p++){const s=el('button','',String(p));s.type='button';s.dataset.pass=String(p);s.onclick=()=>{targetPass[g.id]=p;paintTargets();};pick.append(s);}
      refs.lanes.push({pick,group:g});row.append(pick);
    }
    if(edit?.kind==='chords')row.append(renderChordEditor(g,row));
    g.bars.forEach((bar,i)=>{
      const node=renderBar(g,bar,i,edit);
      // a repeated progression starts and ends with repeat signs (the count stays after the last chord)
      if(g.repeat>1){if(i===0){node.classList.add('rep-start');node.append(repeatSign('start'));}if(i===g.bars.length-1){node.classList.add('rep-end');node.append(repeatSign('end'));}}
      bars.append(node);
    });
    // lyric lines that were never placed on the chart: plain text with a way to put them on this row
    if(edit?.kind!=='words')for(const lane of g.lanes.filter(l=>l.flow)){
      const flow=el('div','flow-line'),text=el('span','flow-text',lane.tokens.map(t=>t.text).join(' ')||lane.text);
      flow.append(text);
      if(lane.tokens.length){const place=el('button','add-lyrics','Place on this row');place.type='button';place.onclick=()=>placeFlowLine(g,lane);flow.append(place);}
      bars.append(flow);
    }
    row.append(bars);
    if(edit?.kind==='words')row.append(renderLaneEditors(g,row));
    else if(!g.lanes.some(l=>!l.flow)){
      // a row with no words yet: Ctrl shows a line to type them on
      const add=zone(el('div','lane-add',g.passCount>1?'Click and type the words for pass '+passForEdit(g):'Click and type the words'),'words');
      add.onclick=e=>{e?.stopPropagation?.();startWords(g,passForEdit(g));};row.append(add);
    }
    if(g.endings.length){
      const alts=el('div','alt-endings');
      for(const e of g.endings.filter(e=>!e.passNumbers.includes(1))){
        const item=el('div','alt-ending');item.append(el('span','ending-label',(e.passNumbers.length===1?'Ending ':'Endings ')+e.passNumbers.join(', ')),el('span','bar-no',String(e.measureNumber)));
        for(const o of e.chords){const rest=isNoChordLabel(o.label);const b=el('button','chord ending-chord'+(rest?' rest':''),rest?'':o.label);b.type='button';b.dataset.occurrence=o.id;b.onclick=ev=>{if(ev?.ctrlKey){targetPass[g.id]=o.passNumber;startChords(g);}else seek(o.start);};refs.endings.push({node:b,occurrence:o});item.append(b);}
        alts.append(item);
      }
      if(alts.children.length)row.append(alts);
    }
    return row;
  }

  // ======================= the note bar and the status line =======================
  // The chart keeps no tools of its own: the rail beside it is left empty (the lead sheet and the MIDI view still use it).
  function renderTools(){
    if(dock.dataset?.owner!=='chart'){dock.dataset.owner='chart';dock.replaceChildren();}
    const controls=el('div','tool-controls'),lines=[];
    if(fixing.a)fillRepeatHint(controls,lines);
    else if(foldGroup)fillFoldChoices(controls,lines);
    statusHost.replaceChildren(...(lines.length?[el('span','status-hint',lines.join(' · '))]:[]));
    if(fixing.a||foldGroup||latched){
      const back=el('button','tool-put-down');back.type='button';back.innerHTML='<kbd>Esc</kbd> '+(fixing.a||foldGroup?'cancel':'back to the chart as written');back.onclick=()=>api.handleKey({key:'Escape'});statusHost.append(back);
    }
    statusHost.append(message);
    noteHost.replaceChildren(...(controls.children.length?[controls]:[]));
  }

  // ---------------- Fold repeats by hand (Shift+click bar numbers) ----------------
  const barNumber=id=>{const m=model.measures.find(m=>m.id===id);return m?m.number-model.barOffset:'?';};
  const measureIndex=id=>model.measures.findIndex(m=>m.id===id);
  function pickBar(g,bar){
    const src=model.projection.groups.find(x=>x.id===g.id),folded=src?.folded&&src.passes?.length>1;
    const pick=folded?{start:src.passes[0].measureIds[0],end:src.passes.at(-1).measureIds.at(-1)}:{start:bar.id,end:bar.id};
    if(!pick.start||!pick.end)return;
    foldGroup=null;
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
    if(!range)return none;
    try{const info=compactRangeChoices(data.content,data.music,range.from,range.to);return {ids:new Set(info.measureIds||[range.from]),info,range};}catch{return none;}
  }
  // The steps go in the status line (`lines`), the choices and links in the bar above it (`controls`).
  function fillRepeatHint(controls,lines){
    const sel=fixSel;
    if(!fixing.b)lines.push('Bar '+barNumber(fixing.a.start)+' picked. Shift+click the last bar to take in more, or choose above');
    if(sel.info){
      const info=sel.info;
      if(info?.measureIds){
        lines.push(info.length===1?'Bar '+barNumber(info.measureIds[0]):'Bars '+barNumber(info.measureIds[0])+'–'+barNumber(info.measureIds.at(-1))+' ('+info.length+' bars)');
        if(info.problem)lines.push(info.problem);
        for(const choice of info.choices||[]){
          const b=el('button','fix-choice'+(choice.expanded?' plain':''),choice.label);b.type='button';
          b.onclick=()=>{try{const next=applyCompactRange(data.content,data.music,model.projection,sel.range.from,sel.range.to,choice);fixing.a=fixing.b=null;commitPlain(next,choice.expanded?'Unfold repeat':'Fold repeat');}catch(e){fail(e);}};
          controls.append(b);
        }
      }else if(info?.problem)lines.push(info.problem);
    }
    const again=el('button','fix-link','Start over');again.type='button';again.onclick=()=>{fixing.a=fixing.b=null;keepPlace(()=>render());};controls.append(again);
    if(hasCompactPreferences(data.content)){const reset=el('button','fix-link','Reset all my repeat choices');reset.type='button';reset.onclick=()=>{fixing.a=fixing.b=null;commitPlain(resetCompactPreferences(data.content),'Reset repeat grouping');};controls.append(reset);}
  }
  // Shift+click a repeat count: how that repeating part is grouped (2 bars x4, 4 bars x2, or written out).
  function openFold(g){fixing.a=fixing.b=null;foldGroup=g.id;renderTools();}
  function fillFoldChoices(controls,lines){
    const source=model.projection.groups.find(x=>x.id===foldGroup),choices=source?compactFoldChoices(model.projection,source):[];
    if(choices.length<2){lines.push('This repeat can only be grouped one way.');return;}
    lines.push('Choose how this repeating part is grouped');
    for(const choice of choices){
      const b=el('button','fix-choice'+(choice.current?' plain':''),choice.label);b.type='button';b.disabled=choice.current;
      b.onclick=()=>{try{foldGroup=null;commitPlain(applyCompactFold(data.content,data.music,model.projection,source,choice),'Change repeat grouping');}catch(e){fail(e);}};
      controls.append(b);
    }
  }
  // Redrawing (a new view, zoom, a saved edit) keeps the row nearest the top of the view exactly where it was.
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
  // While the page is rebuilt, the line being typed in is removed and the browser reports it as left: that is not the player leaving it.
  let drawing=false;
  function render(){drawing=true;try{keepPlace(draw);}finally{drawing=false;}paintLegend();}
  function draw(){
    if(!data)return;
    model=buildChartModel(data.content,data.music,{onsets:data.suggest?data.onsets:null});
    refs={chunks:[],groups:[],sections:[],lanes:[],words:[],chords:[],slots:[],editors:[],endings:[],repeats:[]};
    occById=new Map(model.projection.occurrences.map(o=>[o.id,o]));
    notices.replaceChildren();for(const w of model.warnings)notices.append(el('p','chart-notice',w));
    fixSel=fixing.a?fixSelection():{ids:new Set()};
    cutTimes=cutPoints();
    renderTools();
    page.replaceChildren();
    for(const section of model.sections){
      const sec=el('section','sec');sec.dataset.section=section.id;sec.dataset.name=nameKey(section.name);
      if(refs.sections.length>0){
        // Ctrl: the strip above a section glues it onto the one before
        const join=zone(el('button','zone-join'),'join');join.type='button';join.tabIndex=-1;join.setAttribute('aria-label','Join '+section.name+' with the section above');
        join.onclick=e=>{e?.stopPropagation?.();joinWithPrevious(section);};sec.append(join);
      }
      const head=el('header','sec-head'),num=el('span','sec-num',pad2(section.number)),name=zone(el('h3','sec-name',section.name),'name','ctrl'),time=el('span','sec-time',clock(section.start));
      head.append(num,name,time);
      head.onclick=e=>{if(e?.ctrlKey){if(e.target===name||name.contains?.(e.target))renameSection(name,section);return;}seek(section.start);};
      name.onclick=e=>{if(e?.ctrlKey){e.stopPropagation?.();renameSection(name,section);}};
      copyButtons(head,section);
      sec.append(head);refs.sections.push({node:sec,section});
      // Short rows share a line: a one-bar repeat and its neighbours sit side by side while together they fit in a line's worth of bars
      // (bars-per-line). Rows with lyrics keep a line of their own, and the in-time view draws every row on its own.
      const perLine=Math.max(1,data.content?.layout?.bars_per_line||4);let pack=null,packBars=0;
      for(const g of section.groups){
        const row=renderGroup(section,g),count=g.bars?.length||1;
        if(mode==='timing'||editing?.groupId===g.id){pack=null;packBars=0;sec.append(row);continue;}
        // a row with lyrics keeps a line of its own (its words need the width) but still uses the same slots, so its barlines line up too
        const lyrics=!!g.lanes?.length;
        if(lyrics||!pack||packBars+count>perLine){pack=el('div','row-pack');sec.append(pack);packBars=0;}
        // every bar gets an equal share of a line, so barlines (and the end of every full line) line up from row to row
        row.dataset.slots=String(Math.min(perLine,count));row.classList.add('slotted');
        pack.append(row);packBars+=lyrics?perLine:count;
      }
      page.append(sec);
    }
    const fade=fadeOut(),finalSection=refs.sections.at(-1)?.node;
    if(fade&&finalSection)finalSection.append(fadeNote(fade));
    page.append(suggestions);
    layoutRows();
    if(pendingName){const node=page.querySelector?.('[data-section="'+pendingName+'"] .sec-name');const section=model.sections.find(s=>s.id===pendingName);pendingName=null;if(node&&section)renameSection(node,section);}
    root.dataset.mode=mode;last=null;paintTargets();updatePlayback(data.transport);positionEditors();
    const focus=editing&&refs.editors.find(r=>r.id===editing.focus)||refs.editors[0];
    // a chord line is selected whole (to retype); a line of words gets the cursor at its end, ready to go on typing
    if(editing&&focus){focus.node.focus?.();const sel=globalThis.getSelection?.();sel?.selectAllChildren?.(focus.node);if(editing.kind!=='chords')sel?.collapseToEnd?.();}
  }

  // A recording that fades out says so after its last bar, and where the fade begins; a click plays from there.
  function fadeOut(){
    const w=data.waveform;if(!w?.peaks)return null;
    return detectFadeOut(w.peaks,w.duration,model.measures.flatMap(m=>m.beats||[]));
  }
  function fadeNote(fade){
    const m=model.measures.find(m=>fade.start>=m.start&&fade.start<m.end),bar=m?m.number-model.barOffset:null;
    const note=el('button','fade-note');note.type='button';note.dataset.tipTitle='The recording fades out';
    note.dataset.tip='The music keeps going but gets quieter until the recording ends. Click to play from where the fade begins.';
    note.append(el('span','fade-mark','↘'),el('b','','Fade out'),...(bar!==null&&bar>0?[el('small','','from bar '+bar)]:[]));
    note.onclick=e=>{if(e?.ctrlKey||e?.shiftKey)return;seek(fade.start);};
    return note;
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
      if(r.tag){r.tag.classList.toggle('target',!!editing&&passForEdit(r.group)===r.lane.passNumber);}
      if(r.pick)for(const b of r.pick.children)b.classList.toggle('on',passForEdit(r.group)===Number(b.dataset.pass));
    }
  }
  // A thin line where the music is, in every mode (reading, typing a row, timing), paused too. Reading, it moves across the chord that is
  // playing; in timing, whose bars are drawn to time, across the bar's beats. A repeated row shows it in the pass being played.
  let playMark=null,markIn=null;
  const findBar=(node,id)=>{if(node?.dataset?.bar===id)return node;for(const child of node?.children||[]){const hit=findBar(child,id);if(hit)return hit;}return null;};
  function paintPlayMark(seconds,target,occ){
    const row=target&&refs.groups.find(r=>r.model.id===target.groupId),g=row?.model;
    const measure=occ&&model.measures.find(m=>m.id===occ.measureId),pass=g?.passes?.find(p=>p.number===target.passNumber);
    const index=measure&&pass?pass.measureIds.indexOf(measure.id):-1,barId=index>=0?g.bars?.[index]?.id:null;
    const bar=barId?findBar(row.node,barId):null;
    if(!bar){playMark?.remove?.();markIn=null;return;}
    if(!playMark){playMark=el('i','playmark');playMark.setAttribute?.('aria-hidden','true');}
    if(markIn!==bar||!(bar.children&&[...bar.children].includes(playMark))){bar.append(playMark);markIn=bar;}
    const chunk=mode==='timing'?null:refs.chunks.find(r=>r.chunk.key===target.chunkKey&&[...(bar.children||[])].includes(r.node))?.node;
    if(chunk&&occ.end>occ.start&&finite(chunk.offsetLeft)&&chunk.offsetWidth){
      const part=Math.max(0,Math.min(1,(seconds-occ.start)/(occ.end-occ.start)));
      playMark.style.left=Math.round(chunk.offsetLeft+part*chunk.offsetWidth)+'px';return;
    }
    const beats=[...(measure.beats?.length?measure.beats:[measure.start]),measure.end];let beat=0;
    for(let i=0;i<beats.length-1;i++)if(seconds<beats[i+1]){beat=i+Math.max(0,(seconds-beats[i])/((beats[i+1]-beats[i])||1));break;}
    playMark.style.left=(Math.min(1,beat/(beats.length-1))*100)+'%';
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
    paintRepeatCount(target,transport);paintPlayMark(seconds,target,occ);
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
    if(changedTarget&&mode==='nav'&&!editing&&transport.playing&&target)followPlayback(target);
  }
  // While a repeated part plays, its (×8) lights up and counts down the passes still to come, down to ×1!! on the last one, and gives a
  // small bump on every beat. Paused, or anywhere else, it is the plain (×8) again.
  function paintRepeatCount(target,transport){
    if(!refs.repeats.length)return;
    const seconds=transport.seconds,playing=!!transport.playing;
    let beat=null;
    if(playing){
      const m=model.measures.find(m=>seconds>=m.start&&seconds<m.end);
      if(m){const points=[...m.beats,m.end];let i=0;while(i<points.length-2&&points[i+1]<=seconds)i++;beat={key:m.id+':'+i,length:Math.max(.08,points[i+1]-points[i])};}
    }
    for(const r of refs.repeats){
      const live=playing&&target?.groupId===r.group.id,left=live?Math.max(1,r.chunk.repeat-(target.passNumber||1)+1):0;
      const text=live?'×'+left+(left===1?'!!':''):'(×'+r.chunk.repeat+')';
      if(r.text!==text){r.text=text;r.node.textContent=text;}
      r.node.classList.toggle('live',live);r.node.classList.toggle('last',live&&left===1);
      if(live&&beat&&r.beat!==beat.key){
        r.beat=beat.key;r.node.style?.setProperty?.('--beat-len',beat.length.toFixed(3)+'s');
        r.node.dataset.beat=r.node.dataset.beat==='a'?'b':'a';                 // a fresh animation name restarts the bump on the beat
      }else if(!live&&r.beat){r.beat=null;delete r.node.dataset.beat;}
    }
  }
  // Keep the playing row on screen while playing, without fighting the reader.
  function followPlayback(target){
    const row=refs.groups.find(r=>r.model.id===target.groupId)?.node;if(!row?.getBoundingClientRect)return;
    const desk=root.closest?.('.desk')||root.parentElement;const box=desk?.getBoundingClientRect?.(),r=row.getBoundingClientRect();
    if(!box||desk.scrollHeight<=desk.clientHeight)return;
    if(r.top<box.top+box.height*.12||r.bottom>box.top+box.height*.8)row.scrollIntoView?.({block:'center',behavior:'smooth'});
  }
  function seekChunk(g,chunk){
    const pass=passForSeek(g),targets=compactJumpTargets(model.projection,{groupId:g.id,slotId:chunk.slotId}),target=targets.find(t=>t.passNumber===pass)||targets[0];
    seekPass[g.id]=pass;seek(target?.seconds??chunk.start);
  }

  // ======================= saving =======================
  async function commitPlain(candidate,label){
    if(saving)return false;saving=true;notify();
    try{await handlers.onCommit?.(candidate,label,context());message.textContent='';return true;}
    catch(e){fail(e);return false;}
    finally{saving=false;notify();}
  }
  function canEdit(){
    if(handlers.canEdit?.()===false){message.textContent='Wait for the save, or reload the chart before editing again.';return false;}
    return true;
  }
  function stopEditing(){editing=null;draft=null;render();notify();refreshView();}

  // ======================= Ctrl: the chords of a row, typed like words =======================
  // One chord per item, in order: a chord held over a barline is written once (its later bars show it in brackets).
  function rowChords(g){
    const seen=new Set(),items=[];
    for(const bar of g.bars)for(const chunk of bar.chunks){
      if(!chunk.chordId||chunk.continued||seen.has(chunk.key))continue;seen.add(chunk.key);
      items.push({chunk,text:isNoChordLabel(chunk.label)?'N':spellChord(chunk.label)});
    }
    return items;
  }
  function startChords(g){
    if(blocked()||!canEdit())return;
    if(!rowChords(g).length){message.textContent='This row has no chords to type over.';return;}
    editing={groupId:g.id,kind:'chords',focus:g.id+'|chords'};foldGroup=null;keepPlace(render);
  }
  function renderChordEditor(g,row){
    const items=rowChords(g),text=items.map(i=>i.text).join(' '),line=el('div','lane-edit chord-edit'),editor=el('span','lyr chord-type');
    editor.contentEditable='plaintext-only';editor.spellcheck=false;editor.dataset.placeholder='Type the chords: E A B E';
    editor.append(document.createTextNode?document.createTextNode(text):text);
    const ref={id:g.id+'|chords',group:g,node:editor,line,row,original:text,anchorKey:null};refs.editors.push(ref);
    let done=false;
    const finish=async save=>{
      if(done)return;done=true;const raw=editor.textContent;
      if(!save||raw.replace(/\s+/g,' ').trim()===text){stopEditing();return;}
      try{
        const next=planChordLine(g,items,chordTokens(raw));
        draft=null;editing=null;render();                             // the row closes at once; the save follows
        if(next)await commitPlain(next,'Edit chords');
      }catch(e){fail(e);}
      stopEditing();
    };
    editor.onfocus=()=>{draft={kind:'chords',node:editor,dirty:false,failed:false};notify();};
    editor.oninput=()=>{if(draft?.node!==editor)draft={kind:'chords',node:editor,dirty:false,failed:false};draft.dirty=editor.textContent.trim()!==text;notify();};
    editor.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault?.();finish(true);}else if(e.key==='Escape'){e.preventDefault?.();finish(false);}};
    editor.onblur=()=>finish(true);
    line.append(editor);return line;
  }
  // The new chord line as one edit: the chords that are the same keep their timing, a retyped one keeps its place, a removed one hands
  // its time to its neighbour, and a new one splits the chord before it on the beat nearest its middle. With "All matching" every pass
  // of a repeated row gets the same change.
  function planChordLine(g,items,tokens){
    const ops=alignChords(items.map(i=>i.text),tokens);
    if(ops.every(o=>o.type==='keep'))return null;
    const ids=items.map(({chunk})=>{
      const occ=occurrenceFor(g.id,chunk.slotId,passForEdit(g))||chunk.occurrence;
      return scope==='all-matching'?compactEditTargets(model.projection,{groupId:g.id,slotId:chunk.slotId,passNumber:occ.passNumber,scope}).chordIds:[occ.chordId];
    });
    let next=structuredClone(data.content),after=null;
    const chordOf=id=>next.chords.find(c=>c.id===id);
    const splitAfter=(list,label)=>list.map(id=>{const c=chordOf(id),fresh=crypto.randomUUID();next=addChartChord(next,splitTime(c,data.music),fresh,label);return fresh;});
    for(const op of ops){
      const label=op.to!==undefined?tokens[op.to]:null;
      if(op.type==='keep')after=ids[op.from];
      else if(op.type==='replace'){for(const id of ids[op.from])next=editChartChord(next,id,{label});after=ids[op.from];}
      else if(op.type==='delete'){for(const id of ids[op.from])next=deleteChartChord(next,id);}
      else if(after)after=splitAfter(after,label);
      else{
        // before the row's first chord: that chord is split, the new chord takes its first half and it keeps the second
        const first=ops.find(o=>o.from!==undefined&&o.type!=='delete');if(!first)throw Error('Keep at least one of this row’s chords, or retype them, so new chords have a place.');
        const old=ids[first.from],moved=old.map(id=>chordOf(id).label);
        const second=old.map((id,k)=>{const c=chordOf(id),fresh=crypto.randomUUID();next=addChartChord(next,splitTime(c,data.music),fresh,moved[k]);return fresh;});
        for(const id of old)next=editChartChord(next,id,{label});
        ids[first.from]=second;after=old;
      }
    }
    const error=validateChart(next);if(error)throw Error(error);
    return next;
  }

  // ======================= Shift: move a chord in time =======================
  async function moveChord(g,chunk,address){
    if(blocked())return;
    try{
      const occ=chunk.occurrence;                              // the in-time view draws a repeated row's first pass
      const result=planChartChordEdit(data.content,data.music,{chordId:occ.chordId,label:data.content.chords.find(c=>c.id===occ.chordId)?.label??chunk.label,startAddress:address,scope,
        selection:{groupId:g.id,slotId:chunk.slotId,passNumber:occ.passNumber,chordId:occ.chordId},view:model.projection});
      if(result.conflicts.length){fail(Error(result.conflicts[0].message));render();return;}
      await commitPlain(result.candidate,'Move chord');
    }catch(e){fail(e);render();}
  }

  // ======================= Ctrl: the words of a row, one line per pass =======================
  // Each pass of a row has one editable line under it. It is separate from the chords, so typing never moves them; the words are
  // spread between whatever pins exist when you leave the line. A new line starts at the chord you click and ends with the row.
  function laneItems(g){
    const items=g.lanes.map(lane=>({group:g,lane,passNumber:lane.passNumber,id:g.id+'|'+lane.line}));
    const have=new Set(g.lanes.filter(l=>!l.flow).map(l=>l.passNumber));
    const wanted=g.passCount>1?g.passes.map(p=>p.number).filter(n=>!have.has(n)):(g.lanes.length?[]:[1]);
    for(const n of wanted)items.push({group:g,lane:null,passNumber:n,id:g.id+'|new'+n});
    return items.sort((a,b)=>a.passNumber-b.passNumber);
  }
  function startWords(g,passNumber){
    if(blocked()||!canEdit())return;
    const items=laneItems(g),item=items.find(i=>i.passNumber===passNumber&&i.lane&&!i.lane.flow)||items.find(i=>i.passNumber===passNumber)||items[0];
    editing={groupId:g.id,kind:'words',focus:item?.id};foldGroup=null;keepPlace(render);
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
      editor.contentEditable='plaintext-only';
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
      if(!ref.anchorKey){ref.line.style?.setProperty?.('--start','0px');continue;}
      const chunk=refs.chunks.find(c=>c.chunk.key===ref.anchorKey)?.node,rowBox=ref.row.getBoundingClientRect?.(),box=chunk?.getBoundingClientRect?.();
      const x=rowBox&&box?Math.max(0,box.left-rowBox.left):0;
      ref.line.style?.setProperty?.('--start',x+'px');
    }
  }
  // A row's lines of words are typed freely: Tab and Enter only move between its passes (nothing is saved or redrawn while typing),
  // and every changed line is saved together, as one edit, when the row is left. Esc leaves it and drops the changes.
  // a line of words takes the keyboard with the cursor at its end, ready to go on typing
  function focusEnd(node){if(!node)return;node.focus?.();const sel=globalThis.getSelection?.();sel?.selectAllChildren?.(node);sel?.collapseToEnd?.();}
  let typingIn=null,closing=false;                      // the line that has the keyboard; a row being closed (saved)
  const rowLines=g=>refs.editors.filter(r=>r.group===g);
  const changed=ref=>ref.node.textContent.replace(/\s+/g,' ').trim()!==ref.original.trim();
  function wireLane(ref){
    const editor=ref.node;
    editor.onfocus=()=>{typingIn=ref;editing={...editing,focus:ref.id};draft={kind:'lyric',node:editor,dirty:rowLines(ref.group).some(changed),failed:false};notify();};
    editor.oninput=()=>{if(draft)draft.dirty=rowLines(ref.group).some(changed);notify();};
    editor.onmousedown=e=>{
      // a new line begins at the chord nearest the click
      if(ref.lane||ref.node.textContent||!finite(e?.clientX))return;
      const mine=refs.chunks.filter(c=>c.group===ref.group&&c.node.getBoundingClientRect);
      let best=null,gap=Infinity;for(const c of mine){const d=Math.abs(c.node.getBoundingClientRect().left-e.clientX);if(d<gap){gap=d;best=c;}}
      if(best){ref.anchorKey=best.chunk.key;positionEditors();}
    };
    editor.onkeydown=e=>{
      // Enter or Tab: the next pass's line (Enter on the last line saves the row and closes it); Shift+Tab: the line before
      if(e.key==='Enter'||e.key==='Tab'){
        e.preventDefault?.();
        const mine=rowLines(ref.group),next=mine[mine.indexOf(ref)+(e.key==='Tab'&&e.shiftKey?-1:1)];
        if(next)focusEnd(next.node);else if(e.key==='Enter')closeRow(ref.group,true);
      }else if(e.key==='Escape'){e.preventDefault?.();closeRow(ref.group,false);}
    };
    // Leaving the row (a click anywhere else) saves it; moving to another of its lines does not. A line removed by a redraw is not left.
    editor.onblur=()=>{
      if(typingIn===ref)typingIn=null;
      if(drawing||closing)return;
      setTimeout(()=>{if(typingIn?.group!==ref.group&&editing?.kind==='words'&&editing.groupId===ref.group.id)closeRow(ref.group,true);},0);
    };
  }
  async function closeRow(g,save){
    if(closing)return;closing=true;
    try{if(save){try{await commitRow(rowLines(g));}catch(e){fail(e);}}}
    finally{closing=false;}
    if(editing?.groupId===g.id)editing=null;typingIn=null;draft=null;
    render();notify();refreshView();
  }
  // Every line of words in the chart, in order (a row with no words offers a new line for each pass): where pasted lines flow to.
  function allLines(){
    const list=[];
    for(const section of model.sections)for(const g of section.groups)for(const item of laneItems(g)){
      const tokens=item.lane?.tokens||[];
      list.push({...item,original:joinWords(tokens),anchorKey:tokens[0]?.chunkKey??null});
    }
    return list;
  }
  // Save every changed line of a row as one edit. Several lines pasted into one line at once flow into the next lines in order, so a
  // whole song can be pasted into the first one.
  async function commitRow(lines){
    if(saving)return;
    const every=allLines(),texts=new Map();let multiple=false;      // line id -> what it now says
    for(const ref of lines){
      if(texts.get(ref.id)?.pasted||!changed(ref))continue;
      const parts=String(ref.node.textContent).split(/\n+/).map(t=>t.replace(/\s+/g,' ').trim()),filled=parts.filter(Boolean),list=filled.length>1?filled:[filled[0]??''];
      const at=every.findIndex(l=>l.id===ref.id);if(at<0)continue;
      const targets=[{...every[at],anchorKey:ref.anchorKey},...every.slice(at+1)];
      if(list.length>targets.length)throw Error('That is '+list.length+' lines of words but only '+targets.length+' lines to put them on from here. Trim the text or add rows first.');
      if(list.length>1)multiple=true;
      list.forEach((text,k)=>texts.set(targets[k].id,{target:targets[k],text,pasted:k>0}));
    }
    // Lines already there go from the last one up: a line emptied of words is removed, which renumbers the lines after it (never the
    // ones before). New lines are added after them, in pass order, each at the end of its section.
    let content=data.content,lost=0;const labels=new Set(),touched=new Set();
    for(const line of [...every.filter(l=>l.lane).reverse(),...every.filter(l=>!l.lane)]){
      const entry=texts.get(line.id);if(!entry)continue;const {target,text}=entry;
      if(target.lane&&text===target.original.trim())continue;
      const key=target.group.sectionId+':'+target.lane?.line;
      if(target.lane&&touched.has(key))throw Error('One lyric line runs across several rows here. Paste fewer lines, or fix it one row at a time.');
      const planned=planPageEdit.laneText({content,music:data.music,model,group:target.group,lane:target.lane,passNumber:target.passNumber,anchorKey:target.anchorKey,text});
      if(planned.conflicts?.length)throw Error(planned.conflicts[0].message);
      if(planned.candidate){content=planned.candidate;lost+=planned.lost||0;labels.add(planned.label);if(target.lane)touched.add(key);}
    }
    if(content===data.content)return;
    const saved=await commitPlain(content,multiple?'Add lyrics':labels.size===1?[...labels][0]:'Edit lyrics');
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

  // ======================= Ctrl: split and join sections =======================
  // A section is never empty: a split must fall inside it, and joining removes the boundary instead of leaving a hole.
  let cutTimes=[];
  function cutPoints(){
    if(!model)return [];
    const times=[];
    for(const section of model.sections)section.groups.forEach((g,i)=>{
      if(i>0)times.push(g.start);
      if(g.passCount===1)g.bars.forEach((bar,j)=>{if(j>0&&bar.mapped)times.push(bar.start);});
    });
    return times;
  }
  const canCut=t=>finite(t)&&cutTimes.some(x=>Math.abs(x-t)<1e-6);
  async function splitAt(seconds){
    if(blocked()||!canEdit())return;
    try{
      const section=model.sections.find(s=>seconds>s.start+1e-9&&seconds<s.end-1e-9);
      const address=addressAtSeconds(model.measures,seconds);
      if(!section||!address)throw Error('Choose a bar inside a section to split it.');
      const newId=crypto.randomUUID();
      const result=planSectionEdit(data.content,data.music,{sectionId:section.id,operation:'split',fields:{address:{measure_id:address.measure_id,beat:address.beat},newId,name:'New section'}});
      if(result.conflicts?.length)return fail(Error(result.conflicts[0].message));
      // straight after a split the new section's name is ready to type
      pendingName=newId;
      if(!await commitPlain(result.candidate,'Split section'))pendingName=null;
    }catch(e){pendingName=null;fail(e);}
  }
  async function joinWithPrevious(section){
    if(blocked()||!canEdit())return;
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

  // ======================= Ctrl: section names =======================
  function renameSection(node,section){
    if(blocked()||!canEdit())return;
    node.contentEditable='plaintext-only';let done=false;
    const finish=async save=>{
      if(done)return;done=true;const name=node.textContent.replace(/\s+/g,' ').trim();draft=null;node.contentEditable='false';
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
    node.focus?.();globalThis.getSelection?.()?.selectAllChildren?.(node);
  }

  // ======================= public API =======================
  const api={
    getMode:()=>mode,getScope:()=>scope,getSnap:()=>snapping?autoSnap(zoom):'free',isSnapping:()=>snapping,
    // kept for the toolbar, which shows the timing options while the chart is drawn in time
    getTool:()=>mode==='timing'?'words':'navigate',
    getKeys:()=>({...held,latched}),
    // The rail and its note are shared with the lead sheet: take them back when the chart is shown again.
    showTools(){if(data&&dock.dataset?.owner!=='chart')renderTools();},
    // nav: the chart as written; timing: drawn true to time (as a tap of Shift does). Printing asks for the chart as written.
    setMode(next){
      if(!['nav','timing'].includes(next)||next===mode&&latched===(next==='timing'))return mode;
      if(blocked())return mode;
      latched=next==='timing';refreshView();renderTools();return mode;
    },
    // Esc: drop a half-picked repeat, then leave the in-time view kept by a tap of Shift. Returns true when the key was used.
    handleKey(event){
      if(event.key!=='Escape')return false;
      if(fixing.a||foldGroup){fixing.a=fixing.b=null;foldGroup=null;keepPlace(render);return true;}
      if(latched){latched=false;refreshView();renderTools();return true;}
      return false;
    },
    setScope(next){if(['occurrence','all-matching'].includes(next))scope=next;handlers.onScopeChange?.(scope);},
    hasRepeats:()=>!!model?.sections.some(s=>s.groups.some(g=>g.passCount>1)),
    // the magnet: on snaps to a grid that follows the zoom, off places words and chords exactly where they are dropped
    setSnapping(on){snapping=!!on;if(mode==='timing')keepPlace(render);handlers.onTimingChange?.({snap:api.getSnap(),zoom});},
    getZoom:()=>zoom,
    // any zoom between the smallest and largest level (the bar under the desk and Ctrl+wheel share it, see desk-bars.js)
    setZoom(next){const z=finite(next)?Math.max(ZOOM_LEVELS[0],Math.min(ZOOM_LEVELS.at(-1),Math.round(next*100)/100)):zoom;if(z===zoom)return zoom;zoom=z;if(mode==='timing')keepPlace(render);handlers.onTimingChange?.({snap:api.getSnap(),zoom});return zoom;},
    zoomBy(direction){return api.setZoom(stepZoom(zoom,direction));},
    getProjection:()=>model?.projection||null,getModel:()=>model,
    getSelectedSeconds:()=>null,
    hasDraft:()=>!!draft?.dirty,hasPendingSave:()=>saving||!!draft?.dirty,canNavigate:()=>!blocked(),
    updatePlayback,
    update(value){
      if(draft?.node&&draft.node.isConnected===false)draft=null;          // a line that is no longer on the page is not being typed in
      const nextKey=JSON.stringify([value.documentId,value.revision,value.content,value.music,!!value.suggest,value.onsets?.length||0,value.onsets?.[0],value.melody?.length||0,value.key||null,value.waveform?.run??null,value.waveform?.duration??null]);
      if(data?.documentId!==value.documentId){if(draft?.dirty)return;key=null;editing=null;fixing.a=fixing.b=null;foldGroup=null;for(const k of Object.keys(targetPass))delete targetPass[k];for(const k of Object.keys(seekPass))delete seekPass[k];}
      data=value;
      if(nextKey!==key&&!draft&&!saving){key=nextKey;render();}else updatePlayback(value.transport);
    },
    dispose(){
      doc?.removeEventListener?.('keydown',keyDown,true);doc?.removeEventListener?.('keyup',keyUp,true);doc?.removeEventListener?.('pointerdown',onPointer,true);
      if(typeof window!=='undefined')window.removeEventListener?.('blur',allUp);
      root.replaceChildren();handlers.legend?.classList?.remove('editing','timing');
    },
  };
  return api;
}

// Where a new chord goes when a chord is split: the beat nearest the middle of the chord's span, so it is split in two.
export function splitTime(chord,music){
  const measures=music?.measures||[],beats=measures.flatMap(m=>m.beats).filter(t=>t>chord.start+1e-6&&t<chord.end-1e-6);
  const mid=(chord.start+chord.end)/2;
  if(beats.length){let best=beats[0];for(const t of beats)if(Math.abs(t-mid)<Math.abs(best-mid))best=t;return best;}
  if(chord.end-chord.start>.5)return +(mid).toFixed(3);
  throw Error('This chord is too short to split. Make it longer first.');
}
