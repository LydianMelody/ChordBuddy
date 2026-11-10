// Undo and redo, as the page shows them: the short note after an undo or redo (what happened, by name, with a button to go back), and
// the History menu, for a document (chart, lead sheet, MIDI) and for the Perform tab's own history.
// app.js makes one with createHistoryUi({$, model, practiceView, performanceApp, currentSong, currentRecord, historyAction}).
// performanceApp only needs a `history` property (null when the Perform tab has none); reading it may throw before the show system
// exists, which syncPrepareHistory() expects. historyAction(action, position) is app.js's own undo/redo/goto. wire() attaches the menu.

export function createHistoryUi({$,model,practiceView,performanceApp,currentSong,currentRecord,historyAction}){
let historyNoteTimer=0;
function noteHistory(before,after){
  const from=before.cursor,to=after.cursor,labels=before.history;
  if(typeof from!=='number'||typeof to!=='number'||from===to||!labels)return;
  const n=Math.abs(to-from),name=currentSong()?.title,where=name?` in ${name}`:'';
  const text=to<from?(n===1?`Undid “${labels[from]}”${where}.`:`Undid ${n} changes${where}, back to before “${labels[to+1]}”.`)
    :(n===1?`Redid “${labels[to]}”${where}.`:`Redid ${n} changes${where}, up to “${labels[to]}”.`);
  showHistoryNote(text,to<from,()=>historyAction('goto',from));
}
/** The note after an undo or redo: what happened, by name, and a button to go back. undid: whether it was an undo. */
function showHistoryNote(text,undid,back){
  $('history-note-text').textContent=text;
  const button=$('history-note-back');button.textContent=undid?'Redo':'Undo';
  button.title=undid?'Put back what was just undone':'Undo what was just redone';
  button.onclick=()=>{hideHistoryNote();back();};
  $('history-note').classList.remove('hidden');clearTimeout(historyNoteTimer);historyNoteTimer=setTimeout(hideHistoryNote,8000);
}
// ---- the Perform tab's history, through the same Undo, Redo and History as every view
function syncPrepareHistory(){
  let h=null;try{h=performanceApp.history;}catch{return;}   // before the Perform tab exists, at startup
  if(!h)return;
  $('undo').disabled=!h.canUndo;$('redo').disabled=!h.canRedo;
  $('undo').dataset.tip=h.undoLabels[0]?`Undo: ${h.undoLabels[0]}.`:'Undo the last change.';$('redo').dataset.tip=h.redoLabels[0]?`Redo: ${h.redoLabels[0]}.`:'Put back what you just undid.';
  if($('history-menu').open)renderHistoryMenu();
}
function notePrepareStep({undid,count,label}){
  const h=performanceApp.history;if(!h||!label)return;
  const text=undid?(count===1?`Undid “${label}”.`:`Undid ${count} changes, back to before “${label}”.`):(count===1?`Redid “${label}”.`:`Redid ${count} changes, up to “${label}”.`);
  showHistoryNote(text,undid,()=>performanceApp.history?.go(undid?count:-count));
}
function hideHistoryNote(){clearTimeout(historyNoteTimer);$('history-note').classList.add('hidden');}
// The History menu: the changes after "Now" (to redo) above it, the ones before it (to undo) below, newest nearest; a step goes there at once.
function renderHistoryMenu(){
  if(performanceApp.history){renderPrepareHistoryMenu(performanceApp.history);return;}
  const pop=$('history-pop'),record=currentRecord(),doc=record?.doc,labels=doc?.history||[],at=doc?.cursor??0;
  const item=(text,steps,title,go)=>{const b=document.createElement('button');b.type='button';b.className='text-button';b.title=title;
    b.append(document.createTextNode(text));const s=document.createElement('small');s.textContent=steps===1?'1 step':`${steps} steps`;b.append(s);
    b.onclick=()=>historyAction('goto',go);pop.append(b);};
  const line=(className,text)=>{const p=document.createElement('p');p.className=className;p.textContent=text;pop.append(p);};
  pop.replaceChildren();
  if(!doc||labels.length<2){line('more-label','No changes yet. Your edits show up here by name.');return;}
  if(record.dirty||record.saving||model.pendingChart||practiceView.hasDraft()){line('more-label','Finish or save the edit you’re making first.');return;}
  for(let p=Math.min(labels.length-1,at+10);p>at;p--)item(`Redo up to “${labels[p]}”`,p-at,`Put back ${p-at===1?'this change':`the ${p-at} changes up to and including this one`}`,p);
  line('history-now',at===0?'Now · as Chord Buddy made it':'Now');
  const last=Math.max(1,at-19);
  for(let p=at;p>=last;p--)item(p===at?`Undo “${labels[p]}”`:`Undo back through “${labels[p]}”`,at-p+1,
    `Undo ${p===at?'this change':`this change and the ${at-p} after it`}. Redo, or this menu, can put ${p===at?'it':'them'} back`,p-1);
  if(last>1)line('more-label',`${last-1} older change${last-1===1?'':'s'}: undo back to the last one here, then open History again.`);
}
/** The same menu for the Perform tab: redo steps above Now, undo steps below, newest nearest. */
function renderPrepareHistoryMenu(h){
  const pop=$('history-pop');pop.replaceChildren();
  const item=(text,steps,title,go)=>{const b=document.createElement('button');b.type='button';b.className='text-button';b.title=title;
    b.append(document.createTextNode(text));const small=document.createElement('small');small.textContent=steps===1?'1 step':`${steps} steps`;b.append(small);
    b.onclick=()=>{$('history-menu').open=false;h.go(go);};pop.append(b);};
  const line=(className,text)=>{const p=document.createElement('p');p.className=className;p.textContent=text;pop.append(p);};
  const undo=h.undoLabels,redo=h.redoLabels;
  if(!undo.length&&!redo.length){line('more-label','No changes yet. Your edits to this arrangement show up here by name.');return;}
  for(let n=Math.min(redo.length,10);n>=1;n--)item(`Redo up to “${redo[n-1]}”`,n,`Put back ${n===1?'this change':`the ${n} changes up to and including this one`}`,n);
  line('history-now','Now');
  for(let n=1;n<=Math.min(undo.length,20);n++)item(n===1?`Undo “${undo[0]}”`:`Undo back through “${undo[n-1]}”`,n,`Undo ${n===1?'this change':`this change and the ${n-1} after it`}. Redo, or this menu, can put ${n===1?'it':'them'} back`,-n);
}
function wire(){
$('history-menu').addEventListener('toggle',()=>{if($('history-menu').open)renderHistoryMenu();});
}
return {noteHistory,showHistoryNote,hideHistoryNote,syncPrepareHistory,notePrepareStep,renderHistoryMenu,renderPrepareHistoryMenu,wire};
}
