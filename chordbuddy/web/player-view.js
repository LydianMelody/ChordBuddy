// The navigation bar: transport buttons and now/next chord on the left (with the repeat pass beside Now), the shared timeline lane in the
// middle, and on the right the clock over a small table of Tempo and Pitch, with what the pitch affects under it. It only drives the one shared Transport.
import {mountPracticeTimeline} from './practice-timeline.js';
import {actualPracticePosition} from './practice-state.js';
import {sectionAtSeconds,sectionLoopRange,barLoopRange,stepSpeed,SPEED_MIN,SPEED_MAX} from './loop-range.js';
import {detectFadeIn,detectFadeOut} from './fade-out.js';
import {icon} from './icons.js';
import {speedForTempo,tempoAt} from './performance-midi.js';
import {parseKey,pitchOfLetter,nearestStep,stepOffset,intervalFor,offsetText} from './transpose.js';
const time=s=>Number.isFinite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'0:00';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const withIcon=(button,name)=>{button.innerHTML=icon(name);return button;};

export function mountPlayer(footer,transport,onError,{onViewportChange=()=>{},loadWaveform=async()=>null,songTempo=()=>null,pitch=null,songKey=()=>null,showPitch=()=>null,onShowPitch=()=>{}}={}){
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
 const clock=el('div','clock player-clock'),speed=el('div','tune-row speed'),slower=el('button','tune-step','−'),faster=el('button','tune-step','+'),rate=el('span','tune-read'),rateText=el('b','','1.0×');
 slower.type=faster.type='button';// the playback speed, said as a speed (1.0×, 0.75×) and labeled, so it is never taken for the zoom beside the chart
 slower.title='Play slower (to practice a fast part)';faster.title='Play faster, back up to full speed';slower.setAttribute('aria-label','Play slower');faster.setAttribute('aria-label','Play faster');
 rate.title='How fast the song plays: 1.0× is its own speed. The pitch stays the same.';rate.append(rateText);
 // The tempo you're hearing: the song's tempo where the playhead is, at this speed. Click it to type a tempo to practice at; the speed changes to play it.
 const tempoB=el('button','tempo-read'),tempoIn=el('input','tempo-entry');tempoB.type='button';
 tempoB.title='The tempo you’re hearing: the song’s tempo here, at this speed. Click to type a tempo to practice at, and the speed changes to play it.';
 tempoIn.type='number';tempoIn.min=20;tempoIn.max=300;tempoIn.step=1;tempoIn.hidden=true;tempoIn.setAttribute('aria-label','Tempo to practice at, in beats per minute');tempoIn.title='Type a tempo, then Enter. Esc leaves the speed as it is.';
 rate.append(tempoB,tempoIn);speed.append(el('small','tune-name','Tempo'),slower,rate,faster);
 // Tempo and pitch: one small table, a row each (name, −, value, +), lines between every cell so each button's edge shows. Under it,
 // two checkboxes say what the pitch affects. Together they stay no taller than the timeline beside them.
 const pitchView=mountPitchCard({pitch,songKey,transport,onError,showPitch,onShowPitch});
 const panel=el('div','tune-panel');panel.append(speed,pitchView.row);
 const tune=el('div','tune');tune.append(panel,pitchView.affects,pitchView.badge);
 const status=el('span','player-buffering');status.setAttribute('role','status');
 right.append(clock,tune);grid.append(left,center,right);audio.after(grid);footer.append(status);

 const speedLabel=percent=>{const x=percent/100;return (Number.isInteger(x)?x.toFixed(1):String(+x.toFixed(2)))+'×';};
 const sections=()=>practice?.projection?.sections||[];
 function jump(direction){const s=transport.getSnapshot(),list=sections();let index=list.findIndex(v=>s.seconds>=v.start&&s.seconds<v.end);if(index<0)index=s.seconds<(list[0]?.start??0)?-1:list.length;const target=direction<0?(index>=0&&index<list.length&&s.seconds>list[index].start+.5?list[index]:list[Math.max(0,index-1)]):list[index+1];if(target)transport.seek(target.start).catch(onError);}
 previous.onclick=()=>jump(-1);next.onclick=()=>jump(1);
 play.onclick=()=>{if(transport.getSnapshot().playIntent)transport.pause();else transport.play().catch(onError);};
 // Loops from the keyboard (playback-keys.js): R (or the button) the section you are in, L four bars (loopFor). Pressing the key of the
 // loop that is on, or either key over a loop whose handles you placed, ends it; the other key swaps it. Handles then set any range.
 let loopBarCount=4;   // how many bars a bar loop is, so it keeps its size when it follows a seek
 function toggleLoop(kind='section',bars=4){
  if(transport.performer){transport.performer.pressLoop(kind,{bars});return;}
  if(kind==='bars')loopBarCount=bars;
  const s=transport.getSnapshot();if(!s.ready)return;
  if(s.loop.enabled&&(!s.loop.implicit||(s.loop.kind||'section')===kind)){transport.setLoop(null).catch(onError);return;}
  const range=loopFor(kind,s.seconds,bars);if(!range)return;
  // a loop wholly behind the playhead (the first bars of a fading outro) would never play: start it
  const behind=s.seconds>=range.end-.05;
  transport.setLoop({enabled:true,...range,implicit:true,kind},behind?{seekTo:range.start}:{}).catch(onError);
 }
 function loopFor(kind,seconds,bars=4){
  const section=sectionAtSeconds(sections(),seconds)||(seconds<(sections()[0]?.start??0)?sections()[0]:null)||sections().at(-1);if(!section)return null;
  const measures=practice?.music?.measures||[],barOne=measures.find(m=>m.number-(practice?.barOffset||0)===1),musicStart=barOne?.start;
  if(kind==='bars'){
   const phrases=(practice?.projection?.groups||[]).filter(g=>g.folded&&g.passes?.length>1).flatMap(g=>g.passes);
   return barLoopRange(section,measures,seconds,{phrases:bars===4?phrases:[],musicStart},bars);
  }
  const beats=measures.flatMap(m=>m.beats||[]),fades=wave?.peaks?{fadeIn:detectFadeIn(wave.peaks,wave.duration,beats),fadeOut:detectFadeOut(wave.peaks,wave.duration,beats)}:{};
  return sectionLoopRange(section,measures,{...fades,musicStart});
 }
 loopButton.onclick=()=>toggleLoop('section');
 // Speed: the stepper is honest. It stays disabled until the transport can really change tempo without changing pitch.
 const canSpeed=()=>typeof transport.setRate==='function';
 const stepRate=direction=>{const s=transport.getSnapshot();transport.setRate(stepSpeed(s.rate??100,direction)).catch(onError);};
 slower.onclick=()=>stepRate(-1);faster.onclick=()=>stepRate(1);
 const tempoHere=()=>tempoAt(songTempo(),transport.getSnapshot().seconds);
 let typingTempo=false;
 function closeTempo(){typingTempo=false;tempoIn.hidden=true;tempoB.hidden=false;paint(transport.getSnapshot());}
 tempoB.onclick=()=>{const base=tempoHere();if(!base||!canSpeed())return;typingTempo=true;tempoIn.value=String(Math.round(base*(transport.getSnapshot().rate??100)/100));tempoB.hidden=true;tempoIn.hidden=false;tempoIn.focus?.();tempoIn.select?.();};
 function applyTempo(){
  if(!typingTempo)return;const r=speedForTempo(Number(tempoIn.value),tempoHere());closeTempo();
  if(r.error){onError(Error(r.error));return;}
  transport.setRate(r.percent).catch(onError);
 }
 tempoIn.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();applyTempo();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeTempo();}};
 tempoIn.onblur=()=>applyTempo();

 function paint(s){
  play.disabled=!s.ready;const playIcon=s.playIntent?'pause':'play';if(play.dataset.shown!==playIcon){play.innerHTML=icon(playIcon);play.dataset.shown=playIcon;}   // only swap the icon when it really changes: replacing it mid-click eats the click
  play.setAttribute('aria-label',s.playIntent?'Pause':s.error?'Retry Play':'Play');play.title=play.getAttribute('aria-label');
  clock.textContent=time(s.seconds)+' / '+time(s.duration);
  loopButton.disabled=!s.ready;loopButton.classList.toggle('on',!!s.loop?.enabled);loopButton.setAttribute('aria-pressed',String(!!s.loop?.enabled));
  const list=sections();previous.disabled=!s.ready||!list.length;next.disabled=!s.ready||!list.some(v=>v.start>s.seconds);
  const section=sectionAtSeconds(list,s.seconds),where=practice?.projection?.occurrences&&practice.projection.groups?actualPracticePosition(practice.projection,s.seconds):null;
  nowSection.textContent=section?.name||'';nowNext.textContent=now.next?'next '+now.next:'';nowChord.textContent=now.chord||'—';
  nowLabel.textContent=where&&where.passCount>1?'Now · pass '+where.passNumber+' of '+where.passCount:'Now';
  const rateValue=s.rate??100;rateText.textContent=speedLabel(rateValue);speed.classList.toggle('slowed',rateValue<100);
  slower.disabled=!s.ready||!canSpeed()||rateValue<=SPEED_MIN;faster.disabled=!s.ready||!canSpeed()||rateValue>=SPEED_MAX;
  speed.title=canSpeed()?'Practice speed: slow the song down to learn a fast part, or speed it up. The pitch stays the same.':'Speed control is coming soon';
  const base=tempoHere();
  tempoB.textContent=base?`♩ ${Math.round(base*rateValue/100)}`:'♩ —';tempoB.disabled=!base||!s.ready||!canSpeed();
  if(!base)tempoB.title='The tempo shows here once the song has been analyzed.';
  else tempoB.title=`The tempo you’re hearing: the song is at ${Math.round(base)} BPM here${rateValue!==100?`, playing at ${speedLabel(rateValue)}`:''}. Click to type a tempo to practice at, and the speed changes to play it.`;
  speed.classList.toggle('changed',rateValue!==100);pitchView.paint(s);
  status.textContent=!s.ready?s.readiness:s.buffering?'Buffering…':s.error?s.error:'';
  status.classList.toggle('floating',!!s.ready);     // a passing word (Buffering…, an error) floats over the page; the reason playback is not ready yet stays in the bar
  // A loop R or L set (not one whose handles you moved) follows you when you jump elsewhere: to the new section, or the new four bars. Only a seek moves it: playback itself
  // never does (the playhead reported just after the loop wraps, or as playback starts, can sit a moment before the section's start).
  const seeked=s.seeks!==seeksSeen;seeksSeen=s.seeks;
  const kind=s.loop?.kind||'section',range=seeked&&s.loop?.enabled&&s.loop.implicit&&section?loopFor(kind,s.seconds,loopBarCount):null;
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
  repaintPitch(){pitchView.paint(transport.getSnapshot());},
  dispose(){waveRequest++;unsubscribe();pitchView.dispose();timeline.dispose();grid.remove();status.remove();},
 };
}

