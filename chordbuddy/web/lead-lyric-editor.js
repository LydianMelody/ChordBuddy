// Typing lyrics under the lead sheet's staves. One editable line per stretch of words, in the lyric space of each system, just like the
// chart's Edit mode: type a line, press Enter to go on to the next one, paste several lines to flow them down the page.
// The words belong to the chart, so every edit is a chart edit (planPageEdit.fragmentText) and both views always agree.
import {planPageEdit} from './chart-edits.js';

const joinWords=words=>words.map((w,i)=>w.text+(i<words.length-1&&!w.text.endsWith('-')?' ':'')).join('');

// What can be edited, from the layout of the rendered score. `systems` is [{key, notes:[{index,left,right,top,bottom,sectionId}], lyricTop, lyricBottom}]
// (positions in pixels inside the score). A system can cross from one section of the song into the next, so each system is cut at section
// boundaries first. Every cut piece gives one editable run per line of words in it, or one empty run to start a new line.
// Returns every run in reading order.
export function buildRuns(systems,byNote){
  const runs=[];
  for(const system of systems){
    const notes=[...system.notes].sort((a,b)=>a.index-b.index);
    const pieces=[];
    for(const note of notes){
      const last=pieces.at(-1);
      if(!last||last.sectionId!==(note.sectionId??null))pieces.push({sectionId:note.sectionId??null,notes:[]});
      pieces.at(-1).notes.push(note);
    }
    for(const piece of pieces){
      const own=[];let current=null;
      for(const note of piece.notes)for(const word of byNote.get(note.index)||[]){
        if(!current||current.sectionId!==word.sectionId||current.line!==word.line){
          current={sectionId:word.sectionId,line:word.line,words:[],left:note.left,right:note.right,firstNote:note.index,empty:false,system,notes:piece.notes};
          own.push(current);
        }
        current.words.push(word);current.right=note.right;
      }
      if(!own.length)own.push({sectionId:piece.sectionId,line:null,words:[],left:piece.notes[0].left,right:piece.notes.at(-1).right,firstNote:piece.notes[0].index,empty:true,system,notes:piece.notes});
      runs.push(...own);
    }
  }
  return runs;
}

const sectionAt=(content,seconds)=>(content.sections||[]).find(s=>seconds>=s.start-1e-6&&seconds<s.end-1e-6);

// The chart change that one edited run asks for. `ctx` = {content, music, measures, times, notes (analysis notes)}.
export function planRun(ctx,run,text,anchorNote=null){
  if(run.empty){
    const piece=run.notes.map(n=>n.index).sort((a,b)=>a-b);          // the notes of this system that are in one section
    const clicked=anchorNote!==null&&piece.includes(anchorNote)?anchorNote:piece[0];
    const note=ctx.times.notes[clicked],first=ctx.times.notes[piece[0]],last=ctx.times.notes[piece.at(-1)];
    if(!note?.address||!first?.address||!last?.address)throw Error('These notes have no timing in the chart yet.');
    const section=sectionAt(ctx.content,note.time);
    if(!section)throw Error('This part of the song is not inside a section of the chart. Add or stretch a section first.');
    return planPageEdit.fragmentText({content:ctx.content,music:ctx.music,sectionId:section.id,line:null,fragment:[],text,anchorAddress:note.address,
      span:{first:first.address.measure_id,last:last.address.measure_id}});
  }
  const fragment=run.words.map(w=>({text:w.text,offset:w.offset,pinned:w.pinned}));
  const first=run.words[0];
  return planPageEdit.fragmentText({content:ctx.content,music:ctx.music,sectionId:run.sectionId,line:run.line,fragment,text,anchorAddress:first.pinned?first.address:null});
}

// Pin one word to the note it was dropped on, or let a pinned word go again.
export function planPin(ctx,word,targetNote){
  const address=ctx.times.notes[targetNote]?.address;
  if(!address)throw Error('That note has no timing in the chart.');
  const planned=planPageEdit.pinWordAt({content:ctx.content,music:ctx.music,sectionId:word.sectionId,line:word.line,offset:word.offset,address});
  if(planned.conflicts.length)throw Error(planned.conflicts[0].message);
  return {content:planned.candidate,label:planned.label,lost:0};
}
export function planUnpin(ctx,word){
  return {content:planPageEdit.releaseWord({content:ctx.content,sectionId:word.sectionId,line:word.line,offset:word.offset}),label:'Release word',lost:0};
}

