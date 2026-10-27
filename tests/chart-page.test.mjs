import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountChartPage,chordTokens,alignChords} from '../chordbuddy/web/chart-page.js';
import {buildChartModel,playbackTarget} from '../chordbuddy/web/chart-model.js';
import {buildCompactChart} from '../chordbuddy/web/compact-chart.js';
import {buildPracticeMarkers} from '../chordbuddy/web/practice-state.js';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
const has=(n,c)=>n.className.split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const chordButtons=root=>byClass(root,'chord').filter(n=>n.tagName==='button');
const tick=()=>new Promise(r=>setImmediate(r));

function mount(f,{commit,transport={seconds:0,ready:true}}={}){
  installDom();const root=new Node(),seeks=[],commits=[],errors=[];
  const view=mountChartPage(root,{
    onSeek:t=>{seeks.push(t);return Promise.resolve();},
    onCommit:async(candidate,label,ctx)=>{commits.push({candidate,label,ctx});return commit?commit(candidate,label,ctx):undefined;},
    onError:e=>errors.push(e),
  });
  const data={...f,documentId:'d',revision:0,songId:'s',transport};view.update(data);
  return {root,view,seeks,commits,errors,data};
}
const press=(node,key)=>node.onkeydown({key,preventDefault(){}});
const sections=(f,list)=>{f.content.sections=list;for(const c of f.content.chords)c.section_id=list.find(s=>c.start>=s.start&&c.start<s.end).id;return f;};
const repeated=()=>sections(fixture(),[{id:'a',name:'Chorus',start:0,end:20,lyrics:''},{id:'b',name:'Interlude',start:20,end:24,lyrics:''},{id:'c',name:'Chorus',start:24,end:32,lyrics:''}]);

// ===================== Navigate =====================
test('Navigate: one progression is one row, and a chord click seeks to it', () => {
  const {root,seeks,view}=mount(fixture());
  assert.equal(view.getMode(),'nav');assert.equal(chordButtons(root).length,4);
  chordButtons(root)[0].onclick();assert.deepEqual(seeks,[0]);
  assert.equal(byClass(root,'pass-pick').length,0);                  // pass pickers are for Edit
});

test('the repeat count sits right after the final repeated chord and never in a heading or a pass control', () => {
  const {root}=mount(repeated());
  const badges=byClass(root,'repeat');
  assert.equal(badges.length,1);assert.equal(badges[0].textContent,'(×2)');
  const chunk=badges[0].parent.parent;                               // chord-line -> chunk
  assert.equal(chunk.dataset.chunk.endsWith('slot3'),true);
  assert.equal(chunk.textContent,'C(×2)');
  assert.ok(byClass(root,'sec-head').every(n=>!n.textContent.includes('(×')));
  assert.equal(byClass(root,'lane-tag').length,0);
});

test('while a repeated part plays, its count lights up and counts down the passes left, bumping on each beat', () => {
  const m=mount(fixture()),count=()=>byClass(m.root,'repeat')[0];
  const at=(seconds,playing=true)=>m.view.update({...m.data,transport:{seconds,ready:true,playing}});
  assert.equal(count().textContent,'(×4)');assert.ok(!has(count(),'live'));
  at(1);assert.equal(count().textContent,'×4');assert.ok(has(count(),'live'));
  const beat=count().dataset.beat;at(1.6);assert.notEqual(count().dataset.beat,beat,'a new beat restarts the bump');
  at(9);assert.equal(count().textContent,'×3');
  at(25);assert.equal(count().textContent,'×1!!');assert.ok(has(count(),'last'));
  at(25,false);assert.equal(count().textContent,'(×4)','paused, it is the plain count again');assert.ok(!has(count(),'live')&&!has(count(),'last'));
});

test('a recording that fades out says so after the last bar, and a click plays from where the fade begins', () => {
  const f=fixture(),d=f.content.duration,n=1024;              // the music eases down over the last 10 s while the beat goes on
  const level=t=>t>=10?0:t>=3.6?-12*(10-t)/6.4:-12-58*(3.6-t)/3.6;
  const peaks=Array.from({length:n},(_,i)=>.5*10**((level(d-(i+.5)*d/n)+(i%3?-2:0))/20));
  const plain=mount(fixture());assert.equal(byClass(plain.root,'fade-note').length,0,'no waveform, no note');
  const m=mount(f,{transport:{seconds:0,ready:true}});m.view.update({...m.data,waveform:{run:'a',peaks,duration:d}});
  const note=byClass(m.root,'fade-note');assert.equal(note.length,1);assert.match(note[0].textContent,/Fade out.*from bar \d+/);
  note[0].onclick({});assert.ok(m.seeks.length===1&&m.seeks[0]>d-10&&m.seeks[0]<d-6);
  m.view.update({...m.data,waveform:{run:'b',peaks:peaks.map(()=>.5),duration:d}});assert.equal(byClass(m.root,'fade-note').length,0,'loud to the end');
});

test('canonical section blocks do not multiply phrase groups or invent numbered Chorus sections', () => {
  const f=repeated(),view=buildCompactChart(f.content,f.music),markers=buildPracticeMarkers(view);
  assert.equal(view.sections[0].groups[0].passes.length,2);          // unequal 8 s and 12 s performances still repeat
  assert.deepEqual(markers.map(m=>[m.sectionName,m.seconds,m.end]),[['Chorus',0,20],['Interlude',20,24],['Chorus',24,32]]);
  assert.ok(markers.every(m=>!('passCount' in m)&&!('passNumber' in m)));
  const {root}=mount(f);assert.deepEqual(byClass(root,'sec-name').map(n=>n.textContent),['Chorus','Interlude','Chorus']);
});

