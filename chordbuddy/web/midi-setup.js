// MIDI setup, opened from Settings, Prepare and Set lists. One screen, laid out like HX Edit: devices, then every assigned switch, then Categories | Actions | Details and Learn.
// Clicking an assigned switch loads it into the panes below, and changes to it apply as you make them, until Done. With none selected, Learn saves what's in the panes as a new one.
// Every change can be undone (Ctrl+Z, or Undo) while this is open. Okay keeps them all; Cancel puts back everything as it was when it opened.
// Taught switches belong to the app and work anywhere. One switch does one thing. Nothing here sends anything to a device, and pressing a switch while this is open only lights up its row.
import {canTapTempo,inRange,learnControl,placeLearned,rangeClash,valueRange} from './performance-midi.js';
import {COMMAND_GROUPS,COMMANDS,commandById,describeCommand,paramsFor,searchCommands} from './performance-commands.js';
import {createPickerPanes,fieldRows} from './action-panes.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,title,run,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.title=title;b.onclick=run;return b;};
const KIND_HELP='How this switch reports a press. Learn works this out; change it if one press does nothing or does the action twice. Momentary: only pressing counts, not letting go. Latching: every message counts as a press, which also suits a switch that sends one value. A latching switch can also send when a preset loads, which would count too.';
const controlKey=m=>`${m.device}|${m.status}|${m.data1}|${valueRange(m)[0]}`;
const usesRange=m=>(m.status&0xF0)===0xB0||(m.status&0xF0)===0x90;
const heardBy=(event,m)=>{const [s,d=0,v=0]=event.bytes,status=(s&0xF0)===0x80?0x90|(s&15):s;return m.device===event.device&&m.status===status&&m.data1===d&&inRange(m,(s&0xF0)===0x80?0:v);};
const controlName=m=>(m.status&0xF0)===0xB0?`CC ${m.data1}`:(m.status&0xF0)===0x90?`Note ${m.data1}`:(m.status&0xF0)===0xC0?`Program ${m.data1}`:`Message ${m.status} ${m.data1}`;
const rangeWords=m=>usesRange(m)?`${valueRange(m)[0]}–${valueRange(m)[1]}`:'';
const kindWord=m=>m.edge==='every'?'Latching':'Momentary';
const describeControl=(m,withDevice)=>[withDevice?m.device:'',controlName(m),rangeWords(m),`Ch ${(m.status&15)+1}`,kindWord(m)].filter(Boolean).join(' · ');
const selectable=(cls,on,text,title,run)=>{const b=button(text,title,run,`${cls}${on?' on':''}`);b.setAttribute('aria-pressed',String(on));return b;};

