// Prepare's action screen, laid out like MIDI setup, with the same list: Categories | Actions | Details. A new action is added with Add; an action already on the song
// changes as you change it, until Done. A mixer keyframe shows the real mixer: it's the same one as everywhere else, only it writes to the flag.
import {createPickerPanes,fieldRows} from './action-panes.js';
import {checkAction,describeAction} from './performance-actions.js';
import {PLAN_GROUPS,PLAN_ITEMS,itemFor,keyframeFrom,mixOf,searchPlan} from './performance-plan.js';
import {mountMixerDrawer} from './visual-mixer.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,title,run,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.title=title;b.onclick=run;return b;};

/** title; action: the one being changed, or nothing for a new one. ctx: {scenes(), inputs(wants), mix (how the mixer stands here), currentMix(), device}.
 *  onAdd(action) or onChange(action); extras(host, getAction): more of the Details pane; tools: more buttons by Done; onClose. Returns {close, paint}. */
export function openActionEditor({title,action=null,ctx,onAdd=null,onChange=()=>{},extras=null,tools=[],onClose=()=>{},host=document.body}){
  let closed=false,saved=action,item=action?itemFor(action):null,values=item?item.values(action):{};
  const adding=!action;
  const current=()=>item?item.make(values):null;
  const dialog=el('dialog','choice-dialog midi-dialog action-dialog');
  const details=el('div','midi-details');
  const panes=createPickerPanes({groups:PLAN_GROUPS,groupId:item?.group,list:g=>PLAN_ITEMS.filter(i=>i.group===g),search:searchPlan,selected:()=>item?.id,
    onPick:picked=>{item=picked;values=picked.start({...ctx,scenes:ctx.scenes()});changed();panes.paintActions();paintDetails();}});
  const editor=el('div','midi-editor');editor.append(panes.groupPane,panes.actionPane,details);
  const add=adding?button('Add','Put this on the song here',()=>{const made=current();close();onAdd?.(made);},'btn btn-ok'):null;   // the yes of this dialog: green, like OK
  const done=button(adding?'Cancel':'Done',adding?'Close without adding anything':'Close. Your changes are already on the song.',()=>close(),`secondary choice-cancel ${adding?'btn-cancel':'btn-ok'}`);
  const actions=el('div','choice-actions');actions.append(...tools,done,...(add?[add]:[]));   // as in every dialog: Cancel or Done, then the answer last
  const heading=el('h2','',title);
  dialog.append(heading,editor,actions);
  function close(){if(closed)return;closed=true;try{dialog.close?.();}catch{/* already closed */}dialog.remove?.();onClose();}
  dialog.oncancel=event=>{event?.preventDefault?.();close();};
  let preview=null,problem=null;
  function changed(){
    const now=current();
    if(preview)preview.textContent=now?describeAction(now):'';
    const trouble=now?checkAction(now):null;
    if(problem){problem.textContent=trouble||'';problem.hidden=!trouble;}
    if(add)add.disabled=!now||!!trouble;
    if(!adding&&now){saved=now;onChange(now);}
  }
  function paintDetails(){
    details.replaceChildren(el('h3','vx-cap','Details'));
    if(!item){details.append(el('p','pf-none','Choose an action.'));extras?.(details,()=>saved);if(add)add.disabled=true;return;}
    preview=el('p','midi-preview');problem=el('p','pf-problem');problem.hidden=true;
    details.append(preview,el('p','midi-help',item.help),problem);
    if(item.mixer)details.append(...mixerBody());
    else details.append(...fieldRows(item.fields,values,next=>{values=next;changed();},{scenes:ctx.scenes,inputs:ctx.inputs}));
    extras?.(details,()=>saved);
    const now=current();
    preview.textContent=now?describeAction(now):'';
    const trouble=now?checkAction(now):null;problem.textContent=trouble||'';problem.hidden=!trouble;
    if(add)add.disabled=!now||!!trouble;
  }
  function mixerBody(){
    const slot=el('section','pf-mixer vx-mixer');
    const rack=mountMixerDrawer(slot,{send:mix=>{values=keyframeFrom(mix,values.move||'instant');changed();},docked:true,foldable:false});
    rack.element.classList.add('pf-rack');rack.setMix(mixOf(values));
    const row=fieldRows(item.fields,values,next=>{values={...values,move:next.move};changed();});
    const live=button('Use the mixer as it is now','Copy the main mixer’s faders, mutes and solos into this keyframe',()=>{const mix=ctx.currentMix?.();if(!mix)return;values=keyframeFrom(mix,values.move||'instant');rack.setMix(mix);changed();});
    return [...row,slot,live];
  }
  panes.paint();paintDetails();
  host.append(dialog);
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  return {close,paint:paintDetails};
}