test('the playing chord is highlighted through every pass, and clicking it seeks its actual occurrence', () => {
  const f=fixture(),copy=JSON.stringify(f),{root,view,seeks}=mount(f);
  for(const c of f.content.chords){
    view.updatePlayback({seconds:(c.start+c.end)/2,ready:true,playing:true});
    const now=byClass(root,'chunk').filter(n=>has(n,'now'));
    assert.equal(now.length,1,'highlight '+c.id);
    const expected=playbackTarget(view.getModel(),(c.start+c.end)/2).chunkKey;assert.equal(now[0].dataset.chunk,expected);
    chordButtons(root).find(b=>b.dataset.chunk===expected).onclick();assert.equal(seeks.at(-1),c.start);
  }
  assert.equal(JSON.stringify(f),copy);                                // drawing never rewrites the chart
});

test('every chord in a changed ending is reachable, and the alternative ending is shown once', () => {
  const f=fixture();f.content.chords.at(-1).label='C/E';
  const {root,view,seeks}=mount(f);
  const alts=byClass(root,'alt-ending');assert.equal(alts.length,1);assert.equal(byClass(root,'ending-label')[0].textContent,'Ending 4');
  byClass(root,'ending-chord')[0].onclick();assert.deepEqual(seeks,[30]);
  // while the shared progression plays, the main row is lit; while the changed ending plays, the alternative is lit instead
  view.updatePlayback({seconds:25,ready:true,playing:true});
  assert.equal(byClass(root,'chunk').filter(n=>has(n,'now')).length,1);assert.equal(byClass(root,'ending-chord').filter(n=>has(n,'now')).length,0);
  view.updatePlayback({seconds:31,ready:true,playing:true});
  assert.equal(byClass(root,'chunk').filter(n=>has(n,'now')).length,0);assert.equal(byClass(root,'ending-chord').filter(n=>has(n,'now')).length,1);
  view.updatePlayback({seconds:7,ready:true,playing:true});                                       // pass 1 plays its own (unchanged) ending
  assert.equal(byClass(root,'chunk').filter(n=>has(n,'now')).length,1);assert.equal(byClass(root,'ending-chord').filter(n=>has(n,'now')).length,0);
});

test('edge N placeholders disappear in Navigate and Edit while pickups, interior N and explicit rests survive', () => {
  const f=fixture();for(const c of f.content.chords){c.start+=2;c.end+=2;}for(const m of f.music.measures){m.start+=2;m.end+=2;m.beats=m.beats.map(t=>t+2);}
  f.content.duration=36;f.content.sections[0].end=36;f.content.sections[0].lyrics='';f.content.chords[2].label='N';f.content.chords[7].label='N.C.';
  f.content.chords.unshift({id:'lead',label:'N',start:0,end:.5,section_id:'s',line:null,offset:null},{id:'pickup',label:'Am',start:.5,end:2,section_id:'s',line:null,offset:null});
  f.content.chords.push({id:'tail',label:'N',start:34,end:36,section_id:'s',line:null,offset:null});
  const before=JSON.stringify(f),{view}=mount(f);
  for(const mode of ['nav','edit']){
    view.setMode(mode);
    const ids=view.getModel().sections.flatMap(s=>s.groups).flatMap(g=>g.bars).flatMap(b=>b.chunks).map(c=>c.chordId);
    assert.ok(!ids.includes('lead')&&!ids.includes('tail'));assert.ok(ids.includes('pickup')&&ids.includes('c2')&&ids.includes('c7'));
  }
  assert.equal(JSON.stringify(f),before);
});

test('a partial-bar section only draws and seeks its own fragment of the bar', () => {
  const f=fixture();f.content.sections=[{...f.content.sections[0],end:1},{id:'b',name:'Later',start:1,end:32,lyrics:''}];for(const c of f.content.chords)if(c.start>=1)c.section_id='b';
  const {root,view}=mount(f);
  const bars=byClass(root,'bar').filter(n=>n.dataset.bar==='m0');assert.equal(bars.length,2);
  const model=view.getModel();assert.deepEqual([model.sections[0].groups[0].bars[0].start,model.sections[0].groups[0].bars[0].end],[0,1]);
  assert.equal(model.sections[1].groups[0].bars[0].start,1);
});

test('words are seek targets with their own actual time, and the current word lights up', () => {
  const f=fixture();f.content.sections[0].lyrics='First words\nDifferent words';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m2',beat:2}]},
    {section_id:'s',line:1,start_measure:'m4',end_measure:'m7',words:[{offset:0,measure_id:'m4',beat:0},{offset:10,measure_id:'m6',beat:0}]}]};
  const {root,view,seeks}=mount(f);
  const words=byClass(root,'w');assert.deepEqual(words.map(w=>w.textContent.trim()),['First','Different','words','words']);
  words.find(w=>w.textContent.trim()==='Different').onclick();assert.deepEqual(seeks,[8]);        // pass 2's own time, drawn on pass 1's bars
  view.updatePlayback({seconds:9,ready:true,playing:true});
  assert.deepEqual(byClass(root,'wnow').map(n=>n.textContent.trim()),['Different']);
  view.updatePlayback({seconds:5.5,ready:true,playing:true});
  assert.deepEqual(byClass(root,'wnow').map(n=>n.textContent.trim()),['words']);                  // pass 1 is playing: its second word began at 5 s
  view.updatePlayback({seconds:20,ready:true,playing:false});
  assert.deepEqual(byClass(root,'wnow').map(n=>n.textContent.trim()),[]);                         // after both lines have ended, nothing is lit
});

