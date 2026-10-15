export const rhythmExplanation='These choices affect rhythm overrides only. Your chord names and times, lyrics, section names and boundaries, notes and other edits are preserved. Manual placements are remapped safely or reported as conflicts.';
export const rhythmChoices=manual=>manual?[{label:'Keep rhythm overrides and apply',policy:'preserve'},{label:'Replace rhythm overrides and apply',policy:'clear'},{label:'Cancel',policy:null}]:[{label:'Apply corrected timing',policy:'clear'},{label:'Cancel',policy:null}];
export class ProposalGuard{
 constructor(selection){this.selection=selection;this.generation=0;this.busy=false;}
 begin(){return {id:this.selection(),generation:++this.generation};}
 valid(ticket){return ticket.id===this.selection()&&ticket.generation===this.generation;}
 cancel(){this.generation++;}
 acquire(){if(this.busy)return false;this.busy=true;return true;}
 release(){this.busy=false;}
}
export function renderRhythmPreview({preview,busy=false},handlers){
 const dialog=document.createElement('dialog');dialog.className='rhythm-dialog';const title=document.createElement('h2');title.textContent='Drum-based rhythm correction';dialog.append(title);
 const explanation=document.createElement('p');explanation.textContent=rhythmExplanation;dialog.append(explanation);
 const status=document.createElement('p');status.setAttribute('role','status');status.textContent=preview.unresolved?.length?'Timing remains unresolved: '+preview.unresolved.map(x=>x.reason||'Ambiguous evidence').join('; '):preview.changes?'A supported correction is available. Review your choice before applying.':'No supported timing changes were found.';dialog.append(status);
 const errors=document.createElement('p');errors.setAttribute('role','alert');dialog.append(errors);
 const details=document.createElement('ul');details.className='rhythm-changes';
 for(const change of preview.change_details||[]){const item=document.createElement('li');item.textContent=`Bar ${change.number}: boundary shift ${((change.after_start-change.before_start)*1000).toFixed(1)} ms; largest beat shift ${(change.maximum_beat_shift_seconds*1000).toFixed(1)} ms`;details.append(item);}dialog.append(details);
 const actions=[];
 for(const choice of rhythmChoices(preview.has_manual_rhythm)){
  const button=document.createElement('button');button.textContent=choice.label;button.disabled=choice.policy!==null&&(busy||!preview.changes);actions.push(button);dialog.append(button);
  button.onclick=async()=>{if(!choice.policy){handlers.cancel();dialog.close();return;}actions.forEach(b=>b.disabled=true);try{
   const candidate=await handlers.preview(choice.policy);
   if(!candidate)return;
   if(candidate.conflicts.length){errors.textContent=candidate.conflicts.map(x=>x.message).join('\n');return;}
   await handlers.apply(candidate);dialog.close();
  }catch(error){errors.textContent=error.message;}finally{actions.forEach(b=>b.disabled=false);}};
 }
 dialog.addEventListener('cancel',()=>handlers.cancel());dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();return dialog;
}
