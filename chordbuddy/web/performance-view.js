// The show's controls: a slim strip above the chart, so the page stays the chart you know, with the mixer on the right and the set in the sidebar on the left. The strip has
// where you are, the clocks and what's coming up, then the buttons. It only shows what the controller says and sends it requests, so a redraw can never disturb the music. Status is always
// words and an icon, never color alone.
import {icon} from './icons.js';
import {tapeTint} from './library-page.js';
import {describeAction} from './performance-actions.js';
import {clockText,spareText} from './performance-duration.js';

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const RATE=44100;
const STATUS={holding:'Holding',preparing:'Getting ready',armed:'Ready',playing:'Playing',paused:'Paused',gap:'Between songs',waiting:'Waiting for you',buffering:'Waiting for audio',finished:'Finished',stopped:'Stopped',error:'Stopped by a problem',idle:'Not running'};
const POLICY_WORDS={'until-released':'You win until you release it','next-cue':'Until the next planned change','next-section':'Until the next section','locked':'Follow the plan only (controls locked)'};
const STEM_WORDS={bass:'Bass',drums:'Drums',other:'Other',vocals:'Vocals',piano:'Piano',lead:'Lead guitar',rhythm:'Rhythm guitar'};
/** A live change in plain words. */
export function liveWords({property,value}){
  const m=/^track\.(\w+)\.(gain|mute|solo)$/.exec(property);
  if(m){
    const name=STEM_WORDS[m[1]]||m[1];
    if(m[2]==='gain')return `${name} at ${Math.round(value*100)}%`;
    if(m[2]==='mute')return `${name} ${value?'muted':'not muted'}`;
    return `${name} ${value?'soloed':'not soloed'}`;
  }
  if(property==='master')return `Overall volume at ${Math.round(value*100)}%`;
  if(property==='rate')return `Speed at ${value}%`;
  if(property==='visual.scene')return `Showing ${value}`;
  if(property==='visual.lyrics')return `Lyrics ${value?'on':'off'}`;
  if(property==='visual.calm')return `Calm mode ${value?'on':'off'}`;
  if(property.startsWith('visual.'))return 'A visual setting';
  return property.startsWith('midi.')?'A pedal or MIDI setting':property;
}

/** Words for what's queued, with where it happens, updated as the music approaches it. */
export function pendingWords(snapshot,measures=[]){
  const song=snapshot?.song,p=song?.pending;
  if(snapshot?.pendingNext)return {text:'Next song at the next bar',cancel:true};
  if(song?.waiting)return {text:`Waiting for target audio: it goes at bar ${bar(measures,song.waiting.at)??'the next'}`,cancel:!!p};
  if(!p)return null;
  if(p.type==='jump')return {text:`Jump to bar ${p.bar} at the next bar`,cancel:true};
  if(p.type==='activate')return {text:`Starting a loop: ${p.label}`,cancel:true};
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
    for(const a of from(s))if(!a.glide&&a.frame>=(i===0?runner.source:s.start))add(a.frame,describeAction(a.action));
    if(out.length>=limit)break;
  }
  return out;
}