test('the playing pass dims the lyric lines of the other passes', () => {
  const f=fixture();f.content.sections[0].lyrics='First words\nDifferent words';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[]},{section_id:'s',line:1,start_measure:'m4',end_measure:'m7',words:[]}]};
  const {root,view}=mount(f);view.updatePlayback({seconds:9,ready:true,playing:true});
  const tags=byClass(root,'lane-tag');assert.equal(tags.length,2);
  assert.deepEqual(tags.map(t=>has(t,'cur')),[false,true]);
});

test('clicking a section name or bar number seeks there', () => {
  const {root,seeks}=mount(repeated());
  byClass(root,'sec-head')[1].onclick();assert.deepEqual(seeks,[20]);
  byClass(root,'bar-no')[0].onclick();assert.equal(seeks.at(-1),0);
});

// ===================== Ctrl: what is written =====================
const ctrl={ctrlKey:true,stopPropagation(){},preventDefault(){}},shift={shiftKey:true,stopPropagation(){},preventDefault(){}};
const chordLine=root=>byClass(root,'chord-type')[0];
const openChords=(m,index=0)=>{chordButtons(m.root)[index].onclick(ctrl);return chordLine(m.root);};
const typeLine=(node,text)=>{node.textContent=text;node.oninput?.();};

test('Ctrl+click on a chord opens the row’s chords as one line to type; Enter saves it as one edit', async () => {
  const m=mount(fixture());const line=openChords(m);
  assert.ok(line);assert.equal(line.textContent,'G C D C');assert.ok(has(byClass(m.root,'row')[0],'editing'));
  typeLine(line,'Gsus4 C D C');assert.equal(m.view.hasDraft(),true);
  press(line,'Enter');await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Edit chords');
  assert.equal(m.commits[0].candidate.chords.find(c=>c.id==='c0').label,'Gsus4');
  assert.deepEqual(m.commits[0].ctx,{documentId:'d',revision:0});
  assert.equal(chordLine(m.root),undefined,'the row is back to normal');
});

test('a plain click on a chord plays from there and opens nothing', () => {
  const m=mount(fixture());chordButtons(m.root)[1].onclick({});
  assert.deepEqual(m.seeks,[2]);assert.equal(chordLine(m.root),undefined);
});

test('the chord line: by default a change touches only the selected pass, "All matching" every pass', async () => {
  const one=mount(fixture());typeLine(openChords(one),'G Cmaj7 D C');press(chordLine(one.root),'Enter');await tick();
  assert.deepEqual(one.commits[0].candidate.chords.filter(c=>c.label==='Cmaj7').map(c=>c.id),['c1']);
  const every=mount(fixture());every.view.setScope('all-matching');typeLine(openChords(every),'G Cmaj7 D C');press(chordLine(every.root),'Enter');await tick();
  assert.deepEqual(every.commits[0].candidate.chords.filter(c=>c.label==='Cmaj7').map(c=>c.id),['c1','c5','c9','c13']);
});

test('the chord line: Esc, or leaving it unchanged, writes nothing', async () => {
  const m=mount(fixture());typeLine(openChords(m),'D D D D');press(chordLine(m.root),'Escape');await tick();
  assert.equal(m.commits.length,0);assert.equal(m.view.hasDraft(),false);assert.equal(chordLine(m.root),undefined);
  openChords(m).onblur();await tick();assert.equal(m.commits.length,0);
});

test('the chord line: a removed chord hands its time to its neighbour; an added one splits the chord before it on a beat', async () => {
  const gone=mount(fixture());typeLine(openChords(gone),'G D C');press(chordLine(gone.root),'Enter');await tick();
  const fewer=gone.commits[0].candidate.chords;assert.equal(fewer.length,15);
  assert.equal(fewer.find(c=>c.id==='c0').end,4,'G holds on through the bar the C had');
  const more=mount(fixture());typeLine(openChords(more),'G C D C Em');press(chordLine(more.root),'Enter');await tick();
  const added=more.commits[0].candidate.chords.find(c=>c.label==='Em'),last=more.commits[0].candidate.chords.find(c=>c.id==='c3');
  assert.ok(added);assert.equal(last.end,added.start);assert.ok(added.start>6&&added.start<8);
  assert.ok(fixture().music.measures.some(b=>b.beats.includes(added.start)),'on a beat');
});

test('the chord line: a chord typed before the first one splits it, and the first half takes the new chord', async () => {
  const m=mount(fixture());typeLine(openChords(m),'Em G C D C');press(chordLine(m.root),'Enter');await tick();
  const c=m.commits[0].candidate.chords,first=c.find(x=>x.id==='c0'),second=c.find(x=>x.start===first.end);
  assert.equal(first.label,'Em');assert.equal(first.start,0);assert.equal(second.label,'G');assert.equal(second.end,2);
});

test('the chord line only takes chords: a letter A to G, with # or b after it', async () => {
  assert.deepEqual(chordTokens(' F#m7  Bb/D C♯ '),['F#m7','Bb/D','C#']);
  assert.throws(()=>chordTokens('G H7'),/H7.*not a chord/);
  const m=mount(fixture());typeLine(openChords(m),'G C hello C');press(chordLine(m.root),'Enter');await tick();
  assert.equal(m.commits.length,0);assert.match(m.root.textContent,/hello/);
});