// Apply what was typed in one run (several lines pasted flow into the runs after it). Returns {content,label,lost} or null if nothing changed.
// Runs are applied from the last to the first so the character positions of the earlier ones stay valid.
export function planRunEdits(ctx,runs,startIndex,raw,anchorNote=null){
  const lines=String(raw).split(/\n+/).map(t=>t.replace(/\s+/g,' ').trim()),filled=lines.filter(Boolean);
  const multiple=filled.length>1,texts=multiple?filled:[filled[0]??''];
  const targets=runs.slice(startIndex);
  if(texts.length>targets.length)throw Error(`That is ${texts.length} lines of words but only ${targets.length} lyric line${targets.length===1?'':'s'} from here to the end. Trim the text or paste fewer lines.`);
  let content=ctx.content,lost=0,changed=false,label='Edit lyrics';
  for(let k=texts.length-1;k>=0;k--){
    const run=targets[k];
    if(!run.empty&&texts[k]===joinWords(run.words).trim())continue;
    if(run.empty&&!texts[k])continue;
    const planned=planRun({...ctx,content},run,texts[k],k===0?anchorNote:null);
    if(planned.conflicts?.length)throw Error(planned.conflicts[0].message);
    if(planned.candidate){content=planned.candidate;lost+=planned.lost||0;changed=true;label=multiple?'Add lyrics':planned.label;}
  }
  return changed?{content,label,lost}:null;
}

