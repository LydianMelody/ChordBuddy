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
export function askChoice({title,message,choices,cancel='Cancel',onPick=()=>{},host=document.body}){
  return new Promise(resolve=>{
    const {dialog,actions,close}=shell(host,title,message,cancel);
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
