// The navigation bar: transport buttons and now/next chord on the left, the shared timeline lane in the middle,
// clock, repeat pass and speed on the right. It only drives the one shared Transport.
import {mountPracticeTimeline} from './practice-timeline.js';
import {actualPracticePosition} from './practice-state.js';
import {sectionAtSeconds,sectionLoopRange,barLoopRange,stepSpeed,SPEED_MIN,SPEED_MAX} from './loop-range.js';
import {detectFadeIn,detectFadeOut} from './fade-out.js';
import {icon} from './icons.js';
const time=s=>Number.isFinite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'0:00';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const withIcon=(button,name)=>{button.innerHTML=icon(name);return button;};

export function mountPlayer(footer,transport,onError,{onViewportChange=()=>{},loadWaveform=async()=>null}={}){
 let practice=null,waveRun=null,waveRequest=0,now={chord:'—',next:''},seeksSeen=0,wave=null;
 const audio=footer.querySelector('audio');audio.hidden=true;audio.removeAttribute('controls');
 const grid=el('div','nav-grid'),left=el('div','nav-left'),center=el('div','nav-center'),right=el('div','nav-right');
 const nowBox=el('div','nowbox'),nowChord=el('div','nowchord','—'),nowMeta=el('div','nowmeta'),nowLabel=el('small','','Now'),nowSection=el('b','',''),nowNext=el('span','','');
 nowMeta.append(nowLabel,nowSection,nowNext);nowBox.append(nowChord,nowMeta);
 const controls=el('div','ctrls shared-player-controls');
 const loopButton=el('button','cbtn practice-loop-toggle');const previous=el('button','cbtn player-skip'),play=el('button','cbtn play player-play'),next=el('button','cbtn player-skip');
 for(const b of [loopButton,previous,play,next])b.type='button';
 withIcon(loopButton,'loop');withIcon(previous,'rewind');withIcon(next,'ffwd');
 loopButton.title='Loop this section (R) · four bars (L) · drag on the waveform to choose a range';loopButton.setAttribute('aria-label','Loop');previous.title='Previous section';next.title='Next section';
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
 // Loops from the keyboard (playback-keys.js): R (or the button) the section you are in, L four bars (loopFor). Pressing the key of the
 // loop that is on, or either key over a loop whose handles you placed, ends it; the other key swaps it. Handles then set any range.
 function toggleLoop(kind='section'){
  const s=transport.getSnapshot();if(!s.ready)return;
  if(s.loop.enabled&&(!s.loop.implicit||(s.loop.kind||'section')===kind)){transport.setLoop(null).catch(onError);return;}
  const range=loopFor(kind,s.seconds);if(!range)return;
  // a loop wholly behind the playhead (the first bars of a fading outro) would never play: start it
  const behind=s.seconds>=range.end-.05;
  transport.setLoop({enabled:true,...range,implicit:true,kind},behind?{seekTo:range.start}:{}).catch(onError);
 }
 function loopFor(kind,seconds){
  const section=sectionAtSeconds(sections(),seconds)||(seconds<(sections()[0]?.start??0)?sections()[0]:null)||sections().at(-1);if(!section)return null;
  const measures=practice?.music?.measures||[],barOne=measures.find(m=>m.number-(practice?.barOffset||0)===1),musicStart=barOne?.start;
  if(kind==='bars'){
   const phrases=(practice?.projection?.groups||[]).filter(g=>g.folded&&g.passes?.length>1).flatMap(g=>g.passes);
   return barLoopRange(section,measures,seconds,{phrases,musicStart});
  }
  const beats=measures.flatMap(m=>m.beats||[]),fades=wave?.peaks?{fadeIn:detectFadeIn(wave.peaks,wave.duration,beats),fadeOut:detectFadeOut(wave.peaks,wave.duration,beats)}:{};
  return sectionLoopRange(section,measures,{...fades,musicStart});
 }
 loopButton.onclick=()=>toggleLoop('section');
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
  // A loop R or L set (not one whose handles you moved) follows you when you jump elsewhere: to the new section, or the new four bars. Only a seek moves it: playback itself
  // never does (the playhead reported just after the loop wraps, or as playback starts, can sit a moment before the section's start).
  const seeked=s.seeks!==seeksSeen;seeksSeen=s.seeks;
  const kind=s.loop?.kind||'section',range=seeked&&s.loop?.enabled&&s.loop.implicit&&section?loopFor(kind,s.seconds):null;
  if(range&&(s.loop.start!==range.start||s.loop.end!==range.end)&&!(s.seconds>=s.loop.start&&s.seconds<s.loop.end&&sectionAtSeconds(sections(),s.loop.start)===section)){
   transport.setLoop({enabled:true,...range,implicit:true,kind}).catch(onError);
  }
 }
 const unsubscribe=transport.subscribe(paint);
 return {
  toggleLoop,
  sectionStarts:()=>sections().map(section=>section.start),
  setPractice(data){practice=data;timeline.update(data);paint(transport.getSnapshot());},
  setNow(value){now={chord:value?.chord||'—',next:value?.next||''};paint(transport.getSnapshot());},
  setWaveformRun(run){
   if(run===waveRun)return;waveRun=run;const serial=++waveRequest;wave=null;timeline.setWaveform(null,run?'Loading waveform…':'Waveform available after analysis.');if(!run)return;
   Promise.resolve().then(()=>loadWaveform(run)).then(value=>{if(serial===waveRequest){wave=value;timeline.setWaveform(value);}}).catch(()=>{if(serial===waveRequest)timeline.setWaveform(null,'Waveform unavailable. Playback controls remain available.');});
  },
  dispose(){waveRequest++;unsubscribe();timeline.dispose();grid.remove();status.remove();},
 };
}
