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

// A labelled tick box with a line of explanation: {label, hint, checked, onChange(value), warning}. warning: text (or a function giving
// text, '' for none) shown only while the box is ticked; row.update() shows it again after something it depends on changes.
function checkRow({label,hint,checked,onChange,id,warning=''}){
  const box=el('input');box.type='checkbox';box.checked=!!checked;if(id)box.id=id;
  const row=el('label','setup-stems'),text=el('span','setup-stems-text'),warn=el('small','setup-stems-warn');
  text.append(el('strong','',label));if(hint)text.append(el('small','',hint));text.append(warn);
  row.append(box,text);
  row.update=()=>{const message=box.checked?(typeof warning==='function'?warning():warning)||'':'';warn.textContent=message;warn.hidden=!message;};
  box.onchange=()=>{row.update();onChange?.(box.checked);};
  row.update();row.input=box;return row;
}

// Shown when stems would be split on the processor: there is no working NVIDIA GPU, or "CPU only" was chosen.
export const CPU_STEMS_SLOW='Without an NVIDIA graphics card, splitting stems runs on the processor and can take up to an hour per song on older computers.';
export const CPU_STEMS_WARNING=CPU_STEMS_SLOW+' The chart, lead sheet and visualizer don’t need stems, and you can split them later from the mixer.';

