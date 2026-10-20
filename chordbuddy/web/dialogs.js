// Small modal dialogs in the Press Room style: a question with a few answers, and the Trash list.
// Plain DOM, no dependencies. Everything resolves or calls back; nothing here touches the library itself.
const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

function shell(host,title,message,cancelLabel){
  const dialog=el('dialog','choice-dialog'),heading=el('h2','',title);
  dialog.append(heading);
  for(const line of [].concat(message||[]).filter(Boolean))dialog.append(el('p','choice-text',line));
  const actions=el('div','choice-actions');
  const close=()=>{try{dialog.close?.();}catch{/* already closed */}dialog.remove?.();};
  host.append(dialog);
  return {dialog,actions,close,cancelLabel};
}
function show(dialog){
  if(typeof dialog.showModal==='function'){try{dialog.showModal();return;}catch{/* fall through */}}
  dialog.setAttribute('open','');
}

// choices: [{id, label, kind: 'primary'|'danger'|'secondary', keepOpen}]. Resolves with the chosen id, or null for Cancel / Esc.
// A keepOpen choice calls onPick(id) and leaves the dialog up (used for "Export PDF" before deciding).
// radios: {label, value, options:[{id, label, hint}], onChange(id)}: one choice out of a few, shown above the buttons.
export function askChoice({title,message,choices,cancel='Cancel',onPick=()=>{},host=document.body,checkbox=null,radios=null}){
  return new Promise(resolve=>{
    const {dialog,actions,close}=shell(host,title,message,cancel);
    if(radios)dialog.append(radioGroup(radios));
    if(checkbox)dialog.append(checkRow(checkbox));
    let done=false;
    const finish=value=>{if(done)return;done=true;close();resolve(value);};
    const cancelButton=el('button','secondary choice-cancel',cancel);cancelButton.type='button';cancelButton.onclick=()=>finish(null);
    actions.append(cancelButton);
    for(const choice of choices){
      const button=el('button',choice.kind==='danger'?'btn hot choice-danger':choice.kind==='primary'?'btn blue':'secondary','');
      button.textContent=choice.label;button.type='button';button.dataset.choice=choice.id;
      button.onclick=()=>{if(choice.keepOpen)onPick(choice.id);else finish(choice.id);};
      actions.append(button);
    }
    dialog.append(actions);
    dialog.oncancel=e=>{e?.preventDefault?.();finish(null);};
    dialog.addEventListener?.('close',()=>finish(null));
    show(dialog);
    cancelButton.focus?.();
  });
}

function radioGroup({label,value,options,onChange}){
  const group=el('div','choice-radios');group.setAttribute('role','radiogroup');if(label){group.setAttribute('aria-label',label);group.append(el('span','choice-radios-label',label));}
  const name='choice-'+Math.random().toString(36).slice(2);
  for(const option of options){
    const row=el('label','choice-radio'),input=el('input'),text=el('span','setup-stems-text');
    input.type='radio';input.name=name;input.value=option.id;input.checked=option.id===value;input.id=name+'-'+option.id;
    input.onchange=()=>{if(input.checked)onChange?.(option.id);};
    text.append(el('strong','',option.label));if(option.hint)text.append(el('small','',option.hint));
    row.append(input,text);group.append(row);
  }
  return group;
}

// A labelled tick box with a line of explanation: {label, hint, checked, onChange(value)}.
function checkRow({label,hint,checked,onChange,id}){
  const box=el('input');box.type='checkbox';box.checked=!!checked;if(id)box.id=id;
  const row=el('label','setup-stems'),text=el('span','setup-stems-text');
  text.append(el('strong','',label));if(hint)text.append(el('small','',hint));
  row.append(box,text);
  box.onchange=()=>onChange?.(box.checked);
  row.input=box;return row;
}

