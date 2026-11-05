// The Perform page: what a performer reads at a glance during a show. Big position in the middle, what's coming below it, the controls and clocks along the
// sides, the set in a drawer. It only shows what the controller says and sends it requests, so a redraw can never disturb the music. Status is always
// words and an icon, never color alone.
import {icon} from './icons.js';
import {describeAction} from './performance-actions.js';
import {clockText,spareText} from './performance-duration.js';

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const RATE=44100;
const STATUS={preparing:'Getting ready',armed:'Ready',playing:'Playing',paused:'Paused',gap:'Between songs',waiting:'Waiting for you',buffering:'Waiting for audio',finished:'Finished',stopped:'Stopped',error:'Stopped by a problem',idle:'Not running'};
const POLICY_WORDS={'until-released':'You win until you release it','next-cue':'Until the next planned change','next-section':'Until the next section','locked':'Follow the plan only (controls locked)'};
const LIVE_WORDS=property=>{
  const m=/^track\.(\w+)\.(gain|mute|solo)$/.exec(property);
  if(m)return `${m[1]} ${m[2]==='gain'?'level':m[2]}`;
  if(property==='master')return 'overall volume';if(property==='rate')return 'speed';if(property==='visual.scene')return 'visualization';
  if(property.startsWith('visual.'))return property.slice(7);
  return property.startsWith('midi.')?'pedal or MIDI setting':property;
};

/** Words for what's queued, with where it happens, updated as the music approaches it. */
export function pendingWords(snapshot,measures=[]){
  const song=snapshot?.song,p=song?.pending;
  if(snapshot?.pendingNext)return {text:'Next song at the next bar',cancel:true};
  if(song?.waiting)return {text:`Waiting for target audio: it goes at bar ${bar(measures,song.waiting.at)??'the next'}`,cancel:!!p};
  if(!p)return null;
  if(p.type==='jump')return {text:`Jump to bar ${p.bar} at the next bar`,cancel:true};
  if(p.type==='activate')return {text:`Looping ${p.label}`,cancel:true};
  if(p.type==='exit')return {text:'Leaving the loop after this pass',cancel:true};
  if(p.type==='switch')return {text:`After this pass: loop ${p.label}`,cancel:true};
  return null;
}
const bar=(measures,frame)=>{if(!Number.isFinite(frame))return null;const t=frame/RATE;return measures.find(m=>t>=m.start&&t<m.end)?.number??null;};

/** The next few planned moments, in plain words. */
export function upcoming(runner,limit=5,cues=[]){
  if(!runner?.current)return [];
  const out=[],measures=runner.measures,add=(frame,text)=>{if(out.length<limit)out.push({bar:bar(measures,frame),text});};
  // the chart's own cues ("pick scratch"), in this stretch of music, come first: they are what the player reads
  for(const cue of cues){const f=Math.round(cue.start*RATE);if(f>=runner.source&&f<runner.current.end)add(f,cue.text);}
  const from=s=>[...(s.actions||[])];
  const list=[runner.current,...runner.path.filter(p=>p.kind==='music'||p.kind==='hold')];
  for(const [i,s] of list.entries()){
    if(s.kind==='hold'){add(null,s.seconds===null?'Waits for you':`Holds for ${s.seconds} seconds`);continue;}
    if(i>0&&s.regionId&&s.passIndex!==null)add(s.start,`Pass ${s.passIndex+1}`);
    for(const a of from(s))if(a.frame>=(i===0?runner.source:s.start))add(a.frame,describeAction(a.action));
    if(out.length>=limit)break;
  }
  return out;
}