// After a recording is added: its name, its artist, and whether to split the stems too. Resolves with {title, artist, stems}, or null
// for "Not now" (the song is kept, just not analyzed yet).
export const DEVICES=[['auto','Automatic'],['cuda','NVIDIA GPU only'],['cpu','CPU only']];
// gpu: whether this computer has a working NVIDIA GPU (the stems warning shows without one, or when "CPU only" is picked).
export function askSongSetup({title='',artist='',stems=false,stemsHint='',device='auto',gpu=true,host=document.body}){
  return new Promise(resolve=>{
    const {dialog,actions,close}=shell(host,'Set up this song',['Check the name, then Chord Buddy works out the chords. You can change any of this later.']);
    dialog.classList.add('setup-dialog');
    const form=el('div','setup-form');
    const field=(label,value,id)=>{const wrap=el('label','setup-field'),input=el('input');input.value=value||'';input.maxLength=200;input.id=id;input.autocomplete='off';wrap.append(el('span','',label),input);form.append(wrap);return input;};
    const titleInput=field('Song title',title,'setup-title'),artistInput=field('Artist',artist,'setup-artist');
    const deviceSelect=el('select');deviceSelect.id='setup-device';
    const stemsRow=checkRow({label:'Also split the stems',hint:stemsHint,checked:stems,id:'setup-stems',
      warning:()=>!gpu||deviceSelect.value==='cpu'?CPU_STEMS_WARNING:''});form.append(stemsRow);
    // where the work is done: the graphics card is much faster when there is a suitable (NVIDIA) one; the choice is kept for next time
    const deviceWrap=el('label','setup-field setup-device');
    for(const [value,text] of DEVICES){const option=el('option','',text);option.value=value;deviceSelect.append(option);}
    deviceSelect.value=DEVICES.some(([value])=>value===device)?device:'auto';
    deviceSelect.onchange=()=>stemsRow.update();stemsRow.update();
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

// A song zip whose title is already in this library (any recording, any IDs): keep or overwrite its analysis and its stems, or import
// it as a new song instead, which greys the other choices out. Stems only in the zip are added without asking. matches: the songs here with that title [{id, title, artist, analyzed,
// stems, same_recording}]; incoming: {analyzed, stems}. Resolves with {mode:'update', target, analysis, stems}, {mode:'new'}, or null.
export function askSongImport({title,matches,incoming,host=document.body}){
  return new Promise(resolve=>{
    const {dialog,actions,close}=shell(host,'Already in your library',['“'+title+'” is already here. Choose what to overwrite with the imported copy. Anything left unticked stays as it is on this computer.']);
    dialog.classList.add('setup-dialog');
    let target=matches[0],check=()=>{};
    const addStems=()=>!!incoming.stems&&!target.stems;
    if(matches.length>1){
      // Several songs share the title: pick the one to update.
      const wrap=el('label','setup-field setup-device'),pick=el('select');pick.id='import-target';
      const added=match=>{const date=new Date(match.created);return isNaN(date)?'':' · added '+date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});};
      for(const match of matches){const option=el('option','',match.title+added(match));option.value=match.id;pick.append(option);}
      pick.onchange=()=>{target=matches.find(match=>match.id===pick.value)||matches[0];render();};
      wrap.append(el('span','','Song to update'),pick);dialog.append(wrap);
    }
    const choices=el('div','import-choices');dialog.append(choices);
    const rows={};
    const asNew=checkRow({label:'Import as a new song instead',checked:false,id:'import-new',onChange:()=>check(),
      hint:'Adds it as a separate song and leaves the one here untouched.'});
    function render(){
      for(const key of Object.keys(rows))delete rows[key];
      choices.replaceChildren();
      if(incoming.analyzed)rows.analysis=checkRow({label:'Overwrite the analysis and edits',checked:true,id:'import-analysis',onChange:()=>check(),
        hint:target.analyzed?'Use the imported chart, lead sheet, MIDI and edits. The ones on this computer move to Previous transcriptions in the ⋯ menu, so you can bring them back.':'This song isn’t analyzed here yet.'});
      // Stems on both sides: keep or replace. Only in the zip: they are simply added.
      if(incoming.stems&&target.stems)rows.stems=checkRow({label:'Overwrite the stems',checked:false,id:'import-stems',onChange:()=>check(),
        hint:'Use the imported stems. The stems on this computer are deleted (they can always be split again).'});
      if(!incoming.analyzed&&!incoming.stems)choices.append(el('p','choice-text','The imported copy has no analysis or stems, only the recording.'));
      choices.append(...Object.values(rows));
      check();
    }
    dialog.append(asNew);
    let done=false;
    const finish=value=>{if(done)return;done=true;close();resolve(value);};
    const cancel=el('button','secondary choice-cancel','Cancel');cancel.type='button';cancel.onclick=()=>finish(null);
    const go=el('button','btn blue','Import');go.type='button';go.id='import-go';
    check=()=>{
      const fresh=asNew.input.checked;
      for(const row of Object.values(rows)){row.input.disabled=fresh;row.classList.toggle('is-disabled',fresh);}
      go.disabled=!fresh&&!addStems()&&!Object.values(rows).some(row=>row.input.checked);
    };
    go.onclick=()=>{if(go.disabled)return;finish(asNew.input.checked?{mode:'new'}:{mode:'update',target:target.id,analysis:!!rows.analysis?.input.checked,stems:addStems()||!!rows.stems?.input.checked});};
    render();
    actions.append(cancel,go);dialog.append(actions);
    dialog.oncancel=e=>{e?.preventDefault?.();finish(null);};
    dialog.addEventListener?.('close',()=>finish(null));
    show(dialog);
    cancel.focus?.();
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

// Keyboard shortcuts (shortcuts.js): one table per area, keycaps on the left. Esc or Close shuts it.
export function openShortcuts({groups,host=document.body}){
  const {dialog,actions,close}=shell(host,'Keyboard shortcuts');dialog.classList.add('shortcuts-dialog');
  const body=el('div','shortcuts');
  for(const group of groups){
    const section=el('section','shortcut-group');section.append(el('h3','',group.title));
    if(group.note)section.append(el('p','shortcut-note',group.note));
    const list=el('dl','');
    for(const [keys,what] of group.rows){
      const term=el('dt','');for(const key of keys)term.append(['/','–'].includes(key)?el('span','shortcut-or',key):el('kbd','',key));
      list.append(term,el('dd','',what));
    }
    section.append(list);if(group.after)section.append(el('p','shortcut-note',group.after));
    body.append(section);
  }
  const done=el('button','secondary choice-cancel','Close');done.type='button';done.onclick=close;actions.append(done);
  dialog.append(body,actions);dialog.oncancel=e=>{e?.preventDefault?.();close();};
  show(dialog);done.focus?.();
  return {close};
}
