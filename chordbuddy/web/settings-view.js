const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const button=(text,action,cls='secondary')=>{const b=node('button',text);b.type='button';b.className=cls;b.onclick=action;return b;};
const link=(text,href)=>{const a=node('a',text);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;};
function dialog(title){
  const d=node('dialog');d.className='settings-dialog';const heading=node('h2',title);const close=button('Close',()=>d.close(),'text-button');close.setAttribute('aria-label',`Close ${title}`);
  const head=node('div');head.className='settings-heading';head.append(heading,close);d.append(head);document.body.append(d);d.addEventListener('close',()=>d.remove());d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});return d;
}
// Who made Chord Buddy, at the foot of the attribution page.
function credit(){
  const p=node('p');p.className='attribution-credit';
  p.append('Made by ',link('LydianMelody','https://github.com/LydianMelody'),' & Claude 5.5 · ',link('Chord Buddy on GitHub','https://github.com/LydianMelody/ChordBuddy'));
  return p;
}
export function openModelAttribution(model){
  const d=dialog('Model & attribution');d.classList.add('attribution-dialog');
  if(!model){d.append(node('p','Model information is unavailable until the local transcription engine starts.'),credit());d.showModal();return d;}
  d.append(node('p',`This installation uses ${model.name} to turn a recording into an editable draft.`));
  const details=node('dl');details.className='attribution-details';
  const add=(term,value)=>{details.append(node('dt',term));const definition=node('dd');if(value instanceof Node)definition.append(value);else definition.textContent=value;details.append(definition);};
  add('Transcription model',link(`${model.name} · ${model.id}`,model.url));
  add('Pinned revision',model.revision);
  add('Base model',link(`${model.base_model.name} · ${model.base_model.id}`,model.base_model.url));
  add('Weight license',link(model.license.name,model.license.url));
  const citations=node('span');citations.append(...model.citation.flatMap((item,index)=>index?[document.createTextNode(' · '),link(item.name,item.url)]:[link(item.name,item.url)]));add('Research citation',citations);
  d.append(details,node('p',model.notice),node('p','The model card and included weight license request attribution to MERT2, the model name, and its source repository.'),credit());
  d.showModal();return d;
}
export function openSongTiming({metadata,onSave}){
  const d=dialog('Song timing');d.classList.add('timing-dialog');
  d.append(node('p','Use this when the recording has a steady pulse. Rebuilds beats and barlines through silence, ignoring extra detected downbeats. Recorded meter changes are preserved. Manually placed lyrics keep their recording times.'));
  const form=node('form'),constant=node('input');constant.type='checkbox';constant.checked=metadata?.timing?.constant_tempo===true;const constantLabel=node('label');constantLabel.append(constant,node('span','Tempo never changes'));form.append(constantLabel);
  const bpm=node('input');bpm.type='number';bpm.min='20';bpm.max='300';bpm.step='.1';bpm.value=metadata?.timing?.bpm??'';const bpmLabel=node('label');bpmLabel.append(node('span','BPM (optional)'),bpm);form.append(bpmLabel,node('small','Leave BPM empty to estimate one steady tempo from the detected beat spacing.'));
  const error=node('p');error.className='settings-error';error.setAttribute('role','alert');const save=node('button','Save timing');save.className='primary';save.type='submit';form.append(error,save);
  form.onsubmit=async event=>{event.preventDefault();const value=bpm.value.trim();const parsed=value===''?null:Number(value);if(parsed!==null&&(!Number.isFinite(parsed)||parsed<20||parsed>300)){error.textContent='BPM must be between 20 and 300, or empty.';return;}save.disabled=true;try{await onSave({timing:{constant_tempo:constant.checked,bpm:parsed},chord_overrides:metadata?.chord_overrides||[]});d.close();}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
  d.append(form);d.showModal();return d;
}
export function openReprocess({hasEdits,runs,activeRun,onRun,onRestore,canRun=true}){
  const d=dialog(canRun?'Reprocess song':'Previous transcriptions'),description=node('p',!canRun?'Open a previous transcription with its saved edits and undo history.':hasEdits?'This song has user edits. Keep edited documents beside the fresh output, or replace the active documents with fresh output. Previous runs and histories stay recoverable.':'Generate a fresh transcription with the current confidence settings. Previous runs remain recoverable.');d.append(description);
  const status=node('p');status.className='settings-error';status.setAttribute('role','alert');
  let busy=false;const actions=[];
  async function runAction(action){if(busy)return;busy=true;actions.forEach(b=>b.disabled=true);try{await action();d.close();}catch(e){status.textContent=e.message;busy=false;actions.forEach(b=>b.disabled=false);}}
  if(canRun){const keep=button('Keep my edits',()=>runAction(()=>onRun('keep')),'primary'),replace=button('Replace with fresh output',()=>runAction(()=>onRun('replace')));actions.push(keep,replace);d.append(keep,replace,node('small',hasEdits?'Kept documents retain their original timing and undo history. Lyrics are not automatically remapped.':'Choose Keep my edits to preserve any manual changes and their history. Replace starts from fresh model output.'));}
  const previous=runs.filter(r=>r.id!==activeRun&&r.has_documents);
  if(previous.length){const details=node('details');details.open=!canRun;details.append(node('summary','Previous transcriptions'));const list=node('div');list.className='previous-runs';
    for(const r of previous){const row=node('div');row.append(node('span',`${new Date(r.created).toLocaleString()} · ${r.status}`));const restore=button('Open this transcription',()=>runAction(()=>onRestore(r.id)));actions.push(restore);row.append(restore);list.append(row);}details.append(list);d.append(details);}
  d.append(status);d.showModal();return d;
}
