// The navigation bar: transport buttons and now/next chord on the left, the shared timeline lane in the middle,
// clock, repeat pass and speed on the right. It only drives the one shared Transport.
import {mountPracticeTimeline} from './practice-timeline.js';
import {actualPracticePosition} from './practice-state.js';
import {sectionAtSeconds,stepSpeed,SPEED_MIN,SPEED_MAX} from './loop-range.js';
import {icon} from './icons.js';
const time=s=>Number.isFinite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'0:00';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const withIcon=(button,name)=>{button.innerHTML=icon(name);return button;};

export function mountPlayer(footer,transport,onError,{onViewportChange=()=>{},loadWaveform=async()=>null}={}){
 let practice=null,waveRun=null,waveRequest=0,now={chord:'—',next:''},followingSection=null;
 const audio=footer.querySelector('audio');audio.hidden=true;audio.removeAttribute('controls');
 const grid=el('div','nav-grid'),left=el('div','nav-left'),center=el('div','nav-center'),right=el('div','nav-right');
 const nowBox=el('div','nowbox'),nowChord=el('div','nowchord','—'),nowMeta=el('div','nowmeta'),nowLabel=el('small','','Now'),nowSection=el('b','',''),nowNext=el('span','','');
 nowMeta.append(nowLabel,nowSection,nowNext);nowBox.append(nowChord,nowMeta);
 const controls=el('div','ctrls shared-player-controls');
 const loopButton=el('button','cbtn practice-loop-toggle');const previous=el('button','cbtn player-skip'),play=el('button','cbtn play player-play'),next=el('button','cbtn player-skip');
 for(const b of [loopButton,previous,play,next])b.type='button';
 withIcon(loopButton,'loop');withIcon(previous,'rewind');withIcon(next,'ffwd');
 loopButton.title='Loop (drag on the waveform to choose a range)';loopButton.setAttribute('aria-label','Loop');previous.title='Previous section';next.title='Next section';
 previous.setAttribute('aria-label','Previous section');next.setAttribute('aria-label','Next section');
 controls.append(loopButton,previous,play,next);left.append(nowBox,controls);
 const timelineRoot=el('div','practice-timeline');center.append(timelineRoot);
 const timeline=mountPracticeTimeline(timelineRoot,{transport,onViewportChange,onError});
 const clock=el('div','clock player-clock'),pass=el('div','pass'),speed=el('div','speed'),slower=el('button','','−'),faster=el('button','','+'),rate=el('span'),rateText=el('b','','100%');
 slower.type=faster.type='button';slower.title='Slower';faster.title='Faster';rate.innerHTML=icon('turtle');rate.append(rateText);speed.append(slower,rate,faster);
 const status=el('span','player-buffering');status.setAttribute('role','status');
 right.append(clock,pass,speed);grid.append(left,center,right);audio.after(grid);footer.append(status);

 const sections=()=>practice?.projection?.sections||[];
 function jump(direction){const s=transport.getSnapshot(),list=sections();let index=list.findIndex(v=>s.seconds>=v.start&&s.seconds<v.end);if(index<0)index=s.seconds<(list[0]?.start??0)?-1:list.length;const target=direction<0?(index>=0&&index<list.length&&s.seconds>list[index].start+.5?list[index]:list[Math.max(0,index-1)]):list[index+1];if(target)transport.seek(target.start).catch(onError);}
 previous.onclick=()=>jump(-1);next.onclick=()=>jump(1);
 play.onclick=()=>{if(transport.getSnapshot().playIntent)transport.pause();else transport.play().catch(onError);};
 // Loop button: off keeps the chosen range for later; on with a range goes back to it; on with no range loops the current section.
 loopButton.onclick=()=>{
  const s=transport.getSnapshot(),l=s.loop;
  if(l.enabled){transport.setLoop({...l,enabled:false}).catch(onError);return;}
  if(l.start!==null){transport.setLoop({...l,enabled:true,implicit:false},{seekTo:s.playIntent?l.start:undefined}).catch(onError);return;}
  const section=sectionAtSeconds(sections(),s.seconds)||sections()[0];
  if(section)transport.setLoop({enabled:true,start:section.start,end:section.end,implicit:true}).catch(onError);
 };
 // Speed: the stepper is honest. It stays disabled until the transport can really change tempo without changing pitch.
 const canSpeed=()=>typeof transport.setRate==='function';
 const stepRate=direction=>{const s=transport.getSnapshot();transport.setRate(stepSpeed(s.rate??100,direction)).catch(onError);};
 slower.onclick=()=>stepRate(-1);faster.onclick=()=>stepRate(1);

 function paint(s){
  play.disabled=!s.ready;const playIcon=s.playIntent?'pause':'play';if(play.dataset.shown!==playIcon){play.innerHTML=icon(playIcon);play.dataset.shown=playIcon;}   // only swap the icon when it really changes: replacing it mid-click eats the click
  play.setAttribute('aria-label',s.playIntent?'Pause':s.error?'Retry Play':'Play');play.title=play.getAttribute('aria-label');
  clock.textContent=time(s.seconds)+' / '+time(s.duration);
  loopButton.disabled=!s.ready;loopButton.classList.toggle('on',!!s.loop?.enabled);loopButton.setAttribute('aria-pressed',String(!!s.loop?.enabled));
  const list=sections();previous.disabled=!s.ready||!list.length;next.disabled=!s.ready||!list.some(v=>v.start>s.seconds);
  const section=sectionAtSeconds(list,s.seconds),where=practice?.projection?.occurrences&&practice.projection.groups?actualPracticePosition(practice.projection,s.seconds):null;
  nowSection.textContent=section?.name||'';nowNext.textContent=now.next?'next '+now.next:'';nowChord.textContent=now.chord||'—';
  pass.textContent=where&&where.passCount>1?'pass '+where.passNumber+' of '+where.passCount:'';
  const rateValue=s.rate??100;rateText.textContent=rateValue+'%';speed.classList.toggle('slowed',rateValue<100);
  slower.disabled=!s.ready||!canSpeed()||rateValue<=SPEED_MIN;faster.disabled=!s.ready||!canSpeed()||rateValue>=SPEED_MAX;
  speed.title=canSpeed()?'Practice speed':'Speed control is coming soon';
  status.textContent=!s.ready?s.readiness:s.buffering?'Buffering…':s.error?s.error:'';
  if(!s.loop?.implicit)followingSection=null;
  // With the loop on and no explicit range, the loop follows whichever section the playhead is in.
  if(s.loop?.enabled&&s.loop.implicit&&section&&!s.buffering&&(s.loop.start!==section.start||s.loop.end!==section.end)&&followingSection!==section.id){
   followingSection=section.id;transport.setLoop({enabled:true,start:section.start,end:section.end,implicit:true}).catch(onError);
  }
 }
 const unsubscribe=transport.subscribe(paint);
 return {
  setPractice(data){practice=data;timeline.update(data);paint(transport.getSnapshot());},
  setNow(value){now={chord:value?.chord||'—',next:value?.next||''};paint(transport.getSnapshot());},
  setWaveformRun(run){
   if(run===waveRun)return;waveRun=run;const serial=++waveRequest;timeline.setWaveform(null,run?'Loading waveform…':'Waveform available after analysis.');if(!run)return;
   Promise.resolve().then(()=>loadWaveform(run)).then(value=>{if(serial===waveRequest)timeline.setWaveform(value);}).catch(()=>{if(serial===waveRequest)timeline.setWaveform(null,'Waveform unavailable. Playback controls remain available.');});
  },
  dispose(){waveRequest++;unsubscribe();timeline.dispose();grid.remove();status.remove();},
 };
}