test('alignChords keeps what is unchanged and retypes, removes or adds the rest', () => {
  const kinds=(a,b)=>alignChords(a,b).map(o=>o.type).join(' ');
  assert.equal(kinds(['G','C','D'],['G','C','D']),'keep keep keep');
  assert.equal(kinds(['G','C','D'],['G','Am','D']),'keep replace keep');
  assert.equal(kinds(['G','C','D'],['G','D']),'keep delete keep');
  assert.equal(kinds(['G','C','D'],['G','C','D','E']),'keep keep keep insert');
  assert.equal(kinds(['G','C'],['E','G','C']),'insert keep keep');
});

test('an open edit is never lost to playback updates or a redraw of the same chart', () => {
  const m=mount(fixture());const line=openChords(m);typeLine(line,'Am C D C');
  m.view.updatePlayback({seconds:9,ready:true,playing:true});assert.equal(chordLine(m.root),line);
  m.view.update({...m.data});assert.equal(chordLine(m.root),line);assert.equal(line.textContent,'Am C D C');
});

test('with a change typed, it must be finished before the view changes or another row opens', () => {
  const m=mount(repeated());const line=openChords(m);typeLine(line,'Am C D C');
  assert.equal(m.view.canNavigate(),false);assert.equal(m.view.setMode('timing'),'nav');
  chordButtons(m.root).at(-1).onclick(ctrl);assert.equal(byClass(m.root,'chord-type').length,1);
  press(line,'Escape');assert.equal(m.view.canNavigate(),true);assert.equal(m.view.setMode('timing'),'timing');
});

test('a second save while one is in flight is ignored, and a failed save can be retried', async () => {
  let release,calls=0;const m=mount(fixture(),{commit:()=>{calls++;return new Promise(r=>release=r);}});
  typeLine(openChords(m),'D C D C');press(chordLine(m.root),'Enter');await tick();
  assert.equal(m.view.hasPendingSave(),true);
  chordButtons(m.root)[1].onclick(ctrl);assert.equal(chordLine(m.root),undefined,'nothing opens while saving');assert.equal(calls,1);
  release();await tick();await tick();assert.equal(m.view.hasPendingSave(),false);
  const failing=mount(fixture(),{commit:async()=>{throw Error('Revision changed');}});
  typeLine(openChords(failing),'D C D C');press(chordLine(failing.root),'Enter');await tick();await tick();
  assert.match(failing.root.textContent,/Revision changed/);assert.equal(failing.errors.length,1);assert.equal(failing.view.hasPendingSave(),false);
  assert.ok(openChords(failing),'free to try again');
});

test('the pass pickers of an open row choose which pass a chord change applies to', async () => {
  const m=mount(fixture());openChords(m);const pick=byClass(m.root,'pass-pick')[0];assert.equal(pick.children.length,4);
  pick.children[2].onclick();const line=chordLine(m.root);typeLine(line,'G Fm D C');press(line,'Enter');await tick();
  assert.deepEqual(m.commits[0].candidate.chords.filter(c=>c.label==='Fm').map(c=>c.id),['c9']);   // pass 3's chord
});

test('a break in the music (an N chord) is drawn as a rest for its length, not the letter N, and is typed as N',()=>{
  const f=fixture();
  const inner=f.content.chords.filter(c=>c.start>2).sort((a,b)=>a.start-b.start)[0];inner.label='N';  // an interior break: leading and trailing ones are hidden anyway
  const {root,view}=mount(f);
  const rests=byClass(root,'rest').filter(n=>n.tagName==='button');
  assert.ok(rests.length>=1,'the break keeps its place on the chart');
  assert.ok(rests.every(b=>/^[\u{1D13B}-\u{1D13F}]+$/u.test(b.textContent)&&/^Rest/.test(b.title)),'and shows rest symbols, named for screen readers');
  assert.ok(!chordButtons(root).some(b=>/^\(?N\)?$/.test(b.textContent.trim())),'no N anywhere');
  rests[0].onclick(ctrl);assert.match(chordLine(root).textContent,/(^| )N( |$)/,'typed as N');
});

// ---- the words ----
const wordLines=root=>byClass(root,'lyr').filter(n=>n.contentEditable==='plaintext-only');
test('Ctrl+click under a row with no words opens one line per pass; a new line starts at the chord you clicked', async () => {
  const blank=fixture();blank.content.sections[0].lyrics='';
  const m=mount(blank);
  const add=byClass(m.root,'lane-add')[0];assert.ok(add,'a row with no words offers a line (shown while Ctrl is held)');
  add.onclick(ctrl);
  assert.equal(wordLines(m.root).length,4);                                           // one line per pass of the row, not one box per chord
  const line=wordLines(m.root)[0];assert.equal(line.dataset.placeholder.startsWith('Click and type'),true);
  line._lane.anchorKey=byClass(m.root,'chord')[2].dataset.chunk;                       // clicked under the third chord
  line.textContent='hello world';line.oninput();await leave(line);
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Add lyrics');
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'hello world');
  const pin=c.layout.lines[0].words.find(w=>w.offset===0);assert.deepEqual([pin.measure_id,pin.beat],['m2',0]);   // the D chord at bar 3
});

