// Display-only engraving. ABC source and chord character offsets are never rewritten.
import {decorateScoreConfidence,chordOpacity} from './confidence-view.js';
import {isNoChordLabel,effectiveMeasures} from './chart-layout.js';
import {scoreNoteTimes,placeLyricsOnNotes,lyricForNote} from './lead-lyrics.js';
import {mountLyricEditors} from './lead-lyric-editor.js';
import {CHORD_SUGGESTIONS} from './chart-page.js';
import {renderRail} from './tool-rail.js';
import {TOOLS,toolIcon} from './tool-icons.js';
import {LEAD_GROUPS,LEAD_NAMES,LEAD_DEFAULT,LEAD_FOR_KEY,EXTERNAL} from './lead-tool-info.js';
import {shiftSteps,toggleAccidental,toRest,editNoteInContent,noteName} from './lead-edit.js';
import {tuneToMusicXml,exportFileName} from './musicxml.js';
import {spellChord} from './spelling.js';
import {usualBeats,meterOf} from './bar-lengths.js';

// Link the score's source-order measures to recording time.  This is a
// conservative mapping: when counts differ we still expose the best ordered
// positions, but mark the result uncertain so playback never pretends the
// engraving is exact.
export function mapScoreTiming(analysis,music){
  const source=music?.measures||[], bars=source.map((measure,index)=>({id:measure.id,measure:index,start:measure.start,end:measure.end,beats:[...(measure.beats||[])],uncertain:analysis.measures!==source.length}));
  const exact=analysis.measures===source.length&&analysis.bars.length>=source.length;
  const notes=(analysis.notes||[]).map((note,index)=>{const bar=bars[note.measure];const beat=bar?Math.max(0,Math.min(bar.beats.length-1,index-(analysis.notes||[]).findIndex(n=>n.measure===note.measure))):0;return {...note,time:bar?.start??null,beat,uncertain:!exact};});
  return {exact,uncertain:!exact,bars,notes,measures:bars};
}
export function activeScoreTiming(timing,time){
  if(!timing||!Number.isFinite(time))return null;
  const index=timing.bars.findIndex(bar=>time>=bar.start-1e-7&&time<bar.end-1e-7);
  if(index<0)return null;const bar=timing.bars[index],beats=[...bar.beats,bar.end];let beat=0;
  for(let i=0;i<beats.length-1;i++)if(time<beats[i+1]-1e-7){beat=i;break;}
  return {measure:index,beat,measureId:bar.id,beatStart:bar.beats[beat]??bar.start,beatEnd:beats[beat+1]??bar.end,uncertain:!!(timing.uncertain||bar.uncertain)};
}
// The chord that is playing gets the chart's yellow tag behind it with black writing. `node` is its drawn symbol, or null for none.
export function markCurrentChord(container,node){
  if(!container?.querySelector)return;
  if(container._chordNow===node&&(!node||node.isConnected))return;
  container._chordNow=node;
  for(const old of container.querySelectorAll('.score-chord-active'))old.classList.remove('score-chord-active');
  let tag=container.querySelector('.lead-chord-now');
  if(!node){tag?.remove();return;}
  node.classList.add('score-chord-active');
  try{
    const box=node.getBBox(),parent=node.parentNode;
    if(tag&&tag.parentNode!==parent){tag.remove();tag=null;}
    if(!tag){tag=document.createElementNS('http://www.w3.org/2000/svg','rect');tag.setAttribute('class','lead-chord-now');tag.setAttribute('rx','5');}
    tag.setAttribute('x',box.x-6);tag.setAttribute('y',box.y-3);tag.setAttribute('width',box.width+12);tag.setAttribute('height',box.height+6);
    parent.insertBefore(tag,node);
  }catch{/* not drawn yet */}
}
// While the music plays the page follows it: when the line being played nears the top or bottom edge, it is eased to a comfortable place.
export function followPlayback(container,time=Date.now()){
  const node=container?.querySelector?.('.current-beat');if(!node)return;
  const desk=container.closest?.('.desk');if(!desk)return;
  if(container._followedAt&&time-container._followedAt<700)return;
  const mark=node.getBoundingClientRect(),view=desk.getBoundingClientRect();
  if(mark.top>view.top+90&&mark.bottom<view.bottom-120)return;
  container._followedAt=time;
  desk.scrollTo({top:desk.scrollTop+(mark.top-view.top)-view.height*.3,behavior:'smooth'});
}
export function updateLeadSheetPlayback(container,timing,time){
  const active=activeScoreTiming(timing,time);
  for(const node of container?.querySelectorAll?.('[data-score-note-index]')||[]){const note=timing?.notes?.[Number(node.dataset.scoreNoteIndex)];node.classList.toggle('current-beat',!!active&&note?.measure===active.measure&&note?.beat===active.beat);node.classList.toggle('current-measure',!!active&&note?.measure===active.measure);}
  return active;
}
// How much of the song's width a line is drawn across, in the score's own units: the more room, the smaller the music looks on the page
// (and the more bars fit on a line).
export const STAFF_UNITS={large:760,medium:980,small:1240};
export function engravingSettings(value={}) {
  return {bars_per_line:[0,2,3,4,8].includes(value.bars_per_line)?value.bars_per_line:0,music_size:['large','medium','small'].includes(value.music_size)?value.music_size:'medium',
    breaks:Array.isArray(value.breaks)?value.breaks.filter(n=>Number.isInteger(n)&&n>0):[],
    show_instrumental:value.show_instrumental===true,lyrics_text:typeof value.lyrics_text==='string'?value.lyrics_text:'',
    anchors:Array.isArray(value.anchors)?value.anchors.filter(a=>Number.isInteger(a.index)&&a.index>=0&&typeof a.text==='string').map(a=>({...a})):[]};
}
export function analyzeScore(abc,abcjs){
  const tune=abcjs.parseOnly(abc)[0];if(!tune)throw new Error('No music was found in the ABC notation.');
  const first=tune.lines.find(l=>l.staff)?.staff||[];
  let staffIndex=0,voiceIndex=0;
  let best=0;
  first.forEach((s,si)=>(s.title||[]).forEach((title,vi)=>{const name=typeof title==='string'?title:title?.name||'';const rank=/vocal|voice|sing/i.test(name)?2:/melody/i.test(name)?1:0;if(rank>best){best=rank;staffIndex=si;voiceIndex=vi;}}));
  const notes=[],events=[],bars=[];let measure=0,hasNotes=false;
  // timeMeasure/offset locate a note in recording time: the bar it is really in (a multi-bar rest such as Z4 is several bars) and
  // how far into that bar it starts, in whole notes. `measure` keeps its older meaning because saved line breaks count that way.
  const barLength=(()=>{const m=tune.getMeterFraction?.();return m?.num&&m?.den?m.num/m.den:1;})();
  let timeMeasure=0,extraBars=0,offset=0;
  for(const line of tune.lines)for(const item of line.staff?.[staffIndex]?.voices?.[voiceIndex]||[]){
    if(item.el_type==='note'){
      hasNotes=true;events.push({startChar:item.startChar,measure,timeMeasure,offset});
      if(item.pitches?.some(p=>!p.endTie))notes.push({index:notes.length,startChar:item.startChar,endChar:item.endChar,measure,timeMeasure,offset,pitch:item.pitches.map(p=>p.name).join('/'),duration:item.duration});
      if(item.rest?.type==='multimeasure')extraBars+=Math.max(0,Math.round((item.duration||barLength)/barLength)-1);
      offset+=item.duration||0;
    }
    if(item.el_type==='bar'&&hasNotes){bars.push({startChar:item.startChar,measure});measure++;timeMeasure+=1+extraBars;extraBars=0;offset=0;hasNotes=false;}
  }
  const sections=[];
  for(const match of abc.matchAll(/^\s*%\s*((?:intro|verse|chorus|pre[- ]?chorus|bridge|outro|refrain|interlude|solo|coda)\b[^\r\n]*)/gim)){
    const note=events.find(n=>n.startChar>match.index);if(note&&!sections.some(s=>s.measure===note.measure))sections.push({name:match[1].trim().replace(/^./,c=>c.toUpperCase()),measure:note.measure});
  }
  const groups=tune.deline({lineBreaks:false}).filter(l=>l.staff).map(l=>(l.staff[staffIndex]?.voices?.[voiceIndex]||[]).filter(n=>n.el_type==='bar').map(n=>n.startChar));
  return {notes,events,bars,sections,groups,staffIndex,voiceIndex,measures:measure+(hasNotes?1:0),timeMeasures:timeMeasure+(hasNotes?1:0)};
}
// How many bars go on each line, given how wide each one needs to be and how much room a line has. Every line is filled and the lines of a
// stretch are as even as they can be, so a sparse bar is narrow, a crowded one is wide, and no line stops short or holds one lonely bar.
export function packLines(widths,capacity){
  const n=widths.length,best=Array(n+1).fill(Infinity),from=Array(n+1).fill(0);best[0]=0;
  for(let i=1;i<=n;i++){
    let used=0;
    for(let j=i-1;j>=0;j--){
      used+=widths[j];
      if(used>capacity&&j<i-1)break;                     // too many bars for one line (a single wide bar still gets its own line)
      const slack=Math.max(0,capacity-used),cost=best[j]+slack*slack;
      if(cost<best[i]){best[i]=cost;from[i]=j;}
    }
  }
  const lengths=[];for(let i=n;i>0;i=from[i])lengths.unshift(i-from[i]);
  return lengths;
}
export function systemBreaks(analysis,settings,widths=null,capacity=0){
  // Stored manual breaks are one-based measure numbers: break after measure N.
  const forced=[...new Set([0,...settings.breaks,...analysis.sections.map(s=>s.measure),analysis.measures])].filter(n=>n>=0&&n<=analysis.measures).sort((a,b)=>a-b);
  const after=new Set(forced.filter(n=>n>0&&n<analysis.measures));
  if(settings.bars_per_line===0&&widths&&capacity>0){
    for(let i=0;i<forced.length-1;i++){
      let n=forced[i];const lengths=packLines(widths.slice(forced[i],forced[i+1]),capacity);
      for(const length of lengths.slice(0,-1)){n+=length;after.add(n);}
    }
  }else{
    const per=settings.bars_per_line||4;
    for(let i=0;i<forced.length-1;i++)for(let n=forced[i]+per;n<forced[i+1];n+=per)after.add(n);
  }
  return [...after].filter(n=>n>0&&n<analysis.measures).sort((a,b)=>a-b).map(n=>n-1);
}
export function parserBreaks(analysis,settings,widths=null,capacity=0){
  const desired=new Set(systemBreaks(analysis,settings,widths,capacity));const bySource=new Map(analysis.bars.map(b=>[b.startChar,b.measure]));
  return analysis.groups.map(group=>group.flatMap((source,index)=>desired.has(bySource.get(source))?[index]:[]));
}
// The least width each bar needs (abcjs lays a line out at its tightest when it is given almost no room), and the room a full line has.
export function naturalWidths(visual,analysis,settings,staffwidth){
  const bySource=new Map(analysis.bars.map(b=>[b.startChar,b.measure]));
  const staff=settings.show_instrumental?analysis.staffIndex:0,voiceIndex=settings.show_instrumental?analysis.voiceIndex:0;
  const widths=Array(analysis.measures).fill(null),starts=[];
  for(const line of visual?.[0]?.lines||[]){
    const voice=line.staff?.[staff]?.voices?.[voiceIndex];if(!voice)continue;
    const first=voice.find(i=>i.el_type==='note'&&i.abselem);if(!first)continue;
    let previous=first.abselem.x-8;starts.push(previous);
    for(const item of voice){
      if(item.el_type!=='bar'||!item.abselem)continue;
      const measure=bySource.get(item.startChar);
      if(measure!==undefined&&item.abselem.x>previous)widths[measure]=item.abselem.x-previous;
      previous=item.abselem.x;
    }
  }
  const known=widths.filter(w=>w!==null).sort((a,b)=>a-b),typical=known.length?known[known.length>>1]:100;
  const firstKnown=widths.findIndex(w=>w!==null),lastKnown=widths.length-1-[...widths].reverse().findIndex(w=>w!==null);
  const filled=widths.map((w,i)=>w!==null?w:(i<firstKnown||i>lastKnown?0:typical));   // bars that are not drawn (silence at the ends) take no room
  starts.sort((a,b)=>a-b);const start=starts.length?starts[starts.length>>1]:140;
  return {widths:filled,start,capacity:Math.max(200,(staffwidth+14-start)*.94)};
}
// With a fixed number of bars per line, a line can need more room than the page width gives it. Every line is then drawn that wide, so they
// all still end together (the music just looks a little smaller) instead of one line sticking out past the others.
export function widthForLines(widths,afterBars,start,staffwidth){
  const ends=new Set(afterBars);let used=0,widest=0;
  widths.forEach((w,i)=>{used+=w;if(ends.has(i)||i===widths.length-1){widest=Math.max(widest,used);used=0;}});
  return Math.max(staffwidth,Math.ceil(widest/.94+start-14));
}
// The silence before the music begins and after it ends is not part of the sheet, as in the chord chart. A bar counts as silent when it
// holds nothing but rests and no real chord; silence between the music (and any bar with a chord, like a played-through intro) stays.
// The ABC text itself is never changed: this only decides what is drawn. Returns the first and last bar numbers to keep, or null.
export function audibleBars(tune,staffIndex,voiceIndex){
  const silent=[];let now=null;
  for(const line of tune.lines||[])if(line.staff){
    for(const item of line.staff[staffIndex]?.voices?.[voiceIndex]||[]){
      if(item.el_type==='note'){
        now=now||{quiet:true};
        if(!item.rest)now.quiet=false;
        for(const chord of item.chord||[])if(chord.name&&!isNoChordLabel(chord.name))now.quiet=false;
      }else if(item.el_type==='bar'){silent.push(now?now.quiet:true);now=null;}
    }
  }
  if(now)silent.push(now.quiet);
  const first=silent.indexOf(false),last=silent.lastIndexOf(false);
  return first<0?null:{first,last,total:silent.length};
}
const isMusic=item=>item.el_type==='note'||item.el_type==='bar';
export function applyEngraving(tune,analysis,settings,syncedLyrics=null,barLengths=null){
  const bySource=new Map(analysis.notes.map(n=>[n.startChar,n]));const eventsBySource=new Map(analysis.events.map(n=>[n.startChar,n]));const anchors=new Map(settings.anchors.map(a=>[a.index,a.text]));
  const lines=[];const shown=new Set();
  const keep=settings.trim_silence===false?null:audibleBars(tune,analysis.staffIndex,analysis.voiceIndex),ordinals=new Map();let carry=[];
  let currentBeats=barLengths?.usual,lastBar=null;       // bars shorter or longer than the usual one get a real time signature (2/4) for as long as they last
  for(const line of tune.lines){
    if(line.staff&&keep&&(keep.first>0||keep.last<keep.total-1)){
      line.staff.forEach((staff,si)=>{
        for(const voice of staff.voices||[]){
          let ordinal=ordinals.get(si)??0;
          const kept=[],structure=[];
          for(const item of voice){
            const inside=ordinal>=keep.first&&ordinal<=keep.last;
            if(!isMusic(item))(inside||kept.length?kept:structure).push(item);
            else if(inside)kept.push(item);
            if(item.el_type==='bar')ordinal++;
          }
          ordinals.set(si,ordinal);
          voice.splice(0,voice.length,...kept);
          if(si===analysis.staffIndex)carry.push(...structure);
        }
      });
      if(!line.staff.some(staff=>(staff.voices||[]).some(voice=>voice.some(isMusic))))continue;      // the whole line was silence
      const own=line.staff[analysis.staffIndex]?.voices?.[analysis.voiceIndex];
      if(own&&carry.length){own.unshift(...carry.filter(item=>item.el_type==='meter'||item.el_type==='key'));carry=[];}
    }
    if(line.staff){
      const vocal=line.staff[analysis.staffIndex];
      const voice=vocal?.voices?.[analysis.voiceIndex]||[];
      const first=voice.map(n=>eventsBySource.get(n.startChar)).find(Boolean);
      if(first)for(const section of analysis.sections)if(section.measure<=first.measure&&!shown.has(section.measure)){lines.push({subtitle:{text:section.name}});shown.add(section.measure);}
      if(syncedLyrics){const sounded=voice.filter(item=>bySource.has(item.startChar));if(sounded.length&&!sounded.some(item=>syncedLyrics.has(bySource.get(item.startChar).index)))syncedLyrics=new Map([...syncedLyrics,[bySource.get(sounded[0].startChar).index,{syllable:' ',divider:' '}]]);}   // every system keeps a lyric row to click and type in
      for(const item of voice){const note=bySource.get(item.startChar);if(!note)continue;if(syncedLyrics){if(syncedLyrics.has(note.index))item.lyric=[syncedLyrics.get(note.index)];}else if(anchors.has(note.index))item.lyric=[{syllable:anchors.get(note.index),divider:' '}];}
      if(barLengths){
        const out=[];
        for(const item of voice){
          const event=eventsBySource.get(item.startChar);
          if(event&&event.timeMeasure!==lastBar){
            lastBar=event.timeMeasure;const beats=barLengths.beats[lastBar],want=Number.isFinite(beats)?beats:barLengths.usual,meter=meterOf(want);
            if(want!==currentBeats&&meter){out.push({el_type:'meter',type:'specified',value:[meter],startChar:-1,endChar:-1});currentBeats=want;}
          }
          out.push(item);
        }
        voice.splice(0,voice.length,...out);
      }
      if(!settings.show_instrumental&&vocal){line.staff=[{...vocal,voices:[voice],title:undefined}];delete line.staff[0].brace;delete line.staff[0].bracket;delete line.staff[0].connectBarLines;}
    }
    lines.push(line);
  }
  tune.lines=lines;
}
const views=new WeakMap();
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
// options: {key, content, music, title, artist, settings, chart:{content,music,documentId,revision}|null, frozen:{at,lyrics}|null,
//   dock, note (elements for the tool rail and its note), onChange(content,label), onChord(id), onSeek(seconds), onError(error),
//   onChartEdit(content,label,expected), onExternal({xml,filename}) -> Promise, onFreeze(snapshot), onUnfreeze()}
export function renderLeadSheet(container,options){
  let view=views.get(container);if(!view||!container.contains(view.root)){view=createView(container);views.set(container,view);}view.update(options);return view;
}
const LYRIC_GAP=7;         // the least clear space between one word and the next, in the score's own units
const NBSP='\u2800';         // a blank that draws nothing but is not trimmed away (a plain or no-break space would be)
const SECTION_COLOUR={verse:['--a3','--onA3'],chorus:['--a1','--onA1'],interlude:['--a2','--onA2'],bridge:['--a2','--onA2'],intro:['--tint','--ink'],outro:['--tint','--ink']};