// After a recording is added: its name, its artist, and whether to split the stems too. Resolves with {title, artist, stems}, or null
// for "Not now" (the song is kept, just not analyzed yet).
export const DEVICES=[['auto','Automatic'],['cuda','NVIDIA GPU only'],['cpu','CPU only']];
export function askSongSetup({title='',artist='',stems=false,stemsHint='',device='auto',host=document.body}){
  return new Promise(resolve=>{
    const {dialog,actions,close}=shell(host,'Set up this song',['Check the name, then Chord Buddy works out the chords. You can change any of this later.']);
    dialog.classList.add('setup-dialog');
    const form=el('div','setup-form');
    const field=(label,value,id)=>{const wrap=el('label','setup-field'),input=el('input');input.value=value||'';input.maxLength=200;input.id=id;input.autocomplete='off';wrap.append(el('span','',label),input);form.append(wrap);return input;};
    const titleInput=field('Song title',title,'setup-title'),artistInput=field('Artist',artist,'setup-artist');
    const stemsRow=checkRow({label:'Also split the stems',hint:stemsHint,checked:stems,id:'setup-stems'});form.append(stemsRow);
    // where the work is done: the graphics card is much faster when there is a suitable (NVIDIA) one; the choice is kept for next time
    const deviceWrap=el('label','setup-field setup-device'),deviceSelect=el('select');deviceSelect.id='setup-device';
    for(const [value,text] of DEVICES){const option=el('option','',text);option.value=value;deviceSelect.append(option);}
    deviceSelect.value=DEVICES.some(([value])=>value===device)?device:'auto';
    deviceWrap.append(el('span','','Process with'),deviceSelect,el('small','','Automatic uses an NVIDIA graphics card when there is one, and the processor otherwise.'));form.append(deviceWrap);
    dialog.append(form);
    let done=false;
    const finish=value=>{if(done)return;done=true;close();resolve(value);};
    const later=el('button','secondary choice-cancel','Not now');later.type='button';later.onclick=()=>finish(null);
    const go=el('button','btn hot','Analyze');go.type='button';go.id='setup-go';
    const check=()=>{go.disabled=!titleInput.value.trim();};
    titleInput.oninput=check;check();
    go.onclick=()=>{if(go.disabled)return;finish({title:titleInput.value.trim(),artist:artistInput.value.trim(),stems:stemsRow.input.checked,device:deviceSelect.value});};
    for(const input of [titleInput,artistInput])input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault?.();go.onclick();}};
    actions.append(later,go);dialog.append(actions);
    dialog.oncancel=e=>{e?.preventDefault?.();finish(null);};
    dialog.addEventListener?.('close',()=>finish(null));
    show(dialog);
    titleInput.focus?.();titleInput.select?.();
  });
}

// The Trash: every trashed song with Restore and Delete forever. `items` is read again after each action via getItems().
export function openTrash({getItems,onRestore,onPurge,host=document.body}){
  const {dialog,actions,close}=shell(host,'Trash',['Deleted songs wait here. Nothing is erased until you choose Delete forever.']);
  const list=el('div','trash-list');dialog.append(list);
  const closeButton=el('button','secondary choice-cancel','Close');closeButton.type='button';closeButton.onclick=close;actions.append(closeButton);dialog.append(actions);
  const render=()=>{
    list.replaceChildren();
    const items=getItems();
    if(!items.length){list.append(el('p','choice-text','The Trash is empty.'));return;}
    for(const item of items){
      const row=el('div','trash-row'),info=el('div','trash-info'),title=el('strong','',item.title),meta=el('small','',[item.artist,item.filename].filter(Boolean).join(' · '));
      info.append(title,meta);
      const restore=el('button','secondary','Restore'),purge=el('button','secondary trash-forever','Delete forever');restore.type=purge.type='button';
      restore.onclick=async()=>{await onRestore(item);render();};
      purge.onclick=async()=>{await onPurge(item);render();};
      row.append(info,restore,purge);list.append(row);
    }
  };
  dialog.oncancel=e=>{e?.preventDefault?.();close();};
  render();show(dialog);
  return {render,close};
}
