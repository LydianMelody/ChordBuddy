// First-run panel: the stem separation models are downloaded once, from public sources, and checked against a fingerprint.
// The panel is built once and only its text and bars change when the status arrives, so a ticked box or a chosen file survives polling.
const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

export function formatBytes(bytes){
  if(!Number.isFinite(bytes)||bytes<=0)return '0 MB';
  if(bytes>=1024**3)return (bytes/1024**3).toFixed(1)+' GB';
  return Math.max(1,Math.round(bytes/1024**2))+' MB';
}

export function mountModelsPanel(root,{onDownload,onCancel,onFile}){
  // The models are only needed to split stems, so the panel stays away until that is asked for (or a download is already running).
  let wanted=false;
  const title=el('h3','','Download the stem separation models');
  const intro=el('p','models-intro');
  const list=el('ul','models-list');
  const ack=el('input');ack.type='checkbox';ack.id='models-ack';
  const ackLabel=el('label','models-ack');ackLabel.append(ack,document.createTextNode(' I have read the license notes above and want to download these models.'));
  const download=el('button','btn hot','Download');download.type='button';download.id='models-download';
  const stop=el('button','btn','Stop');stop.type='button';stop.id='models-stop';
  const pick=el('input');pick.type='file';pick.id='models-file';pick.hidden=true;
  const own=el('button','btn','I already have a file…');own.type='button';own.id='models-own';
  const note=el('p','models-note');note.setAttribute('role','status');
  const actions=el('div','models-actions');actions.append(download,stop,own,pick);
  root.replaceChildren(title,intro,list,ackLabel,actions,note);
  let latest=null,rows=new Map();

  ack.onchange=()=>paint();
  download.onclick=()=>{if(ack.checked)onDownload();};
  stop.onclick=()=>onCancel();
  own.onclick=()=>pick.click();
  pick.onchange=async()=>{const file=pick.files?.[0];pick.value='';if(!file)return;note.textContent='Checking '+file.name+'…';try{await onFile(file);note.textContent='';}catch(error){note.textContent=error?.message||String(error);}};

  function row(model){
    let r=rows.get(model.id);
    if(r)return r;
    const li=el('li','models-item'),head=el('strong','',model.title),role=el('span','models-role',model.role),license=el('p','models-license','License: '+model.license);
    const track=el('div','progress-track'),bar=el('div','progress-bar');track.append(bar);
    const state=el('span','models-state');
    li.append(head,role,license,track,state);list.append(li);
    r={li,bar,state,track};rows.set(model.id,r);return r;
  }

  function paint(){
    const status=latest;if(!status)return;
    root.classList.toggle('hidden',status.ready||!(wanted||status.active||status.models.some(model=>model.error)));
    const missingEngine=status.models.some(model=>!model.environment);
    intro.textContent=`Chord Buddy does not ship the models that split a song into stems. They are downloaded once (${formatBytes(status.bytes_missing)}) from public sources, and every file is checked against a fingerprint, so a wrong or damaged copy is refused.`;
    for(const model of status.models){
      const r=row(model);
      const p=model.progress;
      let text,percent=0;
      if(model.ready){text='Ready';percent=100;}
      else if(p){percent=p.size?Math.round(100*p.done/p.size):0;text=`Downloading ${p.path.split('/').pop()} from ${p.source}… ${formatBytes(p.done)} of ${formatBytes(p.size)}`;}
      else if(model.error){text='Could not finish: '+model.error;}
      else if(!model.environment){text='The separation engine files are missing from this install.';}
      else text=`Waiting · ${formatBytes(model.bytes_missing)} to download`;
      r.state.textContent=text;r.bar.style.width=percent+'%';r.li.classList.toggle('failed',!!model.error&&!p);
    }
    download.disabled=!ack.checked||status.active||missingEngine;
    download.textContent=status.models.some(model=>model.error)?'Try again':'Download '+formatBytes(status.bytes_missing);
    stop.classList.toggle('hidden',!status.active);
    own.disabled=status.active;
  }

  return {update(status){latest=status;if(status)paint();},want(){wanted=true;if(latest)paint();}};
}