const withWords=(words='hello wrold',pins=[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m2',beat:2}])=>{
  const f=fixture();f.content.sections[0].lyrics=words;
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:pins}]};return f;
};
const openWords=m=>{byClass(m.root,'lyr')[0].onclick(ctrl);return wordLines(m.root);};
const leave=async line=>{line.onblur();await new Promise(r=>setTimeout(r,1));await tick();};      // a click outside the row saves it
test('Ctrl+click on the words: a line can be retyped; a typo fix keeps the pin and Esc drops the change', async () => {
  const m=mount(withWords());const lines=openWords(m);
  assert.equal(lines.length,4);assert.equal(lines[0].textContent,'hello wrold');
  lines[0].textContent='hello world';lines[0].oninput();await leave(lines[0]);
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'hello world');
  assert.deepEqual(c.layout.lines[0].words.map(w=>[w.offset,w.measure_id,w.beat]),[[0,'m0',0],[6,'m2',2]]);
  const again=mount(withWords());const l2=openWords(again);
  l2[0].textContent='goodbye';l2[0].oninput();press(l2[0],'Escape');await tick();assert.equal(again.commits.length,0);
  assert.equal(wordLines(again.root).length,0,'Esc closes the row');
});

test('a plain click on a word plays from it; only Ctrl opens the words', () => {
  const m=mount(withWords());const word=byClass(m.root,'w')[0];
  word.onclick({});assert.equal(m.seeks.length,1);
  byClass(m.root,'lyr')[0].onclick({});assert.equal(wordLines(m.root).length,0);
});

test('a repeated row has one line for every pass, and a new line belongs to its pass', async () => {
  const m=mount(withWords('first pass words',[{offset:0,measure_id:'m0',beat:0}]));
  const lines=openWords(m);assert.equal(lines.length,4);
  assert.deepEqual(byClass(m.root,'lane-tag').filter(t=>t.parent&&has(t.parent,'lane-edit')).map(t=>t.textContent),['1','2','3','4']);
  assert.deepEqual(lines.map(l=>l.textContent),['first pass words','','','']);
  lines[1].textContent='second pass words';lines[1].oninput();await leave(lines[1]);
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'first pass words\nsecond pass words');
  const pin=c.layout.lines.find(p=>p.line===1).words[0];assert.equal(pin.measure_id,'m4');          // pass 2 starts on bar 5
  assert.equal(c.layout.lines.find(p=>p.line===1).start_measure,'m4');
});

test('several pasted lines flow into the following lines, one per pass', async () => {
  const f=withWords('first pass words',[{offset:0,measure_id:'m0',beat:0}]);
  const m=mount(f);const lines=openWords(m);
  lines[1].textContent='second pass\nthird pass\n\nfourth pass';lines[1].oninput();await leave(lines[1]);
  assert.equal(m.commits.length,1);
  assert.equal(m.commits[0].candidate.sections[0].lyrics,'first pass words\nsecond pass\nthird pass\nfourth pass');
  const toomany=mount(f);const l2=openWords(toomany);
  l2[2].textContent='a\nb\nc';l2[2].oninput();await leave(l2[2]);
  assert.equal(toomany.commits.length,0);assert.match(toomany.root.textContent,/only 2 lines/);
});

test('Enter on a line moves to the next line of the row', async () => {
  const m=mount(withWords('first pass words',[{offset:0,measure_id:'m0',beat:0}]));let focused=null;
  const lines=openWords(m);lines[1].focus=()=>{focused=1;};
  press(lines[0],'Enter');await tick();
  assert.equal(focused,1);assert.equal(m.commits.length,0);                                // nothing changed, nothing saved
});

test('Tab and Enter move between the passes without saving; leaving the row saves every changed line as one edit', async () => {
  // like a browser: one element has the focus, and removing it from the page reports it as left (blur)
  let focused=null;const inside=(n,t)=>n===t||n.children.some(c=>inside(c,t));
  const replace=Node.prototype.replaceChildren,focus=Node.prototype.focus;
  Node.prototype.focus=function(){if(focused===this)return;const was=focused;focused=this;was?.onblur?.();this.onfocus?.();};
  Node.prototype.replaceChildren=function(...nodes){const was=focused;if(was&&inside(this,was)){focused=null;was.onblur?.();}return replace.apply(this,nodes);};
  try{
    installDom();const root=new Node();let data,view,revision=0;const labels=[];
    view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onError:()=>{},
      onCommit:async(candidate,label)=>{labels.push(label);data={...data,content:candidate,revision:++revision};view.update(data);},
      onDraftChange:()=>view.update(data)});      // like the app: every change of the editing state redraws from the latest chart
    data={...withWords('first pass words',[{offset:0,measure_id:'m0',beat:0}]),documentId:'d',revision,songId:'s',transport:{seconds:0,ready:true}};view.update(data);
    openWords({root});const lines=wordLines(root);assert.equal(lines.indexOf(focused),0);
    lines[0].textContent='first pass changed';lines[0].oninput();
    lines[0].onkeydown({key:'Tab',preventDefault(){}});await new Promise(r=>setTimeout(r,1));
    assert.equal(lines.indexOf(focused),1,'Tab: the cursor is on pass 2');assert.equal(revision,0,'nothing saved yet');
    assert.equal(wordLines(root).length,4,'the row stays open');
    lines[1].textContent='second pass';lines[1].oninput();
    lines[1].onkeydown({key:'Tab',shiftKey:true,preventDefault(){}});await new Promise(r=>setTimeout(r,1));
    assert.equal(lines.indexOf(focused),0,'Shift+Tab goes back');
    lines[0].onkeydown({key:'Enter',preventDefault(){}});await new Promise(r=>setTimeout(r,1));
    assert.equal(lines.indexOf(focused),1,'Enter goes on too');assert.equal(revision,0);
    focused=null;lines[1].onblur();await new Promise(r=>setTimeout(r,1));await tick();     // a click outside the row
    assert.equal(revision,1,'one edit');assert.deepEqual(labels,['Edit lyrics']);
    assert.match(data.content.sections[0].lyrics,/first pass changed\nsecond pass/);
    assert.equal(wordLines(root).length,0,'and the row closes');
  }finally{Node.prototype.replaceChildren=replace;if(focus)Node.prototype.focus=focus;else delete Node.prototype.focus;}
});