// Draw the editable lines over the lyric rows. `host` is the positioned element that holds the rendered score.
export function mountLyricEditors(host,{systems,byNote,ctx,onCommit,onError,focusNote=null}){
  const box=host.getBoundingClientRect();
  const runs=buildRuns(systems,byNote),nodes=[];
  const pct=(value,total)=>(100*value/total).toFixed(3)+'%';
  runs.forEach((run,index)=>{
    const system=run.system,top=system.lyricTop-3,height=Math.max(20,system.lyricBottom-system.lyricTop+6);
    const left=run.empty?Math.min(...run.notes.map(n=>n.left))-4:run.left-4,right=run.empty?Math.max(...run.notes.map(n=>n.right))+4:Math.max(run.right+34,run.left+60);
    const node=document.createElement('span');node.className='lead-run'+(run.empty?' empty':'');
    node.style.left=pct(left,box.width);node.style.width=pct(right-left,box.width);node.style.top=pct(top,box.height);node.style.minHeight=pct(height,box.height);
    node.contentEditable='plaintext-only';node.spellcheck=false;
    node.dataset.placeholder='Click and type the words';node.setAttribute('aria-label',run.empty?'Type the lyrics for this line of music':'Lyrics for this line of music');
    node.textContent=run.empty?'':joinWords(run.words);
    let anchor=null,done=false;
    node.onmousedown=event=>{
      if(!run.empty||!Number.isFinite(event.clientX))return;
      let best=null,gap=Infinity;const x=event.clientX-host.getBoundingClientRect().left;
      for(const n of run.notes){const d=Math.abs((n.left+n.right)/2-x);if(d<gap){gap=d;best=n;}}
      anchor=best?best.index:null;
    };
    const finish=async save=>{
      if(done)return false;done=true;
      const raw=node.textContent;
      if(!save){node.textContent=run.empty?'':joinWords(run.words);return false;}
      try{
        const result=planRunEdits(ctx,runs,index,raw,anchor);
        if(result)await onCommit(result);
      }catch(error){onError(error);}
      return true;
    };
    node.onfocus=()=>{done=false;node.classList.add('editing');};
    node.onblur=()=>{node.classList.remove('editing');finish(true);};
    node.onkeydown=async event=>{
      if(event.key==='Enter'||event.key==='Tab'&&!event.shiftKey){
        event.preventDefault();
        const next=runs[index+1];
        if(next)host._pendingFocusNote=next.firstNote;
        await finish(true);
        host._pendingFocusNote=null;
        nodes[index+1]?.focus?.();                       // (only matters when nothing was saved, so the page was not redrawn)
      }else if(event.key==='Escape'){event.preventDefault();finish(false);node.blur();}
    };
    host.append(node);nodes.push(node);
  });
  // Drag a word onto another note to pin it there; double-click a pinned word to let it go; a plain click edits its line.
  const around=[];for(const system of systems)for(const note of system.notes)around.push({...note,system});
  const toHost=event=>{const b=host.getBoundingClientRect();return {x:event.clientX-b.left,y:event.clientY-b.top};};
  const nearest=at=>{
    let system=null,gap=Infinity;
    for(const s of systems){const d=at.y<s.lyricTop?s.lyricTop-at.y:at.y>s.lyricBottom?at.y-s.lyricBottom:0;if(d<gap){gap=d;system=s;}}
    let best=null,span=Infinity;for(const n of system?.notes||[]){const d=Math.abs((n.left+n.right)/2-at.x);if(d<span){span=d;best=n;}}
    return best;
  };
  runs.forEach((run,runIndex)=>{
    if(run.empty)return;
    const system=run.system,seen=new Set();
    for(const note of run.notes){
      const word=(byNote.get(note.index)||[]).find(w=>w.sectionId===run.sectionId&&w.line===run.line);
      if(!word||seen.has(note.index))continue;seen.add(note.index);
      const chip=document.createElement('span');chip.className='lead-chip'+(word.pinned?' pinned':'');
      chip.style.left=pct(note.left-3,box.width);chip.style.width=pct(Math.max(14,note.right-note.left+6),box.width);
      chip.style.top=pct(system.lyricTop-3,box.height);chip.style.height=pct(Math.max(20,system.lyricBottom-system.lyricTop+6),box.height);
      chip.title=word.pinned?'Pinned to this note. Drag to move it, double-click to let it go.':'Drag onto another note to pin this word there.';
      let start=null,ghost=null,marker=null,target=null;
      const cleanup=()=>{ghost?.remove();marker?.remove();ghost=marker=null;start=null;};
      chip.onpointerdown=event=>{if(event.button!==0)return;start={x:event.clientX,y:event.clientY,moved:false};chip.setPointerCapture?.(event.pointerId);};
      chip.onpointermove=event=>{
        if(!start)return;
        if(!start.moved&&Math.hypot(event.clientX-start.x,event.clientY-start.y)<5)return;
        start.moved=true;const at=toHost(event);
        if(!ghost){ghost=document.createElement('span');ghost.className='lead-ghost';ghost.textContent=word.text;host.append(ghost);marker=document.createElement('span');marker.className='lead-drop';host.append(marker);}
        ghost.style.left=at.x+'px';ghost.style.top=at.y+'px';
        target=nearest(at);
        if(target){const s=around.find(n=>n.index===target.index).system;marker.style.left=pct((target.left+target.right)/2-1,box.width);marker.style.top=pct(s.lyricTop-34,box.height);marker.style.height=pct(s.lyricBottom-s.lyricTop+40,box.height);}
      };
      chip.onpointerup=async event=>{
        if(!start)return;
        const moved=start.moved,chosen=target;cleanup();target=null;chip.releasePointerCapture?.(event.pointerId);
        if(!moved){nodes[runIndex]?.focus();return;}
        if(!chosen||chosen.index===note.index)return;
        try{await onCommit(planPin(ctx,word,chosen.index));}catch(error){onError(error);}
      };
      chip.onpointercancel=()=>{cleanup();target=null;};
      chip.ondblclick=async()=>{if(!word.pinned)return;try{await onCommit(planUnpin(ctx,word));}catch(error){onError(error);}};
      host.append(chip);
    }
  });
  const want=focusNote??host._pendingFocusNote;
  if(want!==null&&want!==undefined){
    host._pendingFocusNote=null;
    const target=runs.findIndex(run=>run.system.notes.some(n=>n.index===want)&&(run.empty||run.firstNote<=want));
    const pick=runs.findIndex(run=>run.firstNote===want);
    nodes[pick>=0?pick:target]?.focus();
  }
  return {runs,nodes};
}
