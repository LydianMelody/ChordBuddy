// The parts MIDI setup and Prepare's action screen share, so they look and work alike: Categories | Actions, and the fields of a chosen action.
import {STRIPS} from './mixer-rack.js';
import {helixPresetName} from './performance-actions.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const selectable=(cls,on,text,title,run)=>{const b=el('button',`${cls}${on?' on':''}`,text);b.type='button';b.title=title;b.onclick=run;b.setAttribute('aria-pressed',String(on));return b;};

/** groups: [{id,label,help}]. list(groupId) and search(text): the actions to show, [{id,label,help}]. selected(): the chosen action's id. onPick(item). Returns the panes and paint(). */
export function createPickerPanes({groups,list,search,selected,onPick,groupId=groups[0].id}){
  let query='',group=groupId;
  const field=el('input','midi-search');field.type='search';field.placeholder='Search actions';field.setAttribute('aria-label','Search the actions');
  const nav=el('nav','midi-groups'),items=el('ul','midi-items');nav.setAttribute('aria-label','Categories');
  const groupPane=el('section','midi-pane'),actionPane=el('section','midi-pane');
  groupPane.append(el('h3','vx-cap','Categories'),field,nav);actionPane.append(el('h3','vx-cap','Actions'),items);
  function paintGroups(){
    nav.replaceChildren();
    for(const g of groups)nav.append(selectable('midi-group',!query.trim()&&g.id===group,g.label,g.help,()=>{group=g.id;query='';field.value='';paint();}));
  }
  function paintActions(){
    items.replaceChildren();
    const found=query.trim()?search(query):list(group);
    if(!found.length)items.append(el('li','pf-none','Nothing matches.'));
    for(const item of found){const li=el('li');li.append(selectable('midi-item',item.id===selected(),item.label,item.help,()=>onPick(item)));items.append(li);}
  }
  function paint(){paintGroups();paintActions();}
  field.oninput=()=>{query=field.value;paint();};
  return {groupPane,actionPane,paint,paintActions,show(id){group=id;query='';field.value='';paint();}};
}

/** The rows for an action's fields. fields: [key, kind, label, {options}]. change(next) gets all the values each time one changes. ctx: {scenes(), inputs(wants)}. Returns the rows, in order. */
export function fieldRows(fields,values,change,{scenes=()=>[],inputs=()=>[],names={}}={}){
  let now=values;
  const rows=[],conditional=[];
  const set=(key,value)=>{const next={...now,[key]:value};if(value===undefined)delete next[key];now=next;for(const [row,when] of conditional)row.hidden=!when(now);change(next);};
  const options=(select,choices)=>{for(const [v,t] of choices){const o=el('option','',t);o.value=String(v);select.append(o);}};
  for(const [key,kind,label,o={}] of fields||[]){
    if(kind==='tracks'){
      const box=el('div','midi-tracks');box.setAttribute('role','group');box.setAttribute('aria-label',label);
      for(const strip of STRIPS){const row=el('label','pf-check'),tick=el('input');tick.type='checkbox';tick.checked=(now[key]||[]).includes(strip.key);tick.onchange=()=>{const on=new Set(now[key]);if(tick.checked)on.add(strip.key);else on.delete(strip.key);set(key,STRIPS.map(s=>s.key).filter(k=>on.has(k)));};row.append(tick,el('span','',strip.label));box.append(row);}
      rows.push(el('span','pf-field-name',label),box);continue;
    }
    let control;
    if(kind==='number'||kind==='optional'){
      control=el('input');control.type='number';if(o.min!==undefined)control.min=o.min;if(o.max!==undefined)control.max=o.max;if(o.step!==undefined)control.step=o.step;if(o.placeholder)control.placeholder=o.placeholder;control.value=now[key]??'';
      control.onchange=()=>{
        if(control.value===''&&kind==='optional'){set(key,undefined);return;}
        let v=Number(control.value);if(control.value===''||!Number.isFinite(v)){control.value=now[key]??'';return;}
        v=Math.max(o.min??-Infinity,Math.min(o.max??Infinity,v));if(o.step===undefined||Number.isInteger(o.step))v=Math.round(v);
        control.value=v;set(key,v);
      };
    }
    else if(kind==='helixPreset'){control=el('select');options(control,[['','No change'],...Array.from({length:128},(_,i)=>[i+1,helixPresetName(i+1)])]);control.value=String(now[key]??'');control.onchange=()=>set(key,control.value===''?undefined:Number(control.value));}
    else if(kind==='text'){control=el('input');control.value=now[key]??'';control.onchange=()=>set(key,control.value);}
    else if(kind==='device'){control=el('input');control.setAttribute('list','pf-devices');control.value=now[key]??'';control.onchange=()=>set(key,control.value);}
    else if(kind==='check'){control=el('input');control.type='checkbox';control.checked=!!now[key];control.onchange=()=>set(key,control.checked);}
    else if(kind==='tristate'){control=el('select');options(control,[['','No change'],['on','On'],['off','Off']]);control.value=now[key]===undefined?'':now[key]?'on':'off';control.onchange=()=>set(key,control.value===''?undefined:control.value==='on');}
    else if(kind==='track'){control=el('select');options(control,STRIPS.map(s=>[s.key,s.label]));control.value=now[key];control.onchange=()=>set(key,control.value);}
    else if(kind==='choice'){control=el('select');options(control,o.choices);control.value=String(now[key]);control.onchange=()=>set(key,o.choices.find(([v])=>String(v)===control.value)[0]);}
    else if(kind==='scene'){control=el('select');options(control,scenes().map(s=>[s.id,s.name||s.id]));control.value=now[key]??'';control.onchange=()=>set(key,control.value);}
    else{
      const parts=inputs(o.wants);control=el('select');options(control,[['','Choose…'],...parts]);
      if(now[key]&&!parts.some(([v])=>v===now[key]))options(control,[[now[key],names[now[key]]||now[key]]]);
      control.value=now[key]??'';control.onchange=()=>set(key,control.value);
    }
    const row=el('label','pf-field');row.append(el('span','pf-field-name',label),control);if(o.hint)row.title=o.hint;rows.push(row);
    if(o.when){row.hidden=!o.when(now);conditional.push([row,o.when]);}
  }
  return rows;
}