export function mountPerform(root,{controller,onClose,onSong=()=>{},chordAt=()=>null,onEditEntry=()=>{},catalog=()=>[]}){
  const panel=el('div','pf pf-stage');panel.setAttribute('role','region');panel.setAttribute('aria-label','Perform');
  const head=el('header','pf-head');
  const title=el('div','pf-names'),show=el('small','pf-show'),song=el('h2','pf-song'),perf=el('small','pf-performance');title.append(show,song,perf);
  const count=el('span','pf-count'),state=el('span','pf-state');state.setAttribute('role','status');
  const bigger=el('button','btn sq','');bigger.type='button';bigger.insertAdjacentHTML('afterbegin',icon('expand'));bigger.setAttribute('aria-label','Bigger text');bigger.title='Bigger text, for reading from further away';
  const drawerButton=el('button','btn','The set');drawerButton.type='button';drawerButton.title='See the songs still to come, and add, remove or reorder them. The music is not affected.';drawerButton.setAttribute('aria-expanded','false');
  const close=el('button','btn sq','');close.type='button';close.insertAdjacentHTML('afterbegin',icon('x'));close.setAttribute('aria-label','Close Perform');close.title='Back to the chart. A running show keeps playing; come back from the Perform menu.';
  head.append(title,count,state,el('span','vx-gap'),bigger,drawerButton,close);
  const body=el('div','pf-body');
  const centre=el('section','pf-centre');
  const section=el('div','pf-section'),position=el('div','pf-position'),chords=el('div','pf-chords'),next=el('div','pf-next');
  centre.append(section,position,chords,next);
  const resumeRow=el('div','pf-pending'),resumeText=el('span'),resumeButton=el('button','btn hot','Start from that song');resumeButton.type='button';resumeButton.title='Start the show from where the last run stopped. Press Start instead to begin at the first song.';resumeRow.append(resumeText,resumeButton);resumeRow.hidden=true;
  resumeButton.onclick=()=>{const point=controller.resumePoint();if(point)controller.start({entryIndex:point.index}).catch(error=>showProblem(error.message));paint();};
  const pending=el('div','pf-pending');pending.setAttribute('role','status');const pendingText=el('span');const cancelPending=el('button','btn','Cancel');cancelPending.type='button';cancelPending.title='Take back what’s queued. The music carries on as it was going.';pending.append(pendingText,cancelPending);
  const up=el('section','pf-upcoming');up.setAttribute('aria-label','Coming up');const upList=el('ol','pf-up-list');up.append(el('h3','vx-cap','Coming up'),upList);
  const middle=el('div','pf-main');middle.append(centre,resumeRow,pending,up);
  const side=el('aside','pf-side');
  const clocks=el('section','pf-clocks');clocks.setAttribute('aria-label','Time');
  const clockRow=label=>{const row=el('div','pf-clock'),value=el('b');row.append(el('span','vx-cap',label),value);clocks.append(row);return {row,value};};
  const music=clockRow('Music left'),planned=clockRow('Planned left'),slot=clockRow('Slot left'),finish=clockRow('Expected finish'),spare=el('div','pf-spare'),estimate=el('small','pf-estimate');clocks.append(spare,estimate);
  const status=el('section','pf-status');const overrides=el('div','pf-overrides'),health=el('ul','pf-health');status.append(el('h3','vx-cap','Your live changes'),overrides,el('h3','vx-cap','Checks'),health);
  side.append(clocks,status);
  const drawer=el('aside','pf-drawer');drawer.hidden=true;drawer.setAttribute('aria-label','The set');
  body.append(middle,side,drawer);
  const controls=el('div','pf-controls');controls.setAttribute('role','toolbar');controls.setAttribute('aria-label','Show controls');
  const control=(text,iconName,keyName,tip,run,cls='')=>{const b=el('button','btn pf-control '+cls);b.type='button';if(iconName)b.insertAdjacentHTML('afterbegin',icon(iconName));b.append(el('span','',text));if(keyName)b.append(el('kbd','',keyName));b.title=tip;b.onclick=run;controls.append(b);return b;};
  const playButton=control('Start','play','Space','Start the show, or pause and resume it. Pausing stops the music at once, and the slot clock keeps counting.',()=>act('toggle'),'hot');
  const loopBars=control('Loop 4 bars','loop','L','Loop the four bars you’re in, from the next bar line. Press again to leave after this pass. In a section loop it switches here after the pass.',()=>act('bars'));
  const loopSection=control('Loop section','loop','R','Loop the section you’re in. Press again to leave after this pass. In a four-bar loop it switches here after the pass.',()=>act('section'));
  const exitLoop=control('Leave loop',null,null,'Leave whichever loop is on, after the pass you’re in.',()=>act('exit'));
  const nextSong=control('Next song','ffwd',null,'Go to the next song at the next bar line, or start it now if the show is waiting for you.',()=>act('next'));
  const resumePlan=control('Back to the plan',null,null,'Let go of every live change, so the show follows the plan again.',()=>{controller.release({});paint();});
  const stop=control('Stop',null,null,'Stop the show right away.',()=>act('stop'),'danger');
  panel.append(head,body,controls);root.replaceChildren(panel);

  let large=false,disposed=false,lastSig='';
  bigger.onclick=()=>{large=!large;panel.classList.toggle('large',large);bigger.setAttribute('aria-pressed',String(large));};
  drawerButton.onclick=()=>{drawer.hidden=!drawer.hidden;drawerButton.setAttribute('aria-expanded',String(!drawer.hidden));paint();};
  close.onclick=()=>onClose();
  cancelPending.onclick=()=>{const r=controller.runner;if(controller.pendingNext)controller.cancelNext();else if(r?.pendingNav)r.cancelNavigation();else if(r?.pendingLoop)r.undoLoopIntent();paint();};

  /** Keys and buttons both end up here. */
  function act(what){
    const s=controller.status;
    if(what==='toggle'){if(s==='armed')controller.start().catch(error=>showProblem(error.message));else controller.togglePlay();}
    else if(what==='bars')controller.pressLoop('bars');
    else if(what==='section')controller.pressLoop('section');
    else if(what==='exit')controller.exitLoop();
    else if(what==='next')controller.nextSong();
    else if(what==='stop')controller.stop();
    paint();
  }
  function showProblem(message){state.textContent=message;}

  function drawDrawer(snapshot){
    const sig=JSON.stringify([snapshot.entries.map(e=>[e.id,e.done,e.now,e.seconds]),snapshot.removeAfter,drawer.hidden]);
    if(sig===lastSig)return;lastSig=sig;
    drawer.replaceChildren(el('h3','vx-cap','The set'));
    const list=el('ol','pf-set');
    const future=snapshot.entries.filter(e=>!e.done&&!e.now).map(e=>e.id);
    snapshot.entries.forEach(e=>{
      const row=el('li','pf-set-row'+(e.now?' now':'')+(e.done?' done':''));
      const words=el('div','pf-set-words');words.append(el('b','',e.title),el('small','',`${e.performance} · ${clockText(e.seconds)}`));
      row.append(el('span','pf-set-mark',e.done?'Done':e.now?'Now':''),words);
      if(controller.status==='armed'){
        const startHere=el('button','btn','Start here');startHere.type='button';startHere.title='Start the show from this song, for example after stopping partway through.';
        startHere.onclick=()=>{controller.start({entryIndex:snapshot.entries.indexOf(e)}).catch(error=>showProblem(error.message));paint();};row.append(startHere);
      }
      if(!e.done){
        if(!e.now){
          const at=future.indexOf(e.id);
          const move=(delta,label,iconName)=>{const b=el('button','btn sq','');b.type='button';b.insertAdjacentHTML('afterbegin',icon(iconName));b.setAttribute('aria-label',`${label}: ${e.title}`);b.title=label;b.disabled=at+delta<0||at+delta>=future.length;b.onclick=()=>{const list=[...future];list.splice(at+delta,0,list.splice(at,1)[0]);controller.setQueue(list);paint();};return b;};
          row.append(move(-1,'Earlier in the set','up'),move(1,'Later in the set','down'));
        }
        const out=el('button','btn',e.now?(snapshot.removeAfter===e.id?'Leaves after this song':'Remove after this song'):'Remove');out.type='button';out.disabled=snapshot.removeAfter===e.id;out.title=e.now?'This song keeps playing, and comes off the set when it ends.':'Take it off the set for tonight. The saved show isn’t changed.';
        out.onclick=()=>{controller.removeEntry(e.id);paint();};row.append(out);
      }
      list.append(row);
    });
    const add=el('div','pf-add'),pick=el('select','vx-visual');pick.setAttribute('aria-label','A song to add to the set');
    for(const item of catalog()){const o=el('option','',item.title);o.value=item.id;pick.append(o);}
    const addButton=el('button','btn','Add to the set');addButton.type='button';addButton.title='Add this song, with its Original arrangement, at the end of the set';
    addButton.disabled=!pick.options.length;addButton.onclick=()=>{controller.addEntry({id:`live-${Date.now().toString(36)}`,songId:pick.value,performanceId:null});};
    add.append(pick,addButton);
    const copyLog=el('button','btn','Copy the run log');copyLog.type='button';copyLog.title='Copy what happened in this run, moment by moment, to paste into a message if something went wrong.';
    copyLog.onclick=()=>navigator.clipboard?.writeText(JSON.stringify({show:controller.log,song:controller.runner?.log||[]})).catch(()=>{});
    drawer.append(list,add,copyLog);
  }

  function paint(){
    if(disposed)return;
    const s=controller.snapshot(),r=controller.runner,now=s.song;
    show.textContent=controller.show?.name||'';
    const entry=s.entries[Math.max(0,s.index)];
    song.textContent=entry?.title||'No song';perf.textContent=entry?.performance||'';
    count.textContent=s.count?`Song ${Math.max(1,s.index+1)} of ${s.count}`:'';
    state.textContent=s.error?`${STATUS.error}: ${s.error}`:STATUS[s.status]||s.status;state.dataset.state=s.status;
    section.textContent=now?.section||(s.status==='armed'?'Ready to start':s.check&&!s.check.ready?'Not ready: see Checks':'');
    resumeRow.hidden=!s.resume;
    if(s.resume)resumeText.textContent=`The last run stopped during song ${s.resume.index+1}${s.resume.title?`, ${s.resume.title}`:''}.`;
    const looped=now?.loop;
    position.textContent=now?`Bar ${now.bar??'–'}${now.occurrence?.passIndex!==null&&now.occurrence?.passIndex!==undefined?` · Pass ${now.occurrence.passIndex+1}`:''}${looped?` · Looping ${looped.label}`:''}`:'';
    const chord=now?chordAt(entry?.songId,now.source):null;
    chords.textContent=chord?.now||'';next.textContent=chord?.next?`Next: ${chord.next}`:'';
    const words=pendingWords(s,r?.measures||[]);pending.hidden=!words;if(words){pendingText.textContent=words.text;cancelPending.hidden=!words.cancel;}
    const coming=upcoming(r,5,controller.loaded?.get(controller.current?.id)?.cues||[]);upList.replaceChildren(...coming.map(c=>{const li=el('li');li.append(el('b','',c.bar?`Bar ${c.bar}`:''),el('span','',c.text));return li;}));
    if(!coming.length)upList.append(el('li','pf-none','Nothing else planned in this song.'));
    const c=s.clock;
    music.value.textContent=c?clockText(c.music):'—';planned.value.textContent=c?(c.unknown?'Unknown':clockText(c.planned)):'—';
    slot.row.hidden=!Number.isFinite(c?.slotLeft);slot.value.textContent=c&&Number.isFinite(c.slotLeft)?clockText(c.slotLeft):'—';
    finish.row.hidden=!(c&&Number.isFinite(c.expectedFinish));
    if(c&&Number.isFinite(c.expectedFinish)){const at=new Date(Date.now()+c.planned*1000);finish.value.textContent=at.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
    spare.textContent=c?spareText(c.spare):'';spare.classList.toggle('over',!!c&&c.spare<0);
    estimate.textContent=c?.unknown?'Finish unknown: waiting for you.':c?.estimated?'Estimated · live loop or wait.':'';
    overrides.replaceChildren();
    if(now?.overrides.length){
      for(const o of now.overrides){const b=el('button','btn pf-live');b.type='button';b.append(el('span','pf-live-tag','LIVE'),el('span','',LIVE_WORDS(o.property)));b.title=`${POLICY_WORDS[o.policy]||o.policy}. Click to go back to the plan for this.`;b.onclick=()=>{controller.release({property:o.property});paint();};overrides.append(b);}
    }else overrides.append(el('p','pf-none','None. Everything is following the plan.'));
    health.replaceChildren(...(s.check?.notes||[]).map(n=>el('li','',n)),...(s.missingDevices||[]).map(n=>el('li','pf-lost',s.stoppingAt?`${n} was disconnected. The show stops at the next bar.`:`${n} was disconnected. The show plays on without it.`)),...(s.check?.blocking||[]).map(n=>el('li','pf-lost',n)));
    if(!health.children.length)health.append(el('li','pf-none','All good.'));
    const running=['playing','paused','gap','waiting','buffering'].includes(s.status);
    playButton.querySelector('span').textContent=s.status==='armed'?'Start':s.status==='paused'?'Resume':'Pause';
    playButton.disabled=!(s.status==='armed'||running);
    for(const b of [loopBars,loopSection,stop])b.disabled=!running;
    exitLoop.disabled=!running||!r?.activeLoop();nextSong.disabled=!running||!controller.next;resumePlan.disabled=!now?.overrides.length;
    if(!drawer.hidden)drawDrawer(s);
  }
  const off=controller.subscribe?.(paint);
  const timer=setInterval(paint,250);paint();
  return {paint,act,dispose(){disposed=true;clearInterval(timer);off?.();root.replaceChildren();},get drawerOpen(){return !drawer.hidden;}};
}
