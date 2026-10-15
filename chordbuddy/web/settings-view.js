const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const button=(text,action,cls='secondary')=>{const b=node('button',text);b.type='button';b.className=cls;b.onclick=action;return b;};
const link=(text,href)=>{const a=node('a',text);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;};
function dialog(title){
  const d=node('dialog');d.className='settings-dialog';const heading=node('h2',title);const close=button('Close',()=>d.close(),'text-button');close.setAttribute('aria-label',`Close ${title}`);
  const head=node('div');head.className='settings-heading';head.append(heading,close);d.append(head);document.body.append(d);d.addEventListener('close',()=>d.remove());d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});return d;
}
export function openSettings({settings,onSave}){
  const d=dialog('Settings');d.append(node('h3','Confidence tolerance'),node('p','Model confidence describes prediction certainty, not a guarantee of musical correctness. Older transcriptions need reprocessing to obtain scores.'));
  const form=node('form'),inputs={};
  const deviceLabel=node('label','Processing device'),device=node('select');device.setAttribute('aria-label','Processing device');
  for(const [value,text] of [['auto','Automatic · NVIDIA GPU when available'],['cuda','NVIDIA GPU only'],['cpu','CPU only']]){const option=node('option',text);option.value=value;device.append(option);}
  device.value=settings.device||'auto';deviceLabel.append(device);form.append(node('h3','Processing'),deviceLabel,node('small','Automatic uses CUDA when available and otherwise uses the CPU. GPU only reports an error if CUDA is unavailable.')); 

  for(const [key,text,help] of [
    ['beat_flag_threshold','Flag beats below','Amber beat indicators update immediately on scored transcriptions.'],
    ['beat_remove_threshold','Remove beats below','Saving updates the current song immediately. 0% removes no beats. Lowering this restores retained detections without reprocessing.'],
    ['chord_flag_threshold','Flag chords below','Marks chords below this confidence in the legend and tooltip. Chords are never removed automatically.'],
    ['chord_opacity_min','Lowest chord opacity','Low-confidence chord text fades toward this opacity. 100% keeps all chords fully opaque.'],
    ['chord_opacity_max','Highest chord opacity','The opacity used for fully confident chords and chords without a score.']]){
    const label=node('label',text),field=node('input');field.type='number';field.min='0';field.max='100';field.step='1';field.required=true;const fallback=key==='beat_remove_threshold'?0:key==='chord_opacity_min'?40:100;field.value=settings[key]??fallback;field.setAttribute('aria-label',text);inputs[key]=field;
    const row=node('div');row.className='settings-field';label.append(field,node('span','%'));row.append(label,node('small',help));form.append(row);
  }
  const error=node('p');error.className='settings-error';error.setAttribute('role','alert');
  const save=node('button','Save settings');save.className='primary';save.type='submit';
  form.append(error,save);form.onsubmit=async e=>{e.preventDefault();error.textContent='';const values=Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,Number(v.value)]));
    if(values.beat_remove_threshold>values.beat_flag_threshold){error.textContent='The removal threshold must be at or below the beat warning threshold.';return;}
    if(values.chord_opacity_min>values.chord_opacity_max){error.textContent='Lowest chord opacity cannot exceed highest chord opacity.';return;}
    save.disabled=true;try{await onSave({...values,device:device.value});d.close();}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
  d.append(form,node('p','Legend: ⚑ bar timing/meter review · amber beat numbers: low rhythm confidence · chord opacity: model certainty.'));d.showModal();return d;
}
export function openModelAttribution(model){
  const d=dialog('Model & attribution');d.classList.add('attribution-dialog');
  if(!model){d.append(node('p','Model information is unavailable until the local transcription engine starts.'));d.showModal();return d;}
  d.append(node('p',`This installation uses ${model.name} to turn a recording into an editable draft.`));
  const details=node('dl','attribution-details');
  const add=(term,value)=>{details.append(node('dt',term));const definition=node('dd');if(value instanceof Node)definition.append(value);else definition.textContent=value;details.append(definition);};
  add('Transcription model',link(`${model.name} · ${model.id}`,model.url));
  add('Pinned revision',model.revision);
  add('Base model',link(`${model.base_model.name} · ${model.base_model.id}`,model.base_model.url));
  add('Weight license',link(model.license.name,model.license.url));
  const citations=node('span');citations.append(...model.citation.flatMap((item,index)=>index?[document.createTextNode(' · '),link(item.name,item.url)]:[link(item.name,item.url)]));add('Research citation',citations);
  d.append(details,node('p',model.notice),node('p','The model card and included weight license request attribution to MERT2, the model name, and its source repository.'));
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