// The pitch row: − and + move the song up or down a half step (round the corner after six), the key under the number can be clicked to
// type a key letter, and two checkboxes under the table say what the pitch affects: Audio (what you hear) and Charts (what you see).
// pitch: the per-song owner (pitch-state.js). songKey(): the song's key name ('A minor'), or null.
const PITCH_TIPS={
 down:'Lower the pitch one half step (one piano key). Past six it comes round to the high side, the same note an octave over.',
 up:'Raise the pitch one half step (one piano key). Past six it comes round to the low side, the same note an octave over.',
 key:'The key the song is in now. Click, then type a key letter like C, F# or Db and press Enter to jump there.',
 noKey:'The song’s key isn’t known, so a key can’t be typed here. − and + still work. Set the key from the key chip at the top of the page.',
 sound:'Audio: the music you hear moves to the new key. Untick it to hear the song as recorded while the charts still move.',
 chart:'Charts: the chords and notes you see move to the new key. Untick it if your guitar is tuned down or you use a capo, so you keep reading the shapes you play.',
};
// showPitch(): in a show, {sound, chart} from the arrangement (the card shows it, marked planned); onShowPitch(n) changes it live there.
function mountPitchCard({pitch,songKey,transport,onError,showPitch=()=>null,onShowPitch=()=>{}}){
 const card=el('div','tune-row pitch'),name=el('small','tune-name','Pitch');
 const badge=el('span','tune-badge','Round the corner');badge.setAttribute('aria-hidden','true');
 const lower=el('button','tune-step','−'),raise=el('button','tune-step','+'),screen=el('span','tune-read'),value=el('b','tune-value'),valueText=el('span','','0');
 lower.type=raise.type='button';lower.title=PITCH_TIPS.down;raise.title=PITCH_TIPS.up;lower.setAttribute('aria-label','Lower the pitch');raise.setAttribute('aria-label','Raise the pitch');
 value.append(valueText);
 const keyB=el('button','tempo-read key-read'),keyIn=el('input','tempo-entry key-entry');keyB.type='button';
 keyIn.type='text';keyIn.maxLength=3;keyIn.hidden=true;keyIn.autocomplete='off';keyIn.spellcheck=false;keyIn.setAttribute('aria-label','Type a key letter, like C, F# or Db');
 keyIn.title='Type a key letter like C, F# or Db, then Enter. Esc leaves the pitch as it is.';
 screen.append(value,keyB,keyIn);screen.title='How many half steps the song is moved, and the key it is in now';
 card.append(name,lower,screen,raise);
 const affects=el('div','tune-affects'),tickLabels=new Map(),tick=(text,tip)=>{const label=el('label','tune-tick'),box=el('input');box.type='checkbox';label.title=tip;label.append(box,el('span','',text));affects.append(label);tickLabels.set(box,label);return box;};
 affects.append(el('span','tune-affects-name','Pitch affects:'));
 const soundB=tick('Audio',PITCH_TIPS.sound),chartB=tick('Charts',PITCH_TIPS.chart);

 let shownOffset=null,typing=false;
 const current=()=>{const show=showPitch();if(show)return {offset:show.sound||show.chart,sound:true,chart:true,show:true};return pitch?pitch.get():{offset:0,sound:true,chart:true};};
 const tonic=()=>parseKey(songKey());
 function roll(direction){value.classList.remove('up','down');if(!direction)return;void value.offsetWidth;value.classList.add(direction);}
 let wrapTimer=0;
 function wrapped(){card.classList.remove('wrapped');void card.offsetWidth;card.classList.add('wrapped');clearTimeout(wrapTimer);wrapTimer=setTimeout(()=>card.classList.remove('wrapped'),1200);}   // a timer, not animationend: with reduced motion there is no animation
 function move(next,direction){
  const now=current(),before=now.offset;if(next===before||!pitch)return;
  if(now.show)onShowPitch(next);else pitch.set({offset:next});roll(direction);
  if(direction==='up'&&next<before||direction==='down'&&next>before)wrapped();
 }
 lower.onclick=()=>move(stepOffset(current().offset,-1),'down');
 raise.onclick=()=>move(stepOffset(current().offset,1),'up');
 soundB.onchange=()=>{if(!current().show)pitch?.set({sound:soundB.checked});else paint(transport.getSnapshot());};
 chartB.onchange=()=>{if(!current().show)pitch?.set({chart:chartB.checked});else paint(transport.getSnapshot());};
 function closeKey(){typing=false;keyIn.hidden=true;keyB.hidden=false;keyIn.classList.remove('bad');paint(transport.getSnapshot());}
 keyB.onclick=()=>{if(!tonic()||!pitch?.songId)return;typing=true;keyIn.value='';keyIn.placeholder=keyB.textContent;keyB.hidden=true;keyIn.hidden=false;keyIn.focus?.();};
 function applyKey(){
  const target=pitchOfLetter(keyIn.value);
  if(target===null){keyIn.classList.remove('bad');void keyIn.offsetWidth;keyIn.classList.add('bad');return;}
  const offset=current().offset,next=nearestStep(offset,target,tonic().pitch);closeKey();
  const delta=((target-(tonic().pitch+offset))%12+12)%12;
  move(next,delta===0?null:delta<=6?'up':'down');
 }
 keyIn.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();applyKey();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeKey();}};
 keyIn.onblur=()=>{if(typing)closeKey();};

 function paint(s){
  const p=current(),loaded=!!pitch?.songId,key=songKey(),shown=intervalFor(key,p.offset).key;
  if(p.offset!==shownOffset){valueText.textContent=offsetText(p.offset).replace('-','−');shownOffset=p.offset;}
  const on=p.sound||p.chart,changed=p.offset!==0&&on;
  card.classList.toggle('changed',changed);card.classList.toggle('dim',!on);
  lower.disabled=raise.disabled=!loaded;
  if(!typing){
   const letter=shown?shown.split(' ')[0]:'—';keyB.textContent=letter;keyB.disabled=!loaded||!key;
   keyB.title=key?`Now in ${shown}. `+PITCH_TIPS.key:PITCH_TIPS.noKey;
  }
  const locked=p.show?' This show’s arrangement sets it here, so it can’t be changed during the show.':'';tickLabels.get(soundB).title=PITCH_TIPS.sound+locked;tickLabels.get(chartB).title=PITCH_TIPS.chart+locked;
  soundB.checked=!!p.sound;chartB.checked=!!p.chart;soundB.disabled=chartB.disabled=!loaded||!!p.show;affects.classList.toggle('off',!loaded||!!p.show);
  card.classList.toggle('planned',!!p.show);name.textContent=p.show?'Planned':'Pitch';
  const waiting=p.sound&&p.offset!==0&&s?.pitchPending;
  card.classList.toggle('waiting',!!waiting);
  card.title=p.show?'This arrangement sets the pitch here. − and + change it for the rest of this song, as a speed change does; its flags say what each part applies to.':waiting?'Getting pitch ready… The sound moves to the new key in a moment.':!on?'Pitch isn’t applied: tick Audio or Charts under it to use it.':'';
 }
 const stop=pitch?.subscribe(()=>paint(transport.getSnapshot()))||(()=>{});
 return {row:card,affects,badge,paint,dispose(){stop();clearTimeout(wrapTimer);}};
}