test('a row can empty several lines and start a new one in one go: the lines are not mixed up by the ones removed', async () => {
  const f=fixture();f.content.sections[0].lyrics='one two\nthree four\nfive six';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:['m0','m4','m8'].map((m,line)=>({section_id:'s',line,start_measure:m,end_measure:'m'+(Number(m.slice(1))+3),words:[{offset:0,measure_id:m,beat:0}]}))};
  const m=mount(f);const lines=openWords(m);
  assert.deepEqual(lines.map(l=>l.textContent),['one two','three four','five six','']);
  lines[0].textContent='';lines[0].oninput();lines[2].textContent='';lines[2].oninput();
  lines[3].textContent='seven eight';lines[3].oninput();
  await leave(lines[3]);
  assert.deepEqual(m.errors,[]);assert.equal(m.commits.length,1,'one edit');
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'three four\nseven eight');
  const placed=line=>c.layout.lines.find(p=>p.line===line)?.start_measure;
  assert.deepEqual([placed(0),placed(1)],['m4','m12'],'"three four" stays on pass 2, the new line goes on pass 4');
});

test('Esc leaves the row and drops what was typed; a line no longer on the page never holds up a redraw', async () => {
  const m=mount(withWords('first pass words',[{offset:0,measure_id:'m0',beat:0}]));const lines=openWords(m);
  lines[0].onfocus();lines[0].textContent='changed';lines[0].oninput();
  lines[1].onfocus();lines[1].textContent='also changed';lines[1].oninput();
  press(lines[1],'Escape');await tick();assert.equal(m.commits.length,0);assert.equal(wordLines(m.root).length,0);
  const n=mount(withWords());const open=openWords(n)[0];open.onfocus();open.isConnected=false;   // focused, then dropped from the page
  const moved=structuredClone(n.data.content);moved.sections[0].name='Renamed';n.view.update({...n.data,content:moved,revision:1});
  assert.ok(byClass(n.root,'sec-name').some(x=>x.textContent==='Renamed'),'redrawn');
});

// ---- sections ----
test('Ctrl+click on a section name renames it in place', async () => {
  const m=mount(fixture());const name=byClass(m.root,'sec-name')[0];
  name.onclick(ctrl);assert.equal(name.contentEditable,'plaintext-only');
  name.textContent='Verse';name.oninput();press(name,'Enter');await tick();
  assert.equal(m.commits[0].candidate.sections[0].name,'Verse');assert.equal(m.commits[0].label,'Edit section');
  const same=mount(fixture());const n2=byClass(same.root,'sec-name')[0];n2.onclick(ctrl);n2.textContent='Chorus';press(n2,'Enter');await tick();assert.equal(same.commits.length,0);
  const plain=mount(fixture());byClass(plain.root,'sec-name')[0].onclick({});assert.notEqual(byClass(plain.root,'sec-name')[0].contentEditable,'plaintext-only');
});

test('Ctrl: the strip above a section joins it with the one before, and the first section has none', async () => {
  const m=mount(repeated());
  const joins=byClass(m.root,'zone-join');assert.equal(joins.length,2);
  joins[0].onclick(ctrl);await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Join sections');
  assert.equal(m.commits[0].candidate.sections.length,2);
  assert.equal(byClass(mount(fixture()).root,'zone-join').length,0);
});

test('Ctrl: the strip above a bar starts a new section there, and the new name is ready to type', async () => {
  const f=fixture();f.content.chords.forEach((c,i)=>{if(c.start>=16)c.label=['Am','F','C','E'][i%4];});
  const m=mount(f);
  const strips=byClass(m.root,'zone-split');assert.ok(strips.length>0,'split strips sit on the bars a section can start at');
  strips[0].onclick(ctrl);await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Split section');
  const next=m.commits[0].candidate.sections;assert.equal(next.length,2);assert.equal(next[1].name,'New section');
  assert.equal(next[0].end,next[1].start);assert.ok(next[0].end>next[0].start&&next[1].end>next[1].start);
});

test('Ctrl: a barline joins two bars and a beat splits a bar (the first barline of the song has none)', () => {
  const f=fixture();installDom();const root=new Node(),edits=[];
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{},onBarEdit:c=>{edits.push(c);}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});
  const bars=byClass(root,'bar');
  assert.equal(byClass(bars[0],'zone-barline').length,0);
  byClass(bars[1],'zone-barline')[0].onclick(ctrl);
  const beats=byClass(bars[1],'zone-beat');assert.equal(beats.length,3);beats[1].onclick(ctrl);
  assert.deepEqual(edits,[{removeBars:[f.music.measures[1].start]},{addBars:[f.music.measures[1].beats[2]]}]);
  assert.equal(byClass(mount(fixture()).root,'zone-beat').length,0,'without a barline handler there is nothing to click');
});