/** deps: {api, mappings(), saveMappings(list), showError, scenes(), letGo: names you let go of here, listen(fn): told of every message while open, tapDevice(), setTapDevice(name), tapNow(name), tapSync(name), onClose?, host?}. Returns {close}. */
export function openMidiSetup({api,mappings,saveMappings,showError,scenes=()=>[],letGo=new Set(),listen=()=>{},tapDevice=()=>'',setTapDevice=()=>{},tapNow=async()=>null,tapSync=async()=>null,onClose=()=>{},host=document.body}){
  let closed=false,ports=null,deviceName=null,selected=null,commandId=null,params={},learning=false,message='';
  const dialog=el('dialog','choice-dialog midi-dialog');
  const devices=el('div','midi-devices'),listHead=el('div','midi-head'),list=el('div','midi-assigned');
  const details=el('div','midi-details');
  const panes=createPickerPanes({groups:COMMAND_GROUPS,list:g=>COMMANDS.filter(c=>c.group===g),search:searchCommands,selected:()=>commandId,onPick:c=>{
    const saved=current();commandId=c.id;params=paramsFor(c.id,saved?.command===c.id?saved.params:{});message='';
    if(c.id==='visual-choose'&&!params.scene)params.scene=scenes()[0]?.id??null;
    commit();panes.paintActions();paintDetails();
  }});
  const editor=el('div','midi-editor');editor.append(panes.groupPane,panes.actionPane,details);
  // ---- undo, Okay and Cancel. Assignments save as you make them (so a switch works the moment it's learned); these steps are kept so any can be taken back.
  const atOpen={list:structuredClone(mappings()),tap:tapDevice()};
  const past=[],future=[];let lastStep={key:null,at:0};
  /** Save the assignments, remembering how they were. Quick changes to one thing (typing a value) are one step. */
  function save(list,key=null){
    const now=Date.now();
    if(!(key&&key===lastStep.key&&now-lastStep.at<1500)){past.push(structuredClone(mappings()));if(past.length>200)past.shift();}
    lastStep={key,at:now};future.length=0;
    saveMappings(list);paintUndo();
  }
  function step(from,to){
    if(learning||!from.length)return;
    to.push(structuredClone(mappings()));saveMappings(from.pop());lastStep={key:null,at:0};
    if(!current())selected=null;select(selected);paintUndo();
  }
  const undoB=button('Undo','Take back your last change here (Ctrl+Z)',()=>step(past,future),'secondary'),redoB=button('Redo','Put back the change you took back (Ctrl+Shift+Z)',()=>step(future,past),'secondary');
  function paintUndo(){undoB.disabled=!past.length;redoB.disabled=!future.length;}
  const cancelB=button('Cancel','Close and undo every change made since this window opened',null,'secondary choice-cancel btn-cancel'),okB=button('Okay','Keep these assignments and close',null,'btn btn-ok');
  const actions=el('div','choice-actions midi-actions');actions.append(undoB,redoB,el('span','vx-gap'),cancelB,okB);
  dialog.append(el('h2','','MIDI devices and foot switches'),devices,listHead,list,editor,actions);
  const close=()=>{if(closed)return;closed=true;document.removeEventListener?.('keydown',onUndoKey,true);try{dialog.close?.();}catch{/* already closed */}dialog.remove?.();onClose();};
  const changed=()=>JSON.stringify(mappings())!==JSON.stringify(atOpen.list)||tapDevice()!==atOpen.tap;
  cancelB.onclick=()=>{if(changed()){saveMappings(atOpen.list);if(tapDevice()!==atOpen.tap)setTapDevice(atOpen.tap);}close();};
  okB.onclick=close;
  // Esc keeps what you did, as closing always has: undoing everything takes a deliberate Cancel
  dialog.oncancel=event=>{event?.preventDefault?.();close();};
  // on the whole page while this is open: after Forget or Learn the button you pressed is gone, and the key arrives from the page behind
  function onUndoKey(event){
    if(closed||!(event.ctrlKey||event.metaKey)||event.altKey)return;
    const key=String(event.key).toLowerCase(),redo=(key==='z'&&event.shiftKey)||(key==='y'&&!event.shiftKey);
    if(!redo&&!(key==='z'&&!event.shiftKey))return;
    if(/^(INPUT|TEXTAREA)$/.test(event.target.tagName)&&!['checkbox','radio','range'].includes(event.target.type))return;   // a text box undoes its own typing
    event.preventDefault();event.stopPropagation();redo?step(future,past):step(past,future);
  }
  document.addEventListener?.('keydown',onUndoKey,true);

  const current=()=>mappings().find(m=>controlKey(m)===selected)||null;
  const isOpen=()=>!!ports?.available&&ports.inputs.some(p=>p.open);
  async function look(){try{ports=await api('/api/midi/ports');if(!closed){paintDevices();paintDetails();}}catch(error){showError(error);}}

  // ---- devices
  function paintDevices(){
    devices.replaceChildren();
    if(!ports){devices.append(el('p','pf-none','Looking for devices…'));return;}
    if(!ports.available){devices.append(el('p','pf-note',ports.reason));return;}
    const names=[...new Set([...ports.outputs,...ports.inputs].map(p=>p.name))],isConnected=name=>ports.outputs.concat(ports.inputs).some(p=>p.name===name&&p.open);
    if(!names.includes(deviceName))deviceName=names.find(n=>ports.inputs.some(p=>p.name===n&&p.open))??names.find(isConnected)??null;
    const pick=el('select','midi-device');pick.setAttribute('aria-label','MIDI device');pick.title='Choose a device to connect to it. Nothing is sent to it until a show or a preview does. A device with assigned switches stays connected when you choose another.';
    const none=el('option','',names.length?'Choose a device…':'No MIDI devices found');none.value='';pick.append(none);pick.disabled=!names.length;
    for(const name of names){const o=el('option','',isConnected(name)?`${name} (connected)`:name);o.value=name;pick.append(o);}
    pick.value=deviceName??'';
    pick.onchange=async()=>{deviceName=pick.value||null;if(!deviceName)return;letGo.delete(deviceName);try{const r=await api('/api/midi/connect',{name:deviceName});if(r.error)showError(Error(r.error));await look();}catch(error){showError(error);}};
    const label=el('label','midi-device-pick');label.append(el('span','vx-cap','Device'),pick);devices.append(label);
    if(deviceName&&isConnected(deviceName))devices.append(button('Disconnect','Let go of this device so another program can use it',async()=>{letGo.add(deviceName);if(tapDevice()===deviceName)setTapDevice('');try{const r=await api('/api/midi/disconnect',{name:deviceName});if(r.error)showError(Error(r.error));await look();}catch(error){showError(error);}}));
    const monitor=el('pre','pf-monitor');monitor.hidden=true;
    const watching=button('Watch incoming MIDI','For 20 seconds, list every message arriving from connected devices, to check they reach this computer. Nothing is sent.',async()=>{
      monitor.hidden=false;monitor.textContent='Listening…';watching.disabled=true;
      try{
        let {last}=await api('/api/midi/events?after=999999999');const lines=[],deadline=Date.now()+20000;
        while(Date.now()<deadline&&!closed){const r=await api(`/api/midi/events?after=${last}&wait=1`);last=r.last;for(const e of r.events)lines.push(`${e.device}: ${e.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')}`);monitor.textContent=lines.length?lines.slice(-12).join('\n'):'Listening… nothing yet.';}
        const status=await api('/api/midi/status'),clocks=Object.entries(status.clock_in||{}).filter(([,c])=>c.seconds_ago<3).map(([n])=>n);
        const clockLine=clocks.length?`MIDI clock is arriving from ${clocks.join(', ')}, so it is reaching this computer.`:'';
        monitor.textContent=lines.length?[`${lines.length} messages:`,...lines.slice(-12),clockLine].filter(Boolean).join('\n'):clockLine?`${clockLine}\nNothing else arrived: no buttons or foot switches pressed.`:'Nothing arrived. Its clock may be off, and a foot switch only sends once it’s set up on the device.';
      }catch(error){monitor.textContent=error.message;}
      watching.disabled=false;
    });
    if(deviceName&&canTapTempo(deviceName)){
      const auto=el('label','pf-check midi-tap'),tick=el('input');tick.type='checkbox';tick.checked=tapDevice()===deviceName;
      auto.title='Keeps this device on the song’s tempo, sending only changes. It reads the device’s tempo when you turn this on and when a song first plays, and taps only if that’s different. It also taps when the song’s tempo map moves or you change the speed. Between changes it leaves the tempo alone, so you can still tap your own. The Virtual tap tempo action goes back to the song’s tempo.';
      const said=el('small','midi-tap-said');said.setAttribute('role','status');
      tick.onchange=async()=>{
        const name=deviceName;
        setTapDevice(tick.checked?name:'');said.textContent='';
        if(!tick.checked)return;
        if(!isConnected(name)){letGo.delete(name);try{const r=await api('/api/midi/connect',{name});if(r.error)showError(Error(r.error));await new Promise(done=>setTimeout(done,2000));}catch(error){showError(error);return;}}   // long enough to hear its clock
        const result=await tapSync(name);
        if(closed)return;
        const words=result?(result.tapped?`Tapped ${result.bpm} BPM`:`Already at ${result.bpm} BPM`):'It will tap when a song plays.';
        await look();devices.querySelector('.midi-tap-said')?.replaceChildren(words);
      };
      auto.append(tick,el('span','','Follow song’s tempo map'));
      const now=button('Tap now','Tap the open song’s tempo into this device now, at the speed it’s playing. Handy after tapping your own.',async()=>{
        now.disabled=true;
        const bpm=await tapNow(deviceName);
        said.textContent=bpm?`Tapped ${bpm} BPM`:'Open an analyzed song first.';
        now.disabled=false;
      });
      now.disabled=!isConnected(deviceName);
      devices.append(auto,now,said);
    }
    const tools=el('div','pf-add-actions');tools.append(button('Look again','List the MIDI devices again, after plugging one in',()=>look()),watching);
    devices.append(tools,monitor);
  }

  // ---- the assigned switches
  function paintList(){
    list.replaceChildren();
    const all=mappings();
    if(!all.length){list.append(el('p','pf-none','Nothing assigned yet. Choose an action below, then press Learn.'));return;}
    const severalDevices=new Set(all.map(m=>m.device)).size>1;
    for(const mapping of all){
      const key=controlKey(mapping),words=describeCommand(mapping.command,mapping.params,scenes()),control=describeControl(mapping,severalDevices),row=selectable('midi-row',key===selected,'',`${words}. ${mapping.device}: ${control}. Click to edit it below.`,()=>select(key===selected?null:key));row.dataset.control=key;
      row.append(el('strong','',words),el('small','',control));
      list.append(row);
    }
  }
  function select(key){
    if(learning)return;
    selected=key;message='';
    const m=current();
    if(m&&commandById(m.command)){commandId=m.command;panes.show(commandById(m.command).group);params=paramsFor(m.command,m.params);}else if(!m){commandId=null;params={};}
    paint();
  }
  /** The selected switch takes on what's in the panes, as you change it. */
  function commit(){
    if(!selected||!commandId)return;
    save(mappings().map(m=>controlKey(m)===selected?{...m,command:commandId,params}:m),`params:${selected}:${commandId}`);paintList();
  }

  // ---- details and Learn
  function paintDetails(){
    details.replaceChildren();
    const command=commandById(commandId),mapping=current();
    details.append(el('h3','vx-cap','Details'));
    if(!command){details.append(el('p','pf-none','Choose an action.'));if(mapping)details.append(forget(mapping));return;}
    const preview=el('p','midi-preview');
    const paintPreview=()=>{preview.textContent=describeCommand(commandId,params,scenes());};
    details.append(preview,el('p','midi-help',command.help));
    details.append(...fieldRows(command.params,params,next=>{params=next;paintPreview();commit();refresh();},{scenes}));
    paintPreview();
    details.append(el('h3','vx-cap','MIDI'));
    const line=el('div','pf-add-actions');
    const status=el('p','midi-status',message);status.setAttribute('role','status');
    const learn=button('Learn',mapping?'Assign a different switch to this action: press this, then tap the switch twice, fairly quickly.':'Press this, then tap the switch twice, fairly quickly. Two taps tell Chord Buddy which control it is and whether it’s Momentary or Latching.',()=>runLearn(learn,status),'btn blue');
    line.append(learn);
    if(mapping){
      line.append(el('small','',[mapping.device,controlName(mapping),`Ch ${(mapping.status&15)+1}`,mapping.values?.length>1?`Learned values ${mapping.values.join(' and ')}`:Number.isFinite(mapping.value)?`Learned value ${mapping.value}`:''].filter(Boolean).join(' · ')));
      const type=el('select');type.setAttribute('aria-label','Switch type');type.title=KIND_HELP;
      for(const [v,t] of [['press','Momentary'],['every','Latching']]){const o=el('option','',t);o.value=v;type.append(o);}type.value=mapping.edge==='every'?'every':'press';
      type.onchange=()=>{save(mappings().map(m=>controlKey(m)===selected?{...m,edge:type.value}:m));paintList();};
      line.append(type);
      if(usesRange(mapping))line.append(rangeFields(mapping,status));
      line.append(forget(mapping),button('Done','Finish changing this switch, so the panes are ready for another one',()=>select(null),'btn btn-ok'));
    }
    details.append(line,status);
    const refresh=()=>{const needsTracks=(command.params||[]).some(([,k])=>k==='tracks');learn.disabled=learning||!isOpen()||(needsTracks&&!params.tracks?.length)||(commandId==='visual-choose'&&!params.scene);learn.title=isOpen()?learn.title:'Connect a device above first.';};
    refresh();
  }
  /** The values this switch answers to. Ranges on one control can't overlap: a change that would is refused, and says which one is in the way. */
  function rangeFields(mapping,status){
    const box=el('span','midi-range');box.title='Which values this assignment answers to, 0 to 127. Split them to give one CC several actions: for example 0–63 and 64–127. Ranges on one CC can’t overlap.';
    const [lo,hi]=valueRange(mapping),number=(value,label)=>{const i=el('input');i.type='number';i.min=0;i.max=127;i.value=value;i.setAttribute('aria-label',label);return i;};
    const from=number(lo,'Lowest value'),to=number(hi,'Highest value');
    const apply=()=>{
      const a=Number(from.value),b=Number(to.value),put=text=>{status.textContent=text;};
      if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b>127||a>b){from.value=valueRange(current())[0];to.value=valueRange(current())[1];put('A range goes from a lower value to a higher one, within 0 to 127.');return;}
      const all=mappings(),me=all.find(m=>controlKey(m)===selected),clash=rangeClash(all,me,[a,b]);
      if(clash){from.value=valueRange(me)[0];to.value=valueRange(me)[1];put(`That overlaps ${describeCommand(clash.command,clash.params,scenes())} (${rangeWords(clash)}).`);return;}
      const next={...me,range:[a,b]};
      save(all.map(m=>m===me?next:m));selected=controlKey(next);paintList();
      const missed=(next.values?.length?next.values:Number.isFinite(next.value)?[next.value]:[]).filter(v=>!inRange(next,v));
      put(missed.length?`This switch sends ${missed.join(' and ')}, outside this range, so ${missed.length===1?'that':'those'} won’t do anything until you change one of them.`:'');
    };
    from.onchange=apply;to.onchange=apply;
    box.append(el('span','pf-field-name','Value range'),from,el('span','','to'),to);
    return box;
  }
  const forget=mapping=>button('Forget','Stop this switch doing anything',()=>{save(mappings().filter(m=>controlKey(m)!==controlKey(mapping)));select(null);});
  async function runLearn(learn,status){
    learning=true;learn.disabled=true;learn.textContent='Tap it twice…';status.textContent='';
    try{
      const {mapping,heard}=await learnControl(api,commandId,{stop:()=>closed,onHeard:()=>{learn.textContent='Once more…';}});
      if(closed)return;
      if(!mapping){message=heard?'Heard that only once. Tap the same switch twice, fairly quickly.':'Nothing arrived. Check the switch is set to send MIDI.';return;}
      mapping.params=params;
      const {list:placed,replaced,split}=placeLearned(mappings().filter(m=>controlKey(m)!==selected),mapping),saved=placed.at(-1);
      save(placed);selected=null;
      const warn=(mapping.status&0xF0)===0xB0&&(mapping.data1===0||mapping.data1===32)?` CC ${mapping.data1} can also arrive when a preset changes, so another number is safer.`:'';
      message=`Learned ${controlName(saved)}, value ${saved.value??'none'}: ${kindWord(saved)}${usesRange(saved)?`, range ${rangeWords(saved)}`:''}.${replaced?` It replaces ${describeCommand(replaced.command,replaced.params,scenes())}, which sent the same value.`:''}${split?` ${describeCommand(split.command,split.params,scenes())} now has ${rangeWords(split)}.`:''}${warn}`;
    }catch(error){showError(error);}
    finally{learning=false;if(!closed)paint();}
  }

  function paint(){
    listHead.replaceChildren();
    const head=el('h3','vx-cap','Assigned');head.title='To send a message to a device at a certain bar, like changing a preset at the chorus, add a MIDI action in Prepare instead.';
    listHead.append(head,el('small','','Press a switch to light up its row. Nothing runs while this window is open.'));
    paintList();panes.paint();paintDetails();
  }

  listen(event=>{
    for(const node of list.querySelectorAll('.midi-row')){
      if(mappings().some(m=>controlKey(m)===node.dataset.control&&heardBy(event,m))){node.classList.remove('heard');void node.offsetWidth;node.classList.add('heard');}
    }
  });
  paintDevices();paint();
  host.append(dialog);
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  paintUndo();okB.focus?.();look();
  return {close};
}
