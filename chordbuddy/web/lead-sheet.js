// Display-only engraving. ABC source and chord character offsets are never rewritten.
import {decorateScoreConfidence,chordOpacity} from './confidence-view.js';
import {isNoChordLabel,effectiveMeasures} from './chart-layout.js';
import {scoreNoteTimes,placeLyricsOnNotes,lyricForNote} from './lead-lyrics.js';
import {mountLyricEditors} from './lead-lyric-editor.js';
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
export function updateLeadSheetPlayback(container,timing,time){
  const active=activeScoreTiming(timing,time);
  for(const node of container?.querySelectorAll?.('[data-score-note-index]')||[]){const note=timing?.notes?.[Number(node.dataset.scoreNoteIndex)];node.classList.toggle('current-beat',!!active&&note?.measure===active.measure&&note?.beat===active.beat);node.classList.toggle('current-measure',!!active&&note?.measure===active.measure);}
  return active;
}
export function engravingSettings(value={}) {
  return {bars_per_line:[2,3,4,8].includes(value.bars_per_line)?value.bars_per_line:4,
    breaks:Array.isArray(value.breaks)?value.breaks.filter(n=>Number.isInteger(n)&&n>0):[],
    show_instrumental:value.show_instrumental===true,lyrics_text:typeof value.lyrics_text==='string'?value.lyrics_text:'',
    anchors:Array.isArray(value.anchors)?value.anchors.filter(a=>Number.isInteger(a.index)&&a.index>=0&&typeof a.text==='string').map(a=>({...a})):[]};
}
export const splitLyrics=text=>String(text).split(/[\s-]+/u).filter(Boolean);
export function placeAnchor(content,index,text,fromIndex=null){
  const engraving=engravingSettings(content.engraving);
  engraving.anchors=engraving.anchors.filter(a=>a.index!==index&&a.index!==fromIndex);
  if(text)engraving.anchors.push({index,text});engraving.anchors.sort((a,b)=>a.index-b.index);
  return {...content,engraving};
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
export function systemBreaks(analysis,settings){
  // Stored manual breaks are one-based measure numbers: break after measure N.
  const forced=[...new Set([0,...settings.breaks,...analysis.sections.map(s=>s.measure),analysis.measures])].filter(n=>n>=0&&n<=analysis.measures).sort((a,b)=>a-b);
  const after=new Set(forced.filter(n=>n>0&&n<analysis.measures));
  for(let i=0;i<forced.length-1;i++)for(let n=forced[i]+settings.bars_per_line;n<forced[i+1];n+=settings.bars_per_line)after.add(n);
  return [...after].filter(n=>n>0&&n<analysis.measures).sort((a,b)=>a-b).map(n=>n-1);
}
export function parserBreaks(analysis,settings){
  const desired=new Set(systemBreaks(analysis,settings));const bySource=new Map(analysis.bars.map(b=>[b.startChar,b.measure]));
  return analysis.groups.map(group=>group.flatMap((source,index)=>desired.has(bySource.get(source))?[index]:[]));
}
export function applyEngraving(tune,analysis,settings,syncedLyrics=null,barLengths=null){
  const bySource=new Map(analysis.notes.map(n=>[n.startChar,n]));const eventsBySource=new Map(analysis.events.map(n=>[n.startChar,n]));const anchors=new Map(settings.anchors.map(a=>[a.index,a.text]));
  const lines=[];const shown=new Set();
  let currentBeats=barLengths?.usual,lastBar=null;       // bars shorter or longer than the usual one get a real time signature (2/4) for as long as they last
  for(const line of tune.lines){
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
      if(!settings.show_instrumental&&vocal){line.staff=[{...vocal,voices:[voice],title:vocal.title?[vocal.title[analysis.voiceIndex]||vocal.title[0]]:undefined}];delete line.staff[0].brace;delete line.staff[0].bracket;delete line.staff[0].connectBarLines;}
    }
    lines.push(line);
  }
  tune.lines=lines;
}
const views=new WeakMap();
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
export function renderLeadSheet(container,options){
  let view=views.get(container);if(!view||!container.contains(view.root)){view=createView(container);views.set(container,view);}view.update(options);return view;
}
function createView(container){
  let options={},content={},analysis=null,selected=null,moving=null,inlineEditor=null,lyricState=null;
  const root=el('div','lead-sheet'),controls=el('div','lead-controls'),notation=el('div','lead-notation'),message=el('p','lead-help');
  const bars=el('select'),instruments=el('input'),breakAfter=el('select'),breakButton=el('button','','Toggle break'),breakList=el('span','lead-help');
  instruments.type='checkbox';for(const n of [2,3,4,8]){const option=el('option','',`${n} bars`);option.value=n;bars.append(option);}
  function label(text,control){const l=el('label','',text);l.append(control);return l;}
  controls.append(label('Per system ',bars),label(' Instrumental staff ',instruments),label(' Break after ',breakAfter),breakButton,breakList);
  const details=el('details','lead-lyrics');details.open=true;details.append(el('summary','','Place lyrics on melody notes'));
  const textarea=el('textarea');textarea.rows=3;textarea.placeholder='Paste lyrics. Use spaces or hyphens to split words or syllables.';textarea.setAttribute('aria-label','Lyrics to place manually');
  const tray=el('div','lead-tray'),anchors=el('div','lead-anchors'),cancel=el('button','','Cancel selection');
  const status=el('p','lead-help','Select a word or syllable, then click a melody note. Lyrics are never placed automatically.');
  const actions=el('div','lead-controls');actions.append(cancel);
  details.append(textarea,status,el('strong','','Unplaced words / syllables'),tray,actions,el('strong','','Placed lyrics — select to move'),anchors);
  root.append(controls,message,details,notation);container.replaceChildren(root);
  function settings(){return engravingSettings(content.engraving);}
  function change(next,label,draw=true){content=next;options.onChange?.(next,label);if(draw){paintTray();paintScore();}}
  function patch(p,label,draw=true){change({...content,engraving:{...settings(),...p}},label,draw);}
  function beginInlineLyric(note){
    if(inlineEditor){inlineEditor.blur();}
    const input=el('input','lead-inline-editor');input.type='text';input.placeholder='Type lyric';input.setAttribute('aria-label',`Lyric for melody note ${note.index+1}`);
    input.value=settings().anchors.find(anchor=>anchor.index===note.index)?.text||'';inlineEditor=input;notation.append(input);input.focus();input.select();
    input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();input.blur();}if(event.key==='Escape'){input.value='';input.blur();}};
    input.onblur=()=>{if(inlineEditor!==input)return;inlineEditor=null;const value=input.value.trim();input.remove();if(value||settings().anchors.some(anchor=>anchor.index===note.index))change(placeAnchor(content,note.index,value),'Edit lyric on melody note');};
  }
  bars.onchange=()=>patch({bars_per_line:Number(bars.value)},'Change lead-sheet system length');
  instruments.onchange=()=>patch({show_instrumental:instruments.checked},'Toggle instrumental staff');
  breakButton.onclick=()=>{const n=Number(breakAfter.value),s=settings();if(!n)return;patch({breaks:s.breaks.includes(n)?s.breaks.filter(x=>x!==n):[...s.breaks,n].sort((a,b)=>a-b)},'Toggle lead-sheet system break');};
  textarea.oninput=()=>{patch({lyrics_text:textarea.value},'Edit lead-sheet lyrics',false);paintTray();};
  cancel.onclick=()=>{selected=null;moving=null;paintTray();};
  function place(index){if(selected===null)return;change(placeAnchor(content,index,selected,moving),'Place lead-sheet syllable',false);selected=null;moving=null;paintTray();paintScore();}
  function paintTray(){
    const s=settings();tray.replaceChildren();anchors.replaceChildren();
    const used=s.anchors.map(a=>a.text);
    for(const word of splitLyrics(s.lyrics_text)){const index=used.indexOf(word);if(index>=0){used.splice(index,1);continue;}const b=el('button',selected===word&&moving===null?'selected':'',word);b.onclick=()=>{selected=word;moving=null;paintTray();};tray.append(b);}
    if(!tray.childNodes.length)tray.append(el('span','lead-help',s.lyrics_text?'All matching words have been placed.':'Paste lyrics above to begin.'));
    status.textContent=selected===null?'Select a word or syllable, then click a melody note. Lyrics are never placed automatically.':`${moving===null?'Place':'Move'} “${selected}”: click a melody note.`;
    cancel.disabled=selected===null;
  }
  // Editable lyric lines in the lyric space under each system (see lead-lyric-editor.js).
  const sectionIdAt=seconds=>Number.isFinite(seconds)?(options.chart.content.sections||[]).find(s=>seconds>=s.start-1e-6&&seconds<s.end-1e-6)?.id??null:null;
  function paintLyricEditors(){
    for(const old of notation.querySelectorAll('.lead-run'))old.remove();
    if(!lyricState||!options.onChartEdit||settings().show_instrumental)return;
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
    mountLyricEditors(notation,{systems:[...systems.values()],byNote:lyricState.placed.byNote,ctx,onError:error=>{message.textContent=error?.message||String(error);options.onError?.(error);},
      onCommit:async result=>{await options.onChartEdit(result.content,result.label,{documentId:options.chart.documentId,revision:options.chart.revision});
        if(result.lost)message.textContent=result.lost===1?'One pinned word no longer exists, so its pin was removed. Undo brings it back.':result.lost+' pinned words no longer exist, so their pins were removed. Undo brings them back.';}});
  }
  // Redrawing empties the page for a moment; keep the reader where they were.
  function paintScore(){const desk=root.closest?.('.desk'),top=desk?.scrollTop;paintScoreNow();if(desk&&top)desk.scrollTop=top;}
  function paintScoreNow(){
    const s=settings();bars.value=s.bars_per_line;instruments.checked=s.show_instrumental;breakList.textContent=s.breaks.length?`Manual breaks: ${s.breaks.join(', ')}`:'';
    const previousBreak=breakAfter.value;notation.replaceChildren();analysis=null;breakAfter.replaceChildren();breakButton.disabled=true;if(!content.abc?.trim()){message.textContent='No ABC notation is available.';return;}
    const abcjs=window.ABCJS;if(!abcjs){message.textContent='The notation renderer is unavailable. You can still edit the ABC source.';return;}
    try{
      analysis=analyzeScore(content.abc,abcjs);notation._scoreTiming=mapScoreTiming(analysis,options.music);
      // The lyrics come from the chart (one home for the words); here we only decide which note each word sits on.
      lyricState=null;let synced=null;
      const beatMeasures=options.chart?.content?effectiveMeasures(options.chart.music,options.chart.content.layout):(options.music?.measures||[]);
      const barLengths=beatMeasures.length?{usual:usualBeats(beatMeasures),beats:beatMeasures.map(m=>m.beats.length)}:null;
      if(options.chart?.content){
        const measures=effectiveMeasures(options.chart.music,options.chart.content.layout),times=scoreNoteTimes(analysis,measures),placed=placeLyricsOnNotes(options.chart.content,measures,times.notes);
        lyricState={measures,times,placed};synced=new Map([...placed.byNote].map(([index,words])=>[index,lyricForNote(words)]));
      }
      details.classList.toggle('hidden',!!options.chart?.content);
      const stray=lyricState?.placed.unplaced.reduce((n,u)=>n+u.words,0)||0;
      message.textContent=lyricState?`${analysis.measures} measures · ${analysis.notes.length} melody notes. Lyrics are shared with the chart.${lyricState.times.exact?'':' The score and the chart do not have the same number of bars, so words may sit on the wrong notes.'}${stray?` ${stray} word${stray===1?' is':'s are'} in a stretch with no melody notes.`:''}`:`${analysis.measures} measures · ${analysis.notes.length} melody notes. Select placed lyrics to move or clear them.`;
      breakAfter.replaceChildren();for(let n=1;n<analysis.measures;n++){const o=el('option','',`Bar ${n}`);o.value=n;breakAfter.append(o);}if([...breakAfter.options].some(o=>o.value===previousBreak))breakAfter.value=previousBreak;breakButton.disabled=analysis.measures<2;
      const draw=staffwidth=>abcjs.renderAbc(notation,content.abc,{responsive:'resize',add_classes:true,staffwidth,paddingtop:8,paddingbottom:18,lineBreaks:parserBreaks(analysis,s),afterParsing:tune=>{for(const line of tune.lines||[])for(const staff of line.staff||[])for(const voice of staff.voices||[])for(const item of voice)for(const annotation of item.chord||[])if(annotation.name!==undefined&&isNoChordLabel(annotation.name))annotation.name='';decorateScoreConfidence(tune,content,options.music,options.settings);applyEngraving(tune,analysis,s,synced,barLengths);if(options.title)tune.metaText.title=options.title;},clickListener:abcElement=>{
        const position=abcElement?.startChar;if(!Number.isInteger(position))return;
        const note=analysis.notes.find(n=>n.startChar===position);
        if(note){if(lyricState)return;if(selected!==null){place(note.index);return;}beginInlineLyric(note);return;}
        const chord=content.chords?.find(c=>Number.isInteger(c.abc_index)&&((position>=c.abc_index&&position<=c.abc_index+c.label.length+2)||(position<=c.abc_index&&abcElement.endChar>c.abc_index)));if(chord)options.onChord?.(chord.id);
      }});
      // Long lyrics, and ties that run on into the next system, can hang over the edge of the drawing and would be cut off. Measure everything
      // that was drawn and widen the drawing's frame to hold it (the display then scales it down a little to fit).
      draw(760);
      const drawn=notation.querySelector('svg');
      if(drawn?.viewBox?.baseVal?.width){
        try{
          const all=drawn.getBBox(),frame=drawn.viewBox.baseVal,right=Math.ceil(all.x+all.width+28),left=Math.min(frame.x,Math.floor(all.x-12));
          if(right>frame.x+frame.width||left<frame.x)drawn.setAttribute('viewBox',`${left} ${frame.y} ${Math.max(frame.x+frame.width,right)-left} ${frame.height}`);
        }catch{/* not drawn yet */}
      }
      const noteNodes=notation.querySelectorAll('.abcjs-note');analysis.notes.forEach((note,index)=>{const node=noteNodes[index];if(node)node.dataset.scoreNoteIndex=String(index);});
      paintLyricEditors();
      for(const group of notation.querySelectorAll('.abcjs-chord')){const chord=content.chords?.find(c=>group.textContent.trim().startsWith(c.label));if(chord)group.style.opacity=String(chordOpacity(chord,options.music,options.settings));}
    }catch(error){message.textContent=`The notation could not be rendered: ${error.message}`;options.onError?.(error);}
  }
  return {root,update(next){if(options.key!==next.key){selected=null;moving=null;}options=next;content=next.content||{};if(document.activeElement!==textarea)textarea.value=settings().lyrics_text;paintScore();paintTray();}};
}