test('every place Ctrl or Shift adds has a tooltip with a picture, and none names a key', () => {
  const m=mount(repeated());
  const places=[...chordButtons(m.root),...byClass(m.root,'lyr'),...byClass(m.root,'sec-name'),...byClass(m.root,'zone-join'),...byClass(m.root,'zone-split'),...byClass(m.root,'lane-add')];
  assert.ok(places.length>5);
  for(const node of places){assert.ok(node.dataset.tipTitle&&node.dataset.tip.length>20&&node.dataset.tipArt.includes('<svg'),node.className);assert.equal(node.dataset.tipKey,undefined);}
  assert.equal(chordButtons(m.root)[0].dataset.tipKeys,'ctrl','on the chart itself, the tip waits for Ctrl');
  m.view.setMode('timing');
  for(const node of [...byClass(m.root,'wchip'),...byClass(m.root,'tno')])assert.equal(node.dataset.tipKeys,'shift');
});

// ===================== the keys you hold =====================
function withKeys(f=fixture(),extra={}){
  installDom();const root=new Node(),listeners={};
  root.ownerDocument={addEventListener:(type,fn)=>{(listeners[type]??=[]).push(fn);},removeEventListener(){}};
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{},...extra});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});
  const fire=(type,key,extra={})=>{for(const fn of listeners[type]||[])fn({key,target:null,repeat:false,...extra});};
  return {root,view,fire};
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('the note on the keys lights up "editing" while Ctrl is held and "timing" while the chart is in time', () => {
  const legend=new Node(),k=withKeys(fixture(),{legend}),lit=()=>legend.className.split(' ').filter(Boolean).sort().join(' ');
  assert.equal(lit(),'');
  k.fire('keydown','Control');assert.equal(lit(),'editing');
  k.fire('keyup','Control');assert.equal(lit(),'');
  k.view.setMode('timing');assert.equal(lit(),'timing');
  k.view.setMode('nav');assert.equal(lit(),'');
});
test('holding Ctrl marks the chart so its places show; letting go hides them', () => {
  const k=withKeys();assert.equal(k.root.dataset.keys,'');
  k.fire('keydown','Control');assert.equal(k.root.dataset.keys,'ctrl');
  k.fire('keyup','Control');assert.equal(k.root.dataset.keys,'');
});

test('holding Shift draws the chart in time until it is let go; a quick tap keeps it there, Esc or another tap puts it back', async () => {
  const k=withKeys();
  k.fire('keydown','Shift');await wait(200);assert.equal(k.view.getMode(),'timing');assert.equal(k.root.dataset.keys,'shift');
  await wait(150);k.fire('keyup','Shift');assert.equal(k.view.getMode(),'nav');
  k.fire('keydown','Shift');await wait(40);k.fire('keyup','Shift');await wait(200);assert.equal(k.view.getMode(),'timing','a tap keeps it');
  assert.equal(k.view.handleKey({key:'Escape'}),true);assert.equal(k.view.getMode(),'nav');assert.equal(k.view.handleKey({key:'Escape'}),false);
  k.fire('keydown','Shift');await wait(40);k.fire('keyup','Shift');assert.equal(k.view.getMode(),'timing');
  k.fire('keydown','Shift');await wait(40);k.fire('keyup','Shift');assert.equal(k.view.getMode(),'nav','another tap puts it back');
});

test('Shift as part of a shortcut (Ctrl+Shift+Z) or while typing never switches the view', async () => {
  const k=withKeys();
  k.fire('keydown','Control');k.fire('keydown','Shift',{ctrlKey:true});k.fire('keydown','Z',{ctrlKey:true,shiftKey:true});await wait(200);
  k.fire('keyup','Shift');k.fire('keyup','Control');assert.equal(k.view.getMode(),'nav');
  k.fire('keydown','Shift',{target:{isContentEditable:true}});await wait(200);k.fire('keyup','Shift',{target:{isContentEditable:true}});assert.equal(k.view.getMode(),'nav');
});

// ===================== the views =====================
test('setMode switches between the chart as written and in time, and keeps the chart', () => {
  const m=mount(fixture());
  assert.equal(m.root.dataset.mode,'nav');
  m.view.setMode('timing');assert.equal(m.root.dataset.mode,'timing');assert.equal(byClass(m.root,'tbar').length,4);
  m.view.setMode('nav');assert.equal(chordButtons(m.root).length,4);
  assert.equal(m.view.setMode('bogus'),'nav');assert.equal(m.view.setMode('edit'),'nav');
});

test('view and zoom changes are reported so the toolbar can follow', () => {
  installDom();const root=new Node(),events=[];
  const view=mountChartPage(root,{onModeChange:m=>events.push(['mode',m]),onTimingChange:s=>events.push(['timing',s.zoom,s.snap])});
  view.update({...fixture(),documentId:'d',revision:0,songId:'s',transport:{seconds:0}});
  view.setMode('timing');view.zoomBy(1);view.setSnapping(false);view.zoomBy(-1);view.setSnapping(true);view.zoomBy(-1);view.zoomBy(-1);
  // the grid follows the zoom; with the magnet off, words go exactly where they are dropped
  assert.deepEqual(events,[['mode','timing'],['timing',3,'sixteenth'],['timing',3,'free'],['timing',2,'free'],['timing',2,'eighth'],['timing',1.5,'eighth'],['timing',1,'quarter']]);
  assert.equal(view.getZoom(),1);
});

