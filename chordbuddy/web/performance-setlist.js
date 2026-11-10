// What a set list needs for the stage, built onto the set list in the sidebar: under each song, its arrangement and how it starts; above the songs, the
// set list's settings. Perform itself is on the Perform tab. The sidebar stays the one list of songs: order and membership change there, and this follows. These details live in a record tied to the list (`list-<id>`).
import {askChoice} from './dialogs.js';
import {icon} from './icons.js';
import {clockText,countInOf,showSeconds,spareText} from './performance-duration.js';
/** A count-in in bars. One saved in beats, from before, counts as whole bars of 4 until its song's meter is known. */
const countBarsOf=t=>t?.countBars>0?Math.round(t.countBars):t?.countBeats>0?Math.ceil(t.countBeats/4):0;
/** A song's count-in choice in this set: 'own' (its arrangement's or its own), or 0, 1 or 2 bars. */
const countChoice=t=>t?.countBars!==undefined||t?.countBeats!==undefined?Math.min(2,countBarsOf(t)):'own';
const withCount=(t,choice)=>{const {countBars,countBeats,...rest}=t||{};void countBars;void countBeats;const base={kind:'immediate',seconds:0,...rest,countIn:0};return choice==='own'?base:{...base,countBars:choice};};
/** Song's own · Off · 1 bar · 2 bars, as buttons like the count-in under the mixer. own: what Song's own comes to, said on its button. */
function countButtons(value,onPick,own=0){
  const group=el('div','seg pf-count');group.setAttribute('role','group');
  for(const [v,words] of [['own',own===null?'Song’s own':`Song’s own (${['off','1 bar','2 bars'][own]??'off'})`],[0,'Off'],[1,'1 bar'],[2,'2 bars']]){
    const b=el('button',value===v?'on':'',words);b.type='button';b.setAttribute('aria-pressed',String(value===v));b.onclick=()=>onPick(v);group.append(b);
  }
  return group;
}
/** The count-in a song gets in this show: the one the set list gave it, or else its arrangement's. */
const countOf=(t,length)=>t?.countBars!==undefined||t?.countBeats!==undefined?t:(length?.countBars??0);
import {defaultPolicy,newShow} from './performance-model.js';
import {POLICIES} from './performance-model.js';
import {POLICY_LABELS,applyListDiff,clockValue,nextTimeOfDay} from './performance-prepare.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const btn=(cls,text,title,run,iconName)=>{const b=el('button','btn '+cls,text);b.type='button';if(iconName)b.insertAdjacentHTML('afterbegin',icon(iconName));if(title)b.title=title;if(run)b.onclick=run;return b;};
const uid=()=>globalThis.crypto.randomUUID().replaceAll('-','').slice(0,16);
const START_WORDS=[['immediate','Right after the last song'],['gap','After a gap'],['control','When you press Next song']];
const startWord=kind=>START_WORDS.find(([v])=>v===kind)?.[1]||START_WORDS[0][1];
const keyOf=(e,performances)=>`${e.songId}|${e.performanceId}|${performances?.get(e.songId)?.find(p=>p.id===e.performanceId)?.updated??''}`;   // remeasured when the arrangement changes
const field=(labelText,control,help)=>{const row=el('label','pf-field');row.append(el('span','pf-field-name',labelText),control);if(help)row.title=help;return row;};
const numberField=(value,min,max,onChange,optional=false)=>{const i=el('input');i.type='number';i.min=min;i.max=max;i.value=value;i.onchange=()=>{if(i.value===''&&optional){onChange(null);return;}const v=Number(i.value);if(Number.isFinite(v))onChange(v);};return i;};
const pick=(choices,value,label)=>{const s=el('select');s.setAttribute('aria-label',label);for(const [v,t] of choices){const o=el('option','',t);o.value=v;s.append(o);}s.value=value;return s;};