const RUNNING_NOW=['playing','paused','gap','waiting','buffering'];
export function mountPerform(root,{controller,onClose,chordAt=()=>null,catalog=()=>[],onShows=()=>{},onAgain=()=>{},fullscreen=null,openVisualizer=null,copyObsAddress=null,visualizerOpen=()=>false,audioSeconds=()=>0,setHost=null,onReleaseSet=()=>{},onError=()=>{}}){
  const panel=el('div','pf pf-stage');panel.setAttribute('role','region');panel.setAttribute('aria-label','Show controls');
  const head=el('header','pf-head');
  const title=el('div','pf-names'),show=el('small','pf-show'),song=el('h2','pf-song'),perf=el('small','pf-performance');title.append(show,song,perf);
  const count=el('span','pf-count'),state=el('span','pf-state');state.setAttribute('role','status');
  const here=el('div','pf-centre'),section=el('b','pf-section'),position=el('span','pf-position'),chords=el('b','pf-chords'),next=el('span','pf-next');here.append(section,position,chords,next);
  const clocks=el('section','pf-clocks');clocks.setAttribute('aria-label','Time');
  const clockRow=label=>{const row=el('div','pf-clock'),value=el('b');row.append(el('span','vx-cap',label),value);clocks.append(row);return {row,value};};
  const music=clockRow('Music left'),planned=clockRow('Planned left'),slot=clockRow('Slot left'),finish=clockRow('Finish'),spare=el('div','pf-spare'),estimate=el('small','pf-estimate');clocks.append(spare,estimate);
  const bigger=el('button','btn sq','');bigger.type='button';bigger.insertAdjacentHTML('afterbegin',icon('expand'));bigger.setAttribute('aria-label','Bigger text');bigger.title='Bigger text in this strip, for reading from further away';
  const screen=el('button','btn','Full screen');screen.type='button';screen.title='Fill the whole screen with this page. Press again to go back.';screen.onclick=()=>fullscreen?.();
  const visual=el('button','btn','Visualizer');visual.type='button';visual.title='Open the visualizer in its own window, to put on another monitor. It follows the show.';visual.onclick=()=>openVisualizer?.();
  // Beside it: the visualizer's address for OBS, copied in one press. The button says Copied for a moment; if it couldn't be copied, copyObsAddress shows the address instead.
  const obsLink=el('button','btn pf-obs-link','Copy OBS link');obsLink.type='button';obsLink.hidden=!copyObsAddress;obsLink.title='Copy the visualizer’s address, to show it on your stream: in OBS, add a Browser Source and paste this as its URL.';
  let obsLinkTimer=0;
  obsLink.onclick=async()=>{let copied=false;try{copied=await copyObsAddress();}catch(error){onError(error);}if(!copied)return;obsLink.textContent='Copied';clearTimeout(obsLinkTimer);obsLinkTimer=setTimeout(()=>{obsLink.textContent='Copy OBS link';},1500);};
  const close=el('button','btn sq','');close.type='button';close.insertAdjacentHTML('afterbegin',icon('x'));close.setAttribute('aria-label','Close the show controls');close.title='Leave the show controls. A running show keeps playing; come back from the Perform tab.';
  head.append(title,count,state,here,clocks,el('span','vx-gap'),bigger,screen,visual,obsLink,close);
  const resumeRow=el('div','pf-pending'),resumeText=el('span'),resumeButton=el('button','btn hot','Start from that song');resumeButton.type='button';resumeButton.title='Start the show from where the last run stopped. Press Start instead to begin at the first song.';resumeRow.append(resumeText,resumeButton);resumeRow.hidden=true;
  resumeButton.onclick=()=>{const point=controller.resumePoint();if(point)controller.start({entryIndex:point.index}).catch(error=>showProblem(error.message));paint();};
  const pending=el('div','pf-pending');pending.setAttribute('role','status');const pendingText=el('span');const cancelPending=el('button','btn btn-cancel','Cancel');cancelPending.type='button';cancelPending.title='Take back what’s queued. The music carries on as it was going.';pending.append(pendingText,cancelPending);
  const up=el('section','pf-upcoming');up.setAttribute('aria-label','Coming up');const upList=el('ol','pf-up-list');up.append(el('span','vx-cap','Coming up'),upList);
  const overrides=el('div','pf-overrides');
  const controls=el('div','pf-controls');controls.setAttribute('role','toolbar');controls.setAttribute('aria-label','Show controls');
  const control=(text,iconName,keyName,tip,run,cls='')=>{const b=el('button','btn pf-control '+cls);b.type='button';if(iconName)b.insertAdjacentHTML('afterbegin',icon(iconName));b.append(el('span','',text));if(keyName)b.append(el('kbd','',keyName));b.title=tip;b.onclick=run;controls.append(b);return b;};
  // Start, pause, loops and moving on are the player bar's buttons and the keys (Space, L, R, the arrows), as in every view; act() below is where they land
  const goOn=control('Go on',null,null,'The music is holding here. Go on from where it stopped.',()=>{controller.goOn();paint();},'hot');
  const again=control('Run it again','play',null,'Get the show ready to start again from the first song.',()=>onAgain(),'hot');
  const toShows=control('Back to the set list',null,null,'Leave the show controls. Change the set list in the sidebar.',()=>onShows());
  controls.append(overrides);
  const stop=control('Stop',null,null,'Stop the show right away.',()=>act('stop'),'danger pf-stop');
  panel.append(head,resumeRow,pending,up,controls);root.replaceChildren(panel);

  let large=false,disposed=false,lastSig='';
  bigger.onclick=()=>{large=!large;panel.classList.toggle('large',large);bigger.setAttribute('aria-pressed',String(large));};
  close.onclick=()=>onClose();
  cancelPending.onclick=()=>{const r=controller.runner;if(controller.pendingNext)controller.cancelNext();else if(r?.pendingNav)r.cancelNavigation();else if(r?.pendingLoop)r.undoLoopIntent();paint();};

  /** Keys and buttons both end up here. */
  function act(what){
    const s=controller.status;
    if(what==='toggle'){if(s==='armed')controller.start(startFrom!==null?{entryIndex:startFrom}:undefined).catch(error=>showProblem(error.message));else if(s==='waiting')controller.nextSong();else controller.togglePlay();}
    else if(what==='bars')controller.pressLoop('bars');
    else if(what==='section')controller.pressLoop('section');
    else if(what==='exit')controller.exitLoop();
    else if(what==='next')controller.nextSong();
    else if(what==='stop')controller.stop();
    paint();
  }
  // a problem goes where every other problem in the app goes, once each
  const told=new Set();
  function showProblem(message){if(!message||told.has(message))return;told.add(message);onError(new Error(message));}
  let startFrom=null;   // before Start: the song the show starts from (clicking a song in the set chooses it)

  /** The set, in the sidebar's list while the show controls are open: what's done, what's now, and what's still to come, which you can change. */
  function drawSet(snapshot){
    const host=setHost?.();if(!host)return;
    const armed=controller.status==='armed',running=RUNNING_NOW.includes(snapshot.status);
    const sig=JSON.stringify([snapshot.entries.map(e=>[e.id,e.done,e.now,e.seconds]),snapshot.removeAfter,armed,running,startFrom]);
    if(sig===lastSig&&host.querySelector('.pf-set'))return;lastSig=sig;
    const list=el('div','pf-set');
    const future=snapshot.entries.filter(e=>!e.done&&!e.now).map(e=>e.id);
    snapshot.entries.forEach((e,i)=>{
      const chosen=armed?(startFrom??0)===i:e.now;
      const row=el('div','song-row pf-set-row'+(chosen?' selected':'')+(e.done?' done':''));row.dataset.tint=String(tapeTint(e.songId));row.dataset.status='ready';
      row.append(el('span','song-number',e.done?'✓':String(i+1)));
      const main=el('button','song-main');main.type='button';main.append(el('strong','',e.title),el('small','',`${e.performance} · ${clockText(e.seconds)}${e.now?' · now':''}`));
      main.title=armed?'Start the show from this song. Press Play when you’re ready.':e.now?'Playing now.':e.done?'Play this song again next, at the next bar line. The rest of the set follows it.':'Go to this song at the next bar line. Any songs in between stay on the set, after it.';
      main.onclick=()=>{if(armed){startFrom=i;paint();}else if(!e.now&&running)controller.goToSong(e.songId).then(paint).catch(onError);};
      row.append(main);
      if(!e.done){
        const out=el('button','song-remove');out.type='button';out.innerHTML=icon('x');
        out.title=e.now?(snapshot.removeAfter===e.id?'Comes off the set when it ends':'Take it off the set when it ends. It keeps playing until then.'):'Take it off the set for tonight. The saved set list isn’t changed.';out.setAttribute('aria-label',`${out.title}: ${e.title}`);
        out.disabled=snapshot.removeAfter===e.id;out.onclick=()=>{controller.removeEntry(e.id);paint();};row.append(out);
      }
      if(!e.done&&!e.now){
        const at=future.indexOf(e.id),order=el('div','song-order');
        for(const [symbol,delta,label] of [['▲',-1,'Earlier in the set'],['▼',1,'Later in the set']]){const b=el('button','',symbol);b.type='button';b.title=`${label}: ${e.title}`;b.setAttribute('aria-label',b.title);b.disabled=at+delta<0||at+delta>=future.length;b.onclick=()=>{const next=[...future];next.splice(at+delta,0,next.splice(at,1)[0]);controller.setQueue(next);paint();};order.append(b);}
        row.append(order);
      }
      list.append(row);
    });
    host.replaceChildren(list);
  }

  function paint(){
    if(disposed)return;
    const s=controller.snapshot(),r=controller.runner,now=s.song;
    show.textContent=controller.show?.name||'';
    const entry=s.entries[Math.max(0,s.index)];
    song.textContent=entry?.title||'No song';perf.textContent=entry?.performance||'';
    count.textContent=s.count?`Song ${Math.max(1,s.index+1)} of ${s.count}`:'';
    const shownState=now?.holding&&s.status!=='paused'?'holding':s.status;
    state.textContent=s.error?`${STATUS.error}: ${s.error}`:shownState==='holding'?(now.holding.waiting?'Holding until you go on':`Holding · ${Math.ceil(now.holding.seconds??0)}s`):STATUS[shownState]||shownState;state.dataset.state=shownState;
    section.textContent=s.status==='finished'?'That’s the show':s.status==='stopped'?'Stopped':s.status==='waiting'?'Waiting for you':now?.section||(s.status==='armed'?'Ready to start':s.check&&!s.check.ready?'Not ready: see Checks':'');
    resumeRow.hidden=!s.resume;
    if(s.resume)resumeText.textContent=`The last run stopped during song ${s.resume.index+1}${s.resume.title?`, ${s.resume.title}`:''}.`;
    const looped=now?.loop;
    position.textContent=s.status==='waiting'?'Press Play (Space) when you’re ready.':['finished','stopped'].includes(s.status)?'':now?`Bar ${now.bar??'–'}${now.occurrence?.passIndex!==null&&now.occurrence?.passIndex!==undefined?` · Pass ${now.occurrence.passIndex+1}`:''}${looped?` · Looping ${looped.label}`:''}`:'';
    const chord=now?chordAt(entry?.songId,now.source):null;
    chords.textContent=chord?.now||'';next.textContent=chord?.next?`Next: ${chord.next}`:'';
    const words=pendingWords(s,r?.measures||[]);pending.hidden=!words;if(words){pendingText.textContent=words.text;cancelPending.hidden=!words.cancel;}
    const firstPlan=()=>{
      const first=controller.loaded?.get(controller.entries?.[0]?.id);
      if(!first?.compiled?.segments?.length)return [];
      const [head,...rest]=first.compiled.segments;
      return upcoming({current:head,path:rest,source:0,measures:first.grid.measures},5,first.cues||[]);
    };
    const coming=s.status==='armed'?firstPlan():upcoming(r,5,controller.loaded?.get(controller.current?.id)?.cues||[]);upList.replaceChildren(...coming.map(c=>{const li=el('li');li.append(el('b','',c.bar?`Bar ${c.bar}`:''),el('span','',c.text));return li;}));
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
      for(const o of now.overrides){const b=el('button','btn pf-live');b.type='button';b.append(el('span','pf-live-tag','LIVE'),el('span','',liveWords(o)));b.title=`${POLICY_WORDS[o.policy]||o.policy}. Click to go back to the song’s default for this.`;b.onclick=()=>{controller.release({property:o.property});paint();};overrides.append(b);}
    }
    for(const n of [...(s.check?.blocking||[]),...(s.missingDevices||[]).map(n=>s.stoppingAt?`${n} was disconnected. The show stops at the next bar.`:`${n} was disconnected. The show plays on without it.`)])showProblem(n);
    const running=['playing','paused','gap','waiting','buffering'].includes(s.status);
    const over=['finished','stopped','error'].includes(s.status);
    goOn.hidden=!now?.holding;again.hidden=!over;toShows.hidden=running;stop.hidden=!running;close.hidden=running;
    drawSet(s);
  }
  const off=controller.subscribe?.(paint);
  const timer=setInterval(paint,250);paint();
  return {paint,act,dispose(){disposed=true;clearInterval(timer);off?.();root.replaceChildren();onReleaseSet();}};
}