function createView(container){
  let options={},content={},analysis=null,lyricState=null,synced=null,tool=LEAD_DEFAULT,selection=null,notices=[],busy=false;
  const root=el('div','lead-sheet'),banner=el('div','lead-banner'),notation=el('div','lead-notation');
  banner.hidden=true;
  let fontsReady=!document.fonts||document.fonts.status==='loaded';
  if(!fontsReady)document.fonts.ready.then(()=>{fontsReady=true;if(analysis)paintScore();});
  root.append(banner,notation);container.replaceChildren(root);
  const ownNote=el('div','tool-note');                      // used when the page does not hand in a place for the note (tests)
  const ownStatus=el('div','tool-status');
  let ownAttached=false;
  const attachOwn=()=>{if(!ownAttached){root.append(ownNote,ownStatus);ownAttached=true;}};
  const noteHost=()=>{if(options.note)return options.note;attachOwn();return ownNote;};
  const statusHost=()=>{if(options.status)return options.status;attachOwn();return ownStatus;};
  const settings=()=>engravingSettings(content.engraving);
  const frozen=()=>options.frozen||null;
  // A frozen copy stays as it was sent out: nothing follows the chord chart, and nothing here is edited.
  const editable=name=>!frozen()||name==='select'||name==='breaks';
  function say(text){notices=notices.filter(n=>n.warn);if(text)notices.push({text});paintNote();}
  function change(next,label){content=next;options.onChange?.(next,label);paintScore();paintNote();}
  function patch(p,label){change({...content,engraving:{...settings(),...p}},label);}

  // ---------------- the tool rail and its note ----------------
  function renderTools(){
    if(!options.dock)return;
    options.dock.dataset.owner='lead';
    renderRail(options.dock,{groups:LEAD_GROUPS,active:tool,onPick:setTool,disabled:LEAD_NAMES.filter(name=>!editable(name)),
      actions:[{id:'external',label:EXTERNAL.label,title:EXTERNAL.title,body:EXTERNAL.body,run:()=>openExternal().catch(error=>{say(error?.message||String(error));options.onError?.(error);})}]});
  }
  function setTool(next){
    if(!LEAD_NAMES.includes(next)||!editable(next))return tool;
    if(next===tool)return tool;
    tool=next;options.onTool?.(tool);
    renderTools();paintNote();paintScore();return tool;
  }
  const noteLabel=index=>{
    const note=analysis?.notes[index];if(!note)return '';
    const name=noteName(content.abc.slice(note.startChar,note.endChar),keyAccidentals());
    return `Note ${index+1}${name?' · '+name:''} · bar ${note.measure+1}`;
  };
  const keyAccidentals=()=>{try{return window.ABCJS.parseOnly(content.abc)[0].lines.find(l=>l.staff)?.staff?.[analysis.staffIndex]?.key?.accidentals||[];}catch{return [];}};
  function button(label,title,run,cls=''){const b=el('button','lead-btn '+cls,label);b.type='button';b.title=title;b.onclick=run;return b;}
  // Two quiet places: the bar above the page holds a tool's controls (only when it has some); one line under the page says what the tool
  // does, carries warnings (as a small mark with a tooltip) and the way out.
  function paintNote(){
    const host=noteHost(),status=statusHost();if(!host||!status)return;
    const controls=el('div','tool-controls'),info=TOOLS[tool];
    if(tool==='select'&&selection!==null&&analysis?.notes[selection.index]&&!frozen()){
      controls.append(el('strong','lead-selected',noteLabel(selection.index)),
        button('\u2191','Up one step (\u2191)',()=>editSelected(t=>shiftSteps(t,1),'Raise a melody note'),'icon'),
        button('\u2193','Down one step (\u2193)',()=>editSelected(t=>shiftSteps(t,-1),'Lower a melody note'),'icon'),
        button('\u266f','Sharp (#)',()=>editSelected(t=>toggleAccidental(t,'sharp'),'Sharpen a melody note'),'icon'),
        button('\u266d','Flat',()=>editSelected(t=>toggleAccidental(t,'flat'),'Flatten a melody note'),'icon'),
        button('Rest','Make this note a rest (Delete)',()=>editSelected(toRest,'Turn a melody note into a rest')));
    }
    if(tool==='breaks'){
      const seg=el('div','seg');
      controls.append(el('span','lead-label','Bars per line'));
      for(const n of [0,2,3,4,8]){const b=el('button',settings().bars_per_line===n?'on':'',n?String(n):'Auto');if(!n)b.title='Fit as many bars on each line as the music and words allow';b.type='button';b.onclick=()=>patch({bars_per_line:n},'Change lead-sheet system length');seg.append(b);}
      const staff=el('label','lead-check'),box=el('input');box.type='checkbox';box.checked=settings().show_instrumental;
      box.onchange=()=>patch({show_instrumental:box.checked},'Toggle instrumental staff');staff.append(box,document.createTextNode(' Show the instrumental staff'));
      const sizes=el('div','seg');
      for(const [id,label] of [['large','Large'],['medium','Medium'],['small','Small']]){const b=el('button',settings().music_size===id?'on':'',label);b.type='button';b.onclick=()=>patch({music_size:id},'Change lead-sheet music size');sizes.append(b);}
      controls.append(seg,staff,el('span','lead-label','Music size'),sizes);
    }
    if(frozen()){
      controls.append(button('Open again','Save and open it in the other program again',()=>openExternal().catch(error=>say(error?.message||String(error))),'link'),
        button('Follow the chord chart again','Throw away the frozen copy and show the chart\u2019s chords and words again',()=>options.onUnfreeze?.(),'link'));
    }
    host.replaceChildren(...(controls.children.length?[controls]:[]));
    // the line under the page
    const warnings=notices.filter(n=>n.warn),messages=notices.filter(n=>!n.warn);
    status.replaceChildren(el('span','status-hint',info.hint));
    if(warnings.length){
      const mark=el('span','status-warn','\u26a0 '+warnings.length);mark.dataset.tipTitle='Heads up';mark.dataset.tip=warnings.map(w=>w.text).join(' ');mark.tabIndex=0;
      status.append(mark);
    }
    if(tool!==LEAD_DEFAULT){const back=el('button','tool-put-down');back.type='button';back.innerHTML='<kbd>Esc</kbd> put it down';back.onclick=()=>setTool(LEAD_DEFAULT);status.append(back);}
    for(const n of messages)status.append(el('span','chart-message',n.text));
  }

  // ---------------- selecting and editing notes ----------------
  function selectNote(index,{seek=true}={}){
    if(!analysis?.notes[index])return;
    selection={index};markSelection();paintNote();
    const time=lyricState?.times.notes[index]?.time??notation._scoreTiming?.notes[index]?.time;
    if(seek&&Number.isFinite(time))Promise.resolve(options.onSeek?.(time)).catch(error=>options.onError?.(error));
  }
  function markSelection(){
    for(const old of notation.querySelectorAll('.lead-selbox'))old.remove();
    for(const old of notation.querySelectorAll('.lead-sel'))old.classList.remove('lead-sel');
    if(selection===null)return;
    const node=notation.querySelector(`.abcjs-note[data-score-note-index="${selection.index}"]`);if(!node)return;
    node.classList.add('lead-sel');
    const box=notation.getBoundingClientRect(),r=node.getBoundingClientRect();if(!box.width||!r.width)return;
    const k=box.width/(notation.offsetWidth||box.width)||1;                 // the page may be zoomed on screen: measure in its own units
    const mark=el('div','lead-selbox');
    mark.style.left=((r.left-box.left)/k-6)+'px';mark.style.top=((r.top-box.top)/k-6)+'px';mark.style.width=(r.width/k+12)+'px';mark.style.height=(r.height/k+12)+'px';
    notation.append(mark);
  }
  function editSelected(edit,label){
    if(frozen()||selection===null||!analysis)return false;
    const note=analysis.notes[selection.index];if(!note)return false;
    const next=editNoteInContent(content,note.startChar,note.endChar,edit);
    if(!next){say('That edit does not apply to this note.');return false;}
    notices=[];change(next,label);
    // the note may have become a rest: keep the selection on the nearest note
    if(analysis&&selection.index>=analysis.notes.length)selection={index:Math.max(0,analysis.notes.length-1)};
    markSelection();paintNote();return true;
  }

  // ---------------- line breaks ----------------
  function paintBreakChips(){
    for(const old of notation.querySelectorAll('.lead-break'))old.remove();
    if(tool!=='breaks'||!analysis)return;
    const s=settings();
    if(s.show_instrumental){say('Hide the instrumental staff to choose line breaks.');return;}
    const box=notation.getBoundingClientRect();if(!box.width)return;
    const scale=box.width/(notation.offsetWidth||box.width)||1;
    const after=systemBreaks(analysis,s).map(i=>i+1);                         // measures that end a line, 1-based counts
    const systems=[];let from=0;
    for(const end of [...after,analysis.measures])systems.push({from,end}),from=end;
    const byLine=new Map();
    for(const bar of notation.querySelectorAll('.abcjs-bar')){
      const line=/abcjs-l(\d+)/.exec(bar.getAttribute('class')||'')?.[1];if(line===undefined)continue;
      if(!byLine.has(line))byLine.set(line,[]);byLine.get(line).push(bar);
    }
    const lines=[...byLine.keys()].sort((a,b)=>Number(a)-Number(b));
    lines.forEach((line,k)=>{
      const system=systems[k];if(!system)return;
      const bars=byLine.get(line).map(node=>({node,r:node.getBoundingClientRect()})).filter(b=>b.r.height>0).sort((a,b)=>a.r.left-b.r.left);
      const count=system.end-system.from,ends=bars.length>count?bars.slice(bars.length-count):bars;       // a leading barline, if any, is not the end of a bar
      if(ends.length!==count)return;
      ends.forEach((bar,i)=>{
        const measure=system.from+i+1;                                            // this bar is measure `measure` (1-based)
        if(measure>=analysis.measures)return;
        const lastOfLine=i===count-1,manual=s.breaks.includes(measure),forced=lastOfLine&&!manual;
        const chip=el('button','lead-break'+(lastOfLine?' on':'')+(forced?' auto':''));chip.type='button';
        chip.innerHTML=toolIcon('breaks');
        chip.dataset.measure=String(measure);
        chip.setAttribute('aria-label',lastOfLine?(manual?`Remove the line break after bar ${measure}`:`Line break after bar ${measure} (automatic)`):`Start a new line after bar ${measure}`);
        chip.dataset.tip=lastOfLine?(manual?'Click to take this line break away.':'This line ends here on its own (the bars-per-line setting or a new section). Change that setting to move it.'):'Start a new line here.';
        chip.dataset.tipTitle=lastOfLine?'Line break':'New line here';
        chip.style.left=((bar.r.right-box.left)/scale)+'px';chip.style.top=((bar.r.top-box.top)/scale-14)+'px';
        if(forced)chip.disabled=true;
        else chip.onclick=()=>patch({breaks:manual?s.breaks.filter(x=>x!==measure):[...s.breaks,measure].sort((a,b)=>a-b)},'Toggle lead-sheet system break');
        notation.append(chip);
      });
    });
  }

  // ---------------- lyrics under the staves ----------------
  const sectionIdAt=seconds=>Number.isFinite(seconds)?(options.chart.content.sections||[]).find(s=>seconds>=s.start-1e-6&&seconds<s.end-1e-6)?.id??null:null;
  function paintLyricEditors(){
    for(const old of notation.querySelectorAll('.lead-run'))old.remove();
    if(tool!=='lyrics'||frozen()||!lyricState||!options.onChartEdit||settings().show_instrumental){if(tool==='lyrics'&&settings().show_instrumental)say('Hide the instrumental staff to type lyrics.');return;}
    const box=notation.getBoundingClientRect();if(!box.width||!box.height)return;
    const rel=node=>{const r=node.getBoundingClientRect();return {left:r.left-box.left,right:r.right-box.left,top:r.top-box.top,bottom:r.bottom-box.top};};
    const systems=new Map();
    for(const node of notation.querySelectorAll('.abcjs-note[data-score-note-index]')){
      const line=/abcjs-l(\d+)/.exec(node.getAttribute('class')||'')?.[1];if(line===undefined)continue;
      if(!systems.has(line))systems.set(line,{key:line,notes:[],lyricTop:Infinity,lyricBottom:-Infinity,noteBottom:-Infinity});
      const system=systems.get(line),r=rel(node),index=Number(node.dataset.scoreNoteIndex);system.notes.push({index,...r,sectionId:sectionIdAt(lyricState.times.notes[index]?.time)});system.noteBottom=Math.max(system.noteBottom,r.bottom);
    }
    for(const node of notation.querySelectorAll('.abcjs-lyric')){
      const line=/abcjs-l(\d+)/.exec(node.getAttribute('class')||'')?.[1],system=systems.get(line);if(!system)continue;
      const r=rel(node);system.lyricTop=Math.min(system.lyricTop,r.top);system.lyricBottom=Math.max(system.lyricBottom,r.bottom);
    }
    for(const system of systems.values())if(!Number.isFinite(system.lyricTop)){system.lyricTop=system.noteBottom+8;system.lyricBottom=system.noteBottom+24;}
    const ctx={content:options.chart.content,music:options.chart.music,measures:lyricState.measures,times:lyricState.times};
    mountLyricEditors(notation,{systems:[...systems.values()],byNote:lyricState.placed.byNote,ctx,onError:error=>{say(error?.message||String(error));options.onError?.(error);},
      onCommit:async result=>{await options.onChartEdit(result.content,result.label,{documentId:options.chart.documentId,revision:options.chart.revision});
        if(result.lost)say(result.lost===1?'One pinned word no longer exists, so its pin was removed. Undo brings it back.':result.lost+' pinned words no longer exist, so their pins were removed. Undo brings them back.');}});
  }

  // ---------------- drawing ----------------
  // Redrawing empties the page for a moment; keep the reader where they were.
  function paintScore(){const desk=root.closest?.('.desk'),top=desk?.scrollTop;paintScoreNow();if(desk&&top)desk.scrollTo?.({top,behavior:'instant'});}
  // The section names that abcjs writes as plain text become little coloured tags, like the chord chart's.
  function tagSections(){
    for(const text of notation.querySelectorAll('.abcjs-subtitle')){
      const name=text.textContent.trim(),key=name.toLowerCase().replace(/[^a-z]/g,'');
      const group=text.parentNode;if(!group||text.dataset.tagged)continue;text.dataset.tagged='1';
      text.classList.add('lead-section-name');      // the capitals and letter spacing first, so the tag is measured as it will look
      try{
        const box=text.getBBox(),rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
        rect.setAttribute('x',box.x-12);rect.setAttribute('y',box.y-4);rect.setAttribute('width',box.width+24);rect.setAttribute('height',box.height+8);rect.setAttribute('rx',6);
        rect.setAttribute('class','lead-section-tag');const [bg,fg]=SECTION_COLOUR[key]||['--tint','--ink'];rect.style.fill=`var(${bg})`;text.style.fill=`var(${fg})`;
        group.insertBefore(rect,text);
      }catch{/* not drawn yet */}
    }
  }
  // A section tag needs air: clear space after the lyrics above it, and between it and the chord names of the line below it. abcjs puts
  // the tag a fixed distance from its neighbours, so each tag is nudged apart and everything below moves down with it.
  const TAG_BEFORE=16,TAG_AFTER=12;
  function spaceSections(){
    const svg=notation.querySelector('svg');if(!svg)return;
    const groups=[...svg.children].filter(n=>n.tagName==='g'&&n.getBBox);
    const isStaff=n=>n.classList.contains('abcjs-staff-wrapper');
    let total=0,previousBottom=null;
    groups.forEach((group,index)=>{
      const box=group.getBBox();
      if(group.classList.contains('abcjs-non-music')&&group.querySelector('.lead-section-tag')){
        const next=groups.slice(index+1).find(isStaff);
        if(previousBottom!==null)total+=Math.max(0,TAG_BEFORE-(box.y-previousBottom));
        if(total)group.setAttribute('transform',`translate(0 ${total})`);
        if(next)total+=Math.max(0,TAG_AFTER-(next.getBBox().y-(box.y+box.height)));
        return;
      }
      if(total)group.setAttribute('transform',`translate(0 ${total})`);
      if(isStaff(group))previousBottom=box.y+box.height;
    });
    const frame=svg.viewBox?.baseVal;
    if(total&&frame?.height){
      svg.setAttribute('viewBox',`${frame.x} ${frame.y} ${frame.width} ${frame.height+total}`);
      const holder=svg.parentElement,pad=parseFloat(holder?.style?.paddingBottom);
      if(holder&&pad)holder.style.paddingBottom=(pad*(frame.height+total)/frame.height)+'%';
    }
  }
  // Words that would sit on top of each other (a whole word on a quick note): the notes need more room, as in printed music. For every word
  // that runs into the next one, returns how many invisible spaces to add after it. The score is drawn again with those spaces, and
  // abcjs spreads the notes to make room for them, so the bar simply gets longer.
  let printing=false;                                                            // while the sheet is being printed or saved as a PDF
  let drawnNotes=new Map();                                                      // startChar of a note in the ABC text -> the shape drawn for it
  let drawnChords=[];                                                            // {start,end,node}: each drawn chord symbol and the stretch of ABC text it belongs to
  function mapDrawnNotes(visual){
    const found=new Map();drawnChords=[];
    for(const line of visual?.[0]?.lines||[])for(const staff of line.staff||[])for(const voice of staff.voices||[])for(const item of voice){
      const node=item.abselem?.elemset?.[0];
      if(node&&Number.isInteger(item.startChar)&&!found.has(item.startChar)){
        found.set(item.startChar,node);
        const chord=item.chord?.length?node.querySelector?.('.abcjs-chord'):null;
        if(chord)drawnChords.push({start:item.startChar,end:item.endChar,node:chord});
      }
    }
    return found;
  }
  const chordNodeAt=abcIndex=>drawnChords.find(c=>abcIndex>=c.start&&abcIndex<c.end)?.node||null;
  function lyricCrowding(){
    const need=new Map();if(!synced||!analysis)return need;
    const lineOf=node=>/abcjs-l(\d+)/.exec(node.getAttribute('class')||'')?.[1];
    const lines=new Map();
    const entry=line=>{if(!lines.has(line))lines.set(line,{notes:[],lyrics:[]});return lines.get(line);};
    analysis.notes.forEach((note,index)=>{
      const node=drawnNotes.get(note.startChar);if(!node)return;
      const line=lineOf(node);if(line===undefined)return;
      try{const b=node.getBBox();entry(line).notes.push({index,x:b.x+b.width/2});}catch{/* not drawn yet */}
    });
    // each word belongs to the note it is centred under; its width is the part you can see (the blank padding is not counted)
    for(const node of notation.querySelectorAll('.abcjs-lyric')){
      const line=lineOf(node);if(line===undefined||!lines.has(line))continue;
      try{
        const text=node.textContent,visible=text.replace(/\u2800+$/,''),padChars=text.length-visible.length;
        if(!visible.trim())continue;
        const box=node.getBBox(),start=node.getStartPositionOfChar(0).x,end=node.getEndPositionOfChar(visible.length-1).x;
        const centre=Number(node.getAttribute('x'))||box.x+box.width/2,own=lines.get(line).notes.reduce((best,n)=>!best||Math.abs(n.x-centre)<Math.abs(best.x-centre)?n:best,null);
        const padWidth=padChars?Math.max(2,(box.width-(end-start))/padChars):Math.max(4,(end-start)/visible.length);
        if(own)lines.get(line).lyrics.push({note:own.index,x:start,end,padWidth,chars:visible.length});
      }catch{/* not drawn yet */}
    }
    for(const {lyrics} of lines.values()){
      lyrics.sort((a,b)=>a.x-b.x);
      for(let k=0;k<lyrics.length-1;k++){
        const gap=lyrics[k+1].x-lyrics[k].end;
        if(gap<LYRIC_GAP)need.set(lyrics[k].note,Math.ceil((LYRIC_GAP-gap)/lyrics[k].padWidth));
      }
    }
    return need;
  }
  function paintScoreNow(){
    const s=settings();
    notation.replaceChildren();analysis=null;lyricState=null;synced=null;notices=[];
    paintBanner();
    if(!content.abc?.trim()){say('No ABC notation is available.');return;}
    const abcjs=window.ABCJS;if(!abcjs){say('The notation renderer is unavailable. The sheet cannot be drawn.');return;}
    try{
      analysis=analyzeScore(content.abc,abcjs);notation._scoreTiming=mapScoreTiming(analysis,options.music);
      const beatMeasures=options.chart?.content?effectiveMeasures(options.chart.music,options.chart.content.layout):(options.music?.measures||[]);
      const barLengths=beatMeasures.length?{usual:usualBeats(beatMeasures),beats:beatMeasures.map(m=>m.beats.length)}:null;
      // The words come from the chord chart (one home for them), or from the frozen copy; here we only decide which note each word sits on.
      if(frozen())synced=new Map((frozen().lyrics||[]).map(([index,syllable,divider])=>[index,{syllable,divider}]));
      else if(options.chart?.content){
        const measures=effectiveMeasures(options.chart.music,options.chart.content.layout),times=scoreNoteTimes(analysis,measures),placed=placeLyricsOnNotes(options.chart.content,measures,times.notes);
        lyricState={measures,times,placed};synced=new Map([...placed.byNote].map(([index,words])=>[index,lyricForNote(words)]));
        const stray=placed.unplaced.reduce((n,u)=>n+u.words,0);
        if(!times.exact)notices.push({warn:true,text:'The score and the chord chart do not have the same number of bars, so words may sit on the wrong notes.'});
        if(stray)notices.push({warn:true,text:`${stray} word${stray===1?' is':'s are'} in a stretch with no melody notes.`});
      }
      const pads=new Map();                                     // extra spaces after a word, so crowded notes spread out
      const shown=()=>synced&&new Map([...synced].map(([index,word])=>[index,pads.get(index)?{...word,syllable:word.syllable+NBSP.repeat(pads.get(index))}:word]));
      const draw=(staffwidth,breaks=parserBreaks(analysis,s))=>abcjs.renderAbc(notation,content.abc,{responsive:'resize',add_classes:true,staffwidth,paddingtop:12,paddingbottom:26,lineBreaks:breaks,oneSvgPerLine:printing,
        format:{stretchlast:true,gchordfont:'Bricolage Grotesque 17 bold',vocalfont:'Courier Prime 13.5',annotationfont:'Courier Prime 11',subtitlefont:'Bricolage Grotesque 15 bold',vocalspace:8,musicspace:14,staffsep:34,systemsep:20},
        afterParsing:tune=>{
          for(const line of tune.lines||[])for(const staff of line.staff||[])for(const voice of staff.voices||[])for(const item of voice)for(const annotation of item.chord||[])if(annotation.name!==undefined&&isNoChordLabel(annotation.name))annotation.name='';
          decorateScoreConfidence(tune,content,options.music,options.settings);applyEngraving(tune,analysis,s,shown(),barLengths);
          if(tune.metaText)tune.metaText.title='';      // the song's name is in the page header, not in the score
        },
        clickListener:(abcElement,tuneNumber,classes,analysisArg,drag,mouseEvent)=>onScoreClick(abcElement,String(classes||''),mouseEvent)});
      // Long lyrics, and ties that run on into the next system, can hang over the edge of the drawing and would be cut off. Measure everything
      // that was drawn and widen the drawing's frame to hold it (the display then scales it down a little to fit).
      // With "Auto" lines, first measure how wide each bar needs to be (with the words as they now stand), then fill each line with as many as fit.
      const base=STAFF_UNITS[s.music_size]||STAFF_UNITS.medium;
      const flow=()=>{
        const tight=draw(1,analysis.groups.map(()=>[])),measured=naturalWidths(tight,analysis,s,base);
        if(s.bars_per_line===0)return {breaks:parserBreaks(analysis,s,measured.widths,measured.capacity),width:base};
        return {breaks:parserBreaks(analysis,s),width:widthForLines(measured.widths,systemBreaks(analysis,s).map(i=>i),measured.start,base)};
      };
      const drawFlow=()=>{const f=flow();return mapDrawnNotes(draw(f.width,f.breaks));};
      drawnNotes=drawFlow();
      for(let pass=0;pass<8;pass++){
        const need=lyricCrowding();if(!need.size)break;
        for(const [index,count] of need)pads.set(index,Math.min(40,(pads.get(index)||0)+count));
        drawnNotes=drawFlow();
      }
      tagSections();
      if(printing){
        for(const picture of notation.querySelectorAll('svg'))if(picture.querySelector('.lead-section-tag'))picture.classList.add('lead-tag-picture');
        analysis.notes.forEach((note,index)=>{const node=drawnNotes.get(note.startChar);if(node)node.dataset.scoreNoteIndex=String(index);});
        return;                                                           // no selection, editors or chips on paper
      }
      spaceSections();
      const drawn=notation.querySelector('svg');
      if(drawn?.viewBox?.baseVal?.width){
        try{
          const all=drawn.getBBox(),frame=drawn.viewBox.baseVal,right=Math.ceil(all.x+all.width+28),left=Math.min(frame.x,Math.floor(all.x-12));
          if(right>frame.x+frame.width||left<frame.x)drawn.setAttribute('viewBox',`${left} ${frame.y} ${Math.max(frame.x+frame.width,right)-left} ${frame.height}`);
        }catch{/* not drawn yet */}
      }
      analysis.notes.forEach((note,index)=>{const node=drawnNotes.get(note.startChar);if(node)node.dataset.scoreNoteIndex=String(index);});
      for(const group of notation.querySelectorAll('.abcjs-chord')){const chord=content.chords?.find(c=>{const shown=group.textContent.trim();return shown.startsWith(c.label)||shown.startsWith(spellChord(c.label));});if(chord)group.style.opacity=String(chordOpacity(chord,options.music,options.settings));}
      markSelection();paintLyricEditors();paintBreakChips();
      root.dataset.tool=tool;
    }catch(error){say(`The notation could not be rendered: ${error.message}`);options.onError?.(error);}
  }
  // The chord's name becomes a small box right on the symbol, as in the chord chart: type, then Enter (or click away) to keep it, Esc to leave it.
  function editChordInline(chord,mouseEvent){
    notation.querySelector('.lead-chord-input')?.remove();
    const node=chordNodeAt(chord.abc_index);if(!node)return;
    let list=root.querySelector('#lead-chord-list');
    if(!list){list=el('datalist');list.id='lead-chord-list';for(const name of CHORD_SUGGESTIONS){const o=el('option');o.value=name;list.append(o);}root.append(list);}
    const box=node.getBoundingClientRect(),frame=notation.getBoundingClientRect(),k=frame.width/(notation.offsetWidth||frame.width)||1;
    const input=el('input','lead-chord-input');input.value=spellChord(chord.label);input.setAttribute('list','lead-chord-list');input.setAttribute('aria-label','Chord');input.autocomplete='off';input.spellcheck=false;
    input.style.left=Math.round((box.left-frame.left)/k-15)+'px';input.style.top=Math.round((box.top-frame.top)/k-5)+'px';input.style.width=Math.max(64,Math.round(box.width/k)+30)+'px';input.style.height=Math.round(box.height/k+10)+'px';
    let done=false;
    const finish=keep=>{
      if(done)return;done=true;input.remove();
      if(!keep||input.value.trim()===chord.label||input.value.trim()===spellChord(chord.label))return;
      Promise.resolve(options.onChord?.(chord.id,input.value)).catch(error=>{say(error?.message||String(error));options.onError?.(error);});
    };
    input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();finish(true);}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}else event.stopPropagation();};
    input.onblur=()=>finish(true);
    notation.append(input);input.focus();input.select();
    setTimeout(()=>{if(!done&&document.activeElement!==input)input.focus();if(!done)input.select();},0);     // the click that opened it is still finishing: select again afterwards so typing replaces the name
  }
  function onScoreClick(abcElement,classes,mouseEvent){
    const position=abcElement?.startChar;if(!Number.isInteger(position))return;
    const note=analysis?.notes.find(n=>n.startChar===position);
    if(tool==='chords'&&editable('chords')){
      const chord=content.chords?.find(c=>Number.isInteger(c.abc_index)&&c.abc_index>=abcElement.startChar&&c.abc_index<abcElement.endChar);
      if(chord)editChordInline(chord,mouseEvent);else say('There is no chord symbol on this note.');
      return;
    }
    if(tool==='select'&&note)selectNote(note.index);
  }
  function paintBanner(){
    const f=frozen();banner.hidden=!f;
    if(!f){banner.replaceChildren();return;}
    const when=f.at?new Date(f.at).toLocaleString([],{dateStyle:'medium',timeStyle:'short'}):'';
    banner.replaceChildren(el('strong','','Frozen copy'),el('span','',' Sent to another editor'+(when?' on '+when:'')+'. It no longer follows the chord chart, and Chord Buddy does not read your changes back.'));
  }

  // ---------------- open in another editor ----------------
  async function openExternal(){
    if(busy)return;
    const abcjs=window.ABCJS;if(!abcjs||!analysis)throw new Error('The score is not ready yet.');
    busy=true;
    try{
      const tune=abcjs.parseOnly(content.abc)[0];
      const chordsFor=item=>{
        const own=(content.chords||[]).filter(c=>Number.isInteger(c.abc_index)&&c.abc_index>=item.startChar&&c.abc_index<item.endChar).map(c=>c.label);
        return (own.length?own:(item.chord||[]).map(c=>c.name)).filter(name=>name&&!isNoChordLabel(name));
      };
      const xml=tuneToMusicXml(tune,{title:options.title,artist:options.artist,staffIndex:analysis.staffIndex,voiceIndex:analysis.voiceIndex,lyrics:synced||new Map(),chordsFor,tempo:options.music?.timing?.bpm});
      const result=await options.onExternal?.({xml,filename:exportFileName(options.title)});
      // From now on the lead sheet is a frozen copy: what the chord chart said when it was sent.
      if(!frozen())options.onFreeze?.({at:new Date().toISOString(),lyrics:[...(synced||new Map())].map(([index,w])=>[index,w.syllable,w.divider])});
      if(result?.message)say(result.message);
    }finally{busy=false;}
  }

  // ---------------- keys ----------------
  // Returns true when the key was used. Only call while the lead sheet is showing and nobody is typing.
  function handleKey(event){
    if(event.key==='Escape'){if(tool===LEAD_DEFAULT&&selection===null)return false;if(tool!==LEAD_DEFAULT)setTool(LEAD_DEFAULT);else{selection=null;markSelection();paintNote();}return true;}
    const letter=String(event.key||'').toUpperCase();
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&LEAD_FOR_KEY[letter]&&event.key.length===1){setTool(LEAD_FOR_KEY[letter]);return true;}
    if(tool!=='select'||!analysis)return false;
    const count=analysis.notes.length;if(!count)return false;
    if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
      const next=selection===null?0:Math.max(0,Math.min(count-1,selection.index+(event.key==='ArrowRight'?1:-1)));
      selectNote(next);return true;
    }
    if(selection===null)return false;
    if(event.key==='ArrowUp'||event.key==='ArrowDown'){
      const steps=(event.key==='ArrowUp'?1:-1)*(event.shiftKey?7:1);
      return editSelected(t=>shiftSteps(t,steps),event.key==='ArrowUp'?'Raise a melody note':'Lower a melody note')||true;
    }
    if(event.key==='Delete'||event.key==='Backspace'||event.key==='0'){editSelected(toRest,'Turn a melody note into a rest');return true;}
    if(event.key==='#'){editSelected(t=>toggleAccidental(t,'sharp'),'Sharpen a melody note');return true;}
    return false;
  }

  // Draws the sheet for paper (and puts it back afterwards). The caller prints in between.
  function printMode(on){if(printing===on)return;printing=on;paintScoreNow();if(!on){markSelection();}}
  return {root,getTool:()=>tool,setTool,handleKey,printMode,chordNodeAt,showTools(){renderTools();paintNote();markSelection();},
    update(next){
      if(options.key!==next.key){selection=null;tool=LEAD_DEFAULT;}
      options=next;content=next.content||{};
      if(!editable(tool))tool=LEAD_DEFAULT;
      options.onTool?.(tool);
      paintScore();renderTools();paintNote();
    }};
}