/** deps: {api, scenes(), setlists(), refresh(), redraw(): draw the sidebar again, onPerform(show), onMidiSetup(after), entryLength(entry), showError}. */
export function createSetlistPanel(deps){
  const {api}=deps;
  let listId=null,record=null,show=null,opening=null,timer=null,performances=new Map(),lengths=new Map(),expanded=new Set(),ports=null;
  const currentList=()=>deps.setlists().find(l=>l.id===listId)||null;

  /** Called each time the sidebar draws: the list on screen, with what's in it now. */
  function sync(id){
    if(id==='default'||!id){listId=null;record=null;show=null;return;}
    if(id!==listId){open(id);return;}
    const list=currentList();if(!show||!list||opening)return;
    const wanted=list.song_ids,have=show.entries.map(e=>e.songId);
    if(wanted.length===have.length&&wanted.every((s,i)=>s===have[i])&&list.name===show.name)return;
    show={...applyListDiff(show,wanted,uid),name:list.name,sourceList:id};queueDraft();loadFacts().then(deps.redraw);
  }
  async function open(id){
    listId=id;record=null;show=null;expanded=new Set();
    const list=currentList();if(!list)return;
    const ask=opening=(async()=>{
      const showId='list-'+id;
      let r;try{r=await api('/api/show/'+encodeURIComponent(showId));}
      catch{await api('/api/show/save',{body:{...newShow({name:list.name,sourceList:id,id:showId}),entries:[]},base:0});r=await api('/api/show/'+encodeURIComponent(showId));}
      if(listId!==id)return;
      const had=r.draft||r.body,matched={...applyListDiff(had,list.song_ids,uid),name:list.name,sourceList:id};
      record=r;show=matched;
      if(JSON.stringify(matched)!==JSON.stringify(had))queueDraft();
      await loadFacts();
    })().catch(deps.showError).finally(()=>{if(opening===ask)opening=null;deps.redraw();});
  }
  function queueDraft(){clearTimeout(timer);timer=setTimeout(saveDraft,600);}
  async function saveDraft(){if(!record||!show)return;try{await api('/api/show/draft',{body:show,base:record.head});}catch(error){deps.showError(error);}}
  function change(next){show=next;queueDraft();deps.redraw();}
  async function loadFacts(){
    if(!show)return;
    await Promise.all([...new Set(show.entries.map(e=>e.songId))].map(async id=>{try{performances.set(id,await api('/api/performances/'+encodeURIComponent(id)));}catch{performances.set(id,[]);}}));
    await Promise.all(show.entries.map(async e=>{if(lengths.has(keyOf(e,performances)))return;try{lengths.set(keyOf(e,performances),await deps.entryLength(e));}catch{lengths.set(keyOf(e,performances),null);}}));
  }
  const entryChange=(id,patch)=>{const next=structuredClone(show);Object.assign(next.entries.find(e=>e.id===id),patch);change(next);loadFacts().then(deps.redraw);};
  function totals(){
    return showSeconds(show.entries.map((e,i)=>({segments:lengths.get(keyOf(e,performances))?.segments||[],transition:i===0?null:e.transition||show.transitions,lead:countInOf(lengths.get(keyOf(e,performances))?.measures,countOf(e.transition||show.transitions,lengths.get(keyOf(e,performances)))).lead})));
  }
  async function perform(){
    if(!show?.entries.length)return;
    clearTimeout(timer);
    try{const r=await api('/api/show/save',{body:show,base:record.head});record={...record,...r};deps.onPerform(r.body);}catch(error){deps.showError(error);}
  }

  /** The settings, under the list's name in the sidebar. */
  function head(){
    const row=el('div','set-head');
    const gear=btn('set-settings','Set list settings','This set list’s time slot, what happens when you change something by hand, its name and more',()=>openSettings(),'gear');gear.disabled=!show;
    row.append(gear);
    return row;
  }
  /** The times, in the sidebar's total line. Null until they're known. */
  function totalLine(){
    if(!show)return null;
    const t=totals(),parts=[`${clockText(t.music)} music`];
    if(t.gaps+t.holds>0)parts.push(`${clockText(t.gaps+t.holds)} gaps`);
    parts.push(t.unknown?`${clockText(t.planned)} and a wait`:`${clockText(t.planned)} total`);
    if(show.target?.slotSeconds)parts.push(spareText(show.target.slotSeconds-t.planned));
    else if(Number.isFinite(show.target?.finishAtEpoch))parts.push(spareText((show.target.finishAtEpoch-Date.now())/1000-t.planned));
    return parts.join(' · ');
  }
  /** Under a song in the sidebar: a line saying how it plays, which opens to change it. */
  function rowDetails(songId,title){
    const index=show?.entries.findIndex(e=>e.songId===songId)??-1;if(index<0)return null;
    const e=show.entries[index],saved=performances.get(e.songId)||[],mine=saved.find(p=>p.id===e.performanceId),length=lengths.get(keyOf(e,performances)),isOpen=expanded.has(e.id);
    const box=el('div','set-extra'+(isOpen?' open':''));box.dataset.entry=e.id;
    const summary=el('button','set-summary');summary.type='button';summary.setAttribute('aria-expanded',String(isOpen));summary.title=`How ${title} plays in this set: its arrangement and how it starts. Click to change them.`;
    const words=[mine?.name??(e.performanceId?'Older arrangement':'Original arrangement'),index===0?'Starts when you press Start':startWord(e.transition?.kind)];
    if(e.transition?.kind==='gap'&&index>0)words[1]=`${e.transition.seconds??5} second gap`;
    const countBars=countInOf(length?.measures,countOf(e.transition,length)).bars;
    if(countBars>0)words.push(`${countBars} bar count-in`);
    if(length)words.push(clockText(length.music));
    summary.append(el('span','',words.join(' · ')));
    if(length?.live){const dot=el('em','set-flag','•');dot.title='Needs you there: it has a loop or a wait until you release it';summary.append(dot);}
    summary.onclick=()=>{if(isOpen)expanded.delete(e.id);else expanded.add(e.id);deps.redraw();};
    box.append(summary);
    if(!isOpen)return box;
    const options=[['','Original arrangement'],...saved.map(p=>[p.id,p.name])];
    const value=e.performanceId||'';
    const which=pick(options,value,`Which arrangement of ${title}`);which.title='Which arrangement this set plays. It plays the arrangement as it is now in Prepare, including changes you haven’t saved.';
    which.onchange=()=>{const id=which.value||null;entryChange(e.id,{performanceId:id,revision:id?saved.find(p=>p.id===id).head:null});};
    box.append(field('Arrangement',which));
    if(index>0){
      const gap=pick(START_WORDS,e.transition?.kind||'immediate',`How ${title} starts`);
      gap.onchange=()=>entryChange(e.id,{transition:{...e.transition,kind:gap.value,seconds:gap.value==='gap'?(e.transition?.seconds??5):0,expected:gap.value==='control'?30:undefined}});
      box.append(field('Starts',gap));
      if(gap.value==='gap')box.append(field('Gap (seconds)',numberField(e.transition?.seconds??5,0,600,v=>entryChange(e.id,{transition:{...e.transition,kind:'gap',seconds:v}})),'Seconds of silence before this song'));
    }
    box.append(field('Count-in',countButtons(countChoice(e.transition),v=>entryChange(e.id,{transition:withCount(e.transition,v)}),length?.countBars??0),'Clicks before this song starts, in its own meter and tempo, ending on bar 1. Song’s own uses what its arrangement or the song itself has. Off for a song whose backing track has its own intro. Only you hear it.'));
    if(length?.live)box.append(el('small','pf-note-plain','Needs you there: it has a loop or a wait that lasts until you release it, so the finish time is an estimate.'));
    return box;
  }

  // ---- the set list's settings
  function openSettings(){
    if(!show)return;
    const dialog=el('dialog','choice-dialog pf-settings-dialog');
    const finish=()=>{try{dialog.close();}catch{/* already closed */}dialog.remove();};
    dialog.oncancel=event=>{event.preventDefault();finish();};
    const body=el('div','pf-settings');dialog.append(el('h2','','Set list settings'),body);
    const set=edit=>{const next=structuredClone(show);edit(next);change(next);};
    const slotMinutes=show.target?.slotSeconds?show.target.slotSeconds/60:'';
    const nameInput=el('input');nameInput.value=show.name;nameInput.onchange=async()=>{const name=nameInput.value.trim();if(!name||name===show.name){nameInput.value=show.name;return;}try{await api('/api/setlist/rename',{id:listId,name});await deps.refresh();set(n=>{n.name=name;});}catch(error){nameInput.value=show.name;deps.showError(error);}};
    body.append(field('Name',nameInput));
    body.append(field('Slot length (minutes)',numberField(slotMinutes,0,600,v=>set(n=>{n.target=v?{slotSeconds:v*60}:null;}),true),'How long you have, counted from when you press Start. The clocks count down to this during the show.'));
    const finishAt=el('input');finishAt.type='time';finishAt.value=Number.isFinite(show.target?.finishAtEpoch)?clockValue(show.target.finishAtEpoch):'';
    finishAt.onchange=()=>set(n=>{n.target=finishAt.value?{finishAtEpoch:nextTimeOfDay(finishAt.value,Date.now()),finishText:finishAt.value}:null;});
    body.append(field('Or finish by (clock time)',finishAt,'A time on the clock instead of a length. The next time it comes round. Setting this replaces the slot length.'));
    const every=pick(START_WORDS,'immediate','How every song starts'),everySeconds=numberField(5,0,600,()=>{});everySeconds.setAttribute('aria-label','Gap in seconds for every song');
    const everyRow=el('div','pf-add-actions');everyRow.append(every,everySeconds,btn('','Set for every song','Give every song after the first this start',()=>set(n=>{for(const e of n.entries)e.transition={kind:every.value,seconds:every.value==='gap'?Number(everySeconds.value)||0:0,expected:every.value==='control'?30:undefined,countIn:e.transition?.countIn??0,...(e.transition?.countBars!==undefined?{countBars:e.transition.countBars}:{}),...(e.transition?.countBeats!==undefined?{countBeats:e.transition.countBeats}:{})};})));
    body.append(el('h3','vx-cap','How songs start'),everyRow);
    body.append(el('h3','vx-cap','Count-in for every song'),countButtons(null,v=>set(n=>{for(const e of n.entries)e.transition=withCount(e.transition,v);}),null),
      el('p','pf-hint','Gives every song in this set the same count-in. Song’s own goes back to each song’s own. You can still change one song in its details.'));
    // what each song shows on your screen during the show, under its controls: the chord chart unless you choose the lead sheet
    const view=pick([['chart','Chord chart'],['abc','Lead sheet']],show.view==='abc'?'abc':'chart','What each song shows during the show');view.onchange=()=>set(n=>{n.view=view.value==='abc'?'abc':'chart';});
    body.append(field('Show each song as',view,'What you read on your screen during the show. A song without a lead sheet shows its chord chart. The editing tools are put away while a show runs.'));
    const keep=el('input');keep.type='checkbox';keep.checked=!!show.keepVisualsWhenMuted;keep.onchange=()=>set(n=>{n.keepVisualsWhenMuted=keep.checked;});
    body.append(field('Keep visuals when a stem is muted',keep,'Off: muting a stem also stops what it moves in the visuals. On: its visuals keep going, handy when you play that part yourself.'));
    const carry=el('input');carry.type='checkbox';carry.checked=!!show.carryOverrides;carry.onchange=()=>set(n=>{n.carryOverrides=carry.checked;});
    body.append(field('Keep live changes into the next song',carry,'Off: each song starts from its plan. On: what you changed by hand stays until you release it.'));
    const clockDevice=el('input');clockDevice.setAttribute('list','pf-show-devices');clockDevice.value=show.midiClock?.device||'';clockDevice.placeholder='Off';clockDevice.onchange=()=>set(n=>{n.midiClock=clockDevice.value.trim()?{device:clockDevice.value.trim()}:null;});
    body.append(field('Send MIDI clock to',clockDevice,'A device name, for gear that follows MIDI clock. A Helix’s delays can warp while receiving clock, so use Virtual tap tempo in MIDI setup for a Helix. Leave empty for none.'));
    body.append(el('h3','vx-cap','When you change something by hand'));
    const policy=show.policy||defaultPolicy();
    const policySelect=(key,label)=>{const s=pick([...(key==='all'?[]:[['','Same as above']]),...POLICIES.map(v=>[v,POLICY_LABELS[v]])],policy[key]||'',label);s.onchange=()=>set(n=>{n.policy={...policy,[key]:s.value||null};});return field(label,s);};
    body.append(policySelect('all','Usually'),policySelect('tracks','Tracks'),policySelect('visuals','Visuals'),policySelect('midi','MIDI'),policySelect('rate','Speed'));
    body.append(el('h3','vx-cap','MIDI devices'));
    const portList=el('div','pf-ports');body.append(portList);drawPorts(portList);if(!ports)findPorts(portList);
    const importInput=el('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.onchange=()=>{finish();importShow(importInput);};
    const tools=el('div','choice-actions');
    const close=el('button','secondary choice-cancel','Close');close.type='button';close.onclick=finish;
    tools.append(btn('','Export to a file','Save this set list and its arrangements to a file, to keep or to use on another computer. The recordings aren’t included.',()=>exportShow()),btn('','Import from a file…','Bring in a set list from a file, as a new set list. Its songs must already be in this library.',()=>importInput.click()),btn('danger','Delete…','Remove this set list. Its songs stay in your library.',()=>{finish();remove();}),importInput,close);
    dialog.append(tools);document.body.append(dialog);dialog.showModal();
  }
  async function findPorts(node){try{ports=await api('/api/midi/ports');drawPorts(node);}catch(error){deps.showError(error);}}
  function drawPorts(node){
    node.replaceChildren(el('p','pf-none','Tick a device if this set can’t run without it. Connect devices and teach foot switches in MIDI setup.'),btn('','MIDI setup','Connect a pedal or controller, and teach its switches to run Chord Buddy during a show',()=>deps.onMidiSetup(()=>findPorts(node))));
    if(!ports?.available)return;
    const all=ports.outputs.concat(ports.inputs);
    // only the ones that matter to this set: connected now, or already marked as needed
    for(const name of [...new Set(all.map(p=>p.name))].filter(n=>all.some(p=>p.name===n&&p.open)||show?.devices?.find?.(d=>d.name===n&&d.critical))){
      const row=el('div','pf-port'),on=all.some(p=>p.name===name&&p.open);
      const needs=el('label','pf-check'),box=el('input');box.type='checkbox';box.checked=!!show?.devices?.find?.(d=>d.name===name&&d.critical);
      box.onchange=()=>{const next=structuredClone(show);next.devices=[...(next.devices||[]).filter(d=>d.name!==name),...(box.checked?[{name,critical:true}]:[])];change(next);};
      needs.append(box,el('span','','This set needs it'));needs.title='Ticked: the set won’t start without it, and stops at the next bar if it’s disconnected. Not ticked: the set plays on without it and lists what it missed.';
      row.append(el('span','',name),el('small','',on?'Connected':'Not connected'),needs);node.append(row);
    }
  }
  async function remove(){
    const list=currentList();if(!list)return;
    if(await askChoice({title:`Delete the set list “${list.name}”?`,message:'Your songs stay in your library, and so do their arrangements.',choices:[{id:'remove',label:'Delete',kind:'danger'}]})!=='remove')return;
    try{clearTimeout(timer);if(record)await api('/api/show/delete',{id:record.id});await api('/api/setlist/delete',{id:list.id});record=null;show=null;listId=null;await deps.refresh();}catch(error){deps.showError(error);}
  }
  async function exportShow(){
    if(!record)return;
    try{const bundle=await api(`/api/show/${encodeURIComponent(record.id)}/export`);const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,1)],{type:'application/json'}));const a=el('a');a.href=url;a.download=`${show.name.replace(/[\\/:*?"<>|]/g,'-')}.show.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
    catch(error){deps.showError(error);}
  }
  async function importShow(input){
    const file=input.files?.[0];if(!file)return;
    try{
      if(file.size>8*1024*1024)throw Error('That file is too large to be a set list.');
      const bundle=JSON.parse(await file.text()),r=await api('/api/show/import',{bundle});
      if(r.missing_songs?.length){await askChoice({title:'Some songs aren’t in this library',message:[`Import these first, then import the set list again: ${r.missing_songs.map(x=>x.title||x.id).join(', ')}.`],choices:[],cancel:'OK'});return;}
      const installed=new Set((deps.scenes?.()||[]).map(x=>x.id)),absent=(r.required_scenes||[]).filter(id=>!installed.has(id));
      if(absent.length)await askChoice({title:'Some visualizations aren’t here',message:[`This set list uses: ${absent.join(', ')}.`,'The file carries their names and connections, never their code. Add them to the My Visuals folder, or it won’t start until they’re changed in Prepare.'],choices:[],cancel:'OK'});
      // it comes in as a new set list of its own, under a name nothing else has
      const imported=await api('/api/show/'+encodeURIComponent(r.show_id)),body=imported.body;
      const taken=new Set(deps.setlists().map(l=>l.name.toLowerCase()));let name=body.name;for(let n=2;taken.has(name.toLowerCase());n++)name=`${body.name} (${n})`;
      const list=await api('/api/setlist',{name}),songs=[...new Set(body.entries.map(e=>e.songId))];
      for(const song_id of songs)await api('/api/setlist/add',{id:list.id,song_id});
      await api('/api/show/save',{body:{...body,id:'list-'+list.id,name,sourceList:list.id,entries:applyListDiff(body,songs,uid).entries},base:0});
      await api('/api/show/delete',{id:r.show_id});
      await deps.refresh();
    }catch(error){deps.showError(error);}
  }
  return {sync,head,rowDetails,totalLine,perform,reloadFacts:()=>loadFacts().then(deps.redraw).catch(deps.showError),get listId(){return listId;},flush(){clearTimeout(timer);return saveDraft();}};
}