test('the chart has no tools: the rail is left empty and the line under the page is quiet until there is something to say', () => {
  const f=fixture();installDom();const root=new Node(),dock=new Node(),note=new Node(),status=new Node();
  dock.append(new Node());                                            // whatever the lead sheet left there
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{},dock,note,status});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});
  assert.equal(dock.children.length,0);assert.equal(byClass(root,'tool-status').length,0,'nothing of the line sits on the chart');
  assert.equal(status.textContent,'','the note on the keys sits in the toolbar now');assert.equal(byClass(status,'tool-put-down').length,0);
  view.setMode('timing');assert.equal(byClass(status,'tool-put-down').length,1,'Esc leaves the kept in-time view');
});

// ===================== Shift: fold repeats =====================
test('Shift+click two bar numbers to fold a part that repeats; Esc drops the picks', () => {
  const m=mount(fixture());m.view.setMode('timing');
  byClass(m.root,'tno')[0].onclick(shift);
  assert.match(m.root.textContent,/Bar 1 picked/);
  byClass(m.root,'tno')[1].onclick(shift);
  assert.ok(byClass(m.root,'fix-choice').length>=1);
  assert.equal(m.view.handleKey({key:'Escape'}),true);assert.equal(byClass(m.root,'fix-choice').length,0);
  byClass(m.root,'tno')[2].onclick({});assert.equal(m.seeks.at(-1),4,'a plain click plays from the bar');
});

test('Shift+click a repeat count to regroup it, and an unsupported saved grouping can be reset', async () => {
  const m=mount(fixture());m.view.setMode('timing');
  const count=byClass(m.root,'repeat')[0];assert.ok(count);
  let stopped=false;count.onpointerdown({button:0,pointerId:1,shiftKey:true,stopPropagation(){stopped=true;}});
  assert.ok(stopped,'pressing the count (it sits inside its chord) never starts a drag of the chord');
  count.onclick(shift);
  assert.match(m.root.textContent,/grouped/);
  const f=fixture();f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[],compact:{groups:[{section_id:'s',mode:'repeat',passes:[{start:0,end:99,measure_ids:['zzz'],chord_ids:[]}]}]}};
  const r=mount(f);r.view.setMode('timing');byClass(r.root,'tno')[0].onclick(shift);
  const reset=byClass(r.root,'fix-link').find(n=>n.textContent==='Reset all my repeat choices');assert.ok(reset);
  reset.onclick();await tick();assert.equal(r.commits[0].label,'Reset repeat grouping');
  assert.equal(r.commits[0].candidate.chords.length,16);assert.equal(r.commits[0].candidate.layout.compact,undefined);
});

// ---- repeat signs ----
test('a repeated progression starts and ends with repeat signs; a plain row has none', () => {
  const {root}=mount(fixture());
  const bars=byClass(root,'bar');
  assert.ok(has(bars[0],'rep-start')&&has(bars.at(-1),'rep-end'));
  assert.equal(bars.slice(1,-1).filter(b=>has(b,'rep-start')||has(b,'rep-end')).length,0);
  assert.equal(byClass(root,'repeat').length,1);                    // the (x4) count is still there
  const f=fixture();f.content.chords=f.content.chords.slice(0,4);f.content.sections[0].end=8;f.content.duration=8;
  assert.equal(byClass(mount(f).root,'rep-start').length,0);
});

test('repeat signs are plain shapes (a rule and two dots), never gradients that print as grey blocks', () => {
  const {root}=mount(fixture());
  const signs=byClass(root,'rep-sign');
  assert.equal(signs.length,2);                                      // one at the start and one at the end of the folded row
  assert.ok(signs.every(s=>byClass(s,'rep-dot').length===2));
  assert.ok(signs.some(s=>has(s,'start'))&&signs.some(s=>has(s,'end')));
});

test('a thin playhead line sits in the bar being played, in reading and in timing, and in the pass being played', () => {
  const f=fixture(),m=mount(f),mark=()=>byClass(m.root,'playmark');
  const c=f.content.chords.find(c=>c.label&&c.label!=='N'&&c.end-c.start>1);
  m.view.updatePlayback({seconds:c.start+.25,ready:true,playing:false});
  assert.equal(mark().length,1,'paused too');
  const bar=mark()[0].parent;assert.ok(bar.dataset.bar,'inside a bar');
  m.view.setMode('timing');m.view.updatePlayback({seconds:c.start+.25,ready:true,playing:true});
  assert.equal(mark().length,1);assert.ok(mark()[0].parent.dataset.bar);assert.match(mark()[0].style.left,/%$/,'timing: by the beats of the bar');
  m.view.updatePlayback({seconds:-5,ready:true,playing:true});assert.equal(mark().length,0,'before the music: no line');
});

test('passes are listed in pass order, not in the order their lines were typed', async () => {
  const f=fixture();f.content.sections[0].lyrics='three four\none two';            // pass 2's line was typed first
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[['m4',0],['m0',1]].map(([m,line])=>({section_id:'s',line,start_measure:m,end_measure:'m'+(Number(m.slice(1))+3),words:[{offset:0,measure_id:m,beat:0}]}))};
  const m=mount(f);
  assert.deepEqual(byClass(m.root,'lane-tag').map(t=>t.textContent).slice(0,2),['1','2']);
  const lines=openWords(m);
  assert.deepEqual(lines.map(l=>l.textContent).slice(0,2),['one two','three four'],'and Tab goes from pass 1 to pass 2');
});
