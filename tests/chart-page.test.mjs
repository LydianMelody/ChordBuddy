import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountChartPage} from '../chordbuddy/web/chart-page.js';
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

// ===================== Edit =====================
const editChordSetup=(f=fixture(),options)=>{const m=mount(f,options);m.view.setMode('edit');return m;};
const openChord=(m,index=0)=>{chordButtons(m.root)[index].onclick();return byClass(m.root,'chord-input')[0];};

test('Edit: clicking a chord turns it into an input; Enter saves it as one edit', async () => {
  const m=editChordSetup();const input=openChord(m);assert.ok(input);assert.equal(input.value,'G');
  input.value='Gsus4';input.oninput();assert.equal(m.view.hasDraft(),true);
  press(input,'Enter');await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Edit chord');
  assert.equal(m.commits[0].candidate.chords.find(c=>c.id==='c0').label,'Gsus4');
  assert.deepEqual(m.commits[0].ctx,{documentId:'d',revision:0});
});

test('Edit: by default a chord change touches only the selected pass', async () => {
  const m=editChordSetup();const input=openChord(m,1);input.value='Cmaj7';press(input,'Enter');await tick();
  const labels=m.commits[0].candidate.chords.filter(c=>c.label==='Cmaj7').map(c=>c.id);assert.deepEqual(labels,['c1']);
});

test('Edit: "All matching" applies the change to every pass of the progression', async () => {
  const m=editChordSetup();m.view.setScope('all-matching');const input=openChord(m,1);input.value='Cmaj7';press(input,'Enter');await tick();
  assert.deepEqual(m.commits[0].candidate.chords.filter(c=>c.label==='Cmaj7').map(c=>c.id),['c1','c5','c9','c13']);
  assert.equal(m.commits[0].label,'Edit chords in matching passes');
});

test('Edit: Esc and an unchanged chord write nothing', async () => {
  const m=editChordSetup();let input=openChord(m);input.value='D';press(input,'Escape');await tick();assert.equal(m.commits.length,0);assert.equal(m.view.hasDraft(),false);
  input=openChord(m);input.onblur();await tick();assert.equal(m.commits.length,0);               // blur without a change keeps the chord
  input=openChord(m);input.value='   ';press(input,'Enter');await tick();assert.equal(m.commits.length,0);
});

test('Edit: an open edit is never lost to playback updates or a redraw of the same chart', () => {
  const m=editChordSetup();const input=openChord(m);input.value='Am';input.oninput();
  m.view.updatePlayback({seconds:9,ready:true,playing:true});assert.equal(byClass(m.root,'chord-input')[0],input);
  m.view.update({...m.data});assert.equal(byClass(m.root,'chord-input')[0],input);assert.equal(input.value,'Am');
});

test('Edit: with a change typed, you must finish it before changing mode or opening another editor', () => {
  const m=editChordSetup();const input=openChord(m);input.value='Am';input.oninput();
  assert.equal(m.view.canNavigate(),false);assert.equal(m.view.setMode('nav'),'edit');
  chordButtons(m.root)[0].onclick();assert.equal(byClass(m.root,'chord-input').length,1);
  press(input,'Escape');assert.equal(m.view.canNavigate(),true);assert.equal(m.view.setMode('nav'),'nav');
});

test('Edit: a second save while one is in flight is ignored, and a failed save can be retried', async () => {
  let release,calls=0;const m=editChordSetup(fixture(),{commit:()=>{calls++;return new Promise(r=>release=r);}});
  const input=openChord(m);input.value='D';press(input,'Enter');await tick();
  assert.equal(m.view.hasPendingSave(),true);
  const second=openChord(m,1);second?.onblur?.();assert.equal(calls,1);
  release();await tick();await tick();assert.equal(m.view.hasPendingSave(),false);
  const failing=editChordSetup(fixture(),{commit:async()=>{throw Error('Revision changed');}});
  const field=openChord(failing);field.value='D';press(field,'Enter');await tick();await tick();
  assert.match(failing.root.textContent,/Revision changed/);assert.equal(failing.errors.length,1);assert.equal(failing.view.hasPendingSave(),false);
  const again=openChord(failing);assert.ok(again);                                                // free to try again
});

test('Edit: one line per pass; a new line starts at the chord you clicked and chords stay put', async () => {
  const blank=fixture();blank.content.sections[0].lyrics='';
  const m=editChordSetup(blank);
  assert.equal(byClass(m.root,'add-lyrics').length,0);                                   // no per-chord boxes, no "Add lyrics" buttons
  assert.equal(byClass(m.root,'lyr').length,4);                                          // one line per pass of the row, not one box per chord
  const line=byClass(m.root,'lyr')[0];assert.equal(line.dataset.placeholder.startsWith('Click and type'),true);
  line._lane.anchorKey=byClass(m.root,'chord')[2].dataset.chunk;                         // clicked under the third chord
  line.textContent='hello world';line.oninput();press(line,'Enter');await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Add lyrics');
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'hello world');
  const pin=c.layout.lines[0].words.find(w=>w.offset===0);assert.deepEqual([pin.measure_id,pin.beat],['m2',0]);   // the D chord at bar 3
});

test('Edit: a line can be retyped; a typo fix keeps the pin and Esc drops the change', async () => {
  const f=fixture();f.content.sections[0].lyrics='hello wrold';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m2',beat:2}]}]};
  const m=editChordSetup(f);const lines=byClass(m.root,'lyr').filter(n=>n.contentEditable==='plaintext-only');
  assert.equal(lines.length,4);assert.equal(lines[0].textContent,'hello wrold');
  lines[0].textContent='hello world';lines[0].oninput();press(lines[0],'Enter');await tick();
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'hello world');
  assert.deepEqual(c.layout.lines[0].words.map(w=>[w.offset,w.measure_id,w.beat]),[[0,'m0',0],[6,'m2',2]]);
  const again=byClass(m.root,'lyr').filter(n=>n.contentEditable==='plaintext-only')[0];
  again.textContent='goodbye';again.oninput();press(again,'Escape');await tick();assert.equal(m.commits.length,1);
});

test('Edit: a section can be renamed in place', async () => {
  const m=editChordSetup();const name=byClass(m.root,'sec-name')[0];assert.equal(name.contentEditable,'plaintext-only');
  name.textContent='Verse';name.oninput();press(name,'Enter');await tick();
  assert.equal(m.commits[0].candidate.sections[0].name,'Verse');assert.equal(m.commits[0].label,'Edit section');
  const same=editChordSetup();const n2=byClass(same.root,'sec-name')[0];n2.textContent='Chorus';press(n2,'Enter');await tick();assert.equal(same.commits.length,0);
});

test('Edit: "+" adds a chord in the middle of the chord it follows', async () => {
  const m=editChordSetup();const add=byClass(m.root,'add-chord');assert.equal(add.length,4);
  add[0].onclick();await tick();
  const c=m.commits[0].candidate;assert.equal(m.commits[0].label,'Add chord');assert.equal(c.chords.length,17);
  const first=c.chords.find(x=>x.id==='c0'),added=c.chords.find(x=>!['c0','c1'].includes(x.id)&&x.start>=first.end-1e-9&&x.start<2);
  assert.ok(added);assert.equal(first.end,added.start);assert.ok(added.start>0&&added.start<2);
});

test('Edit: the pass pickers choose which pass a chord change applies to', async () => {
  const m=editChordSetup();const pick=byClass(m.root,'pass-pick')[0];assert.equal(pick.children.length,4);
  pick.children[2].onclick();const input=openChord(m,1);input.value='Fm';press(input,'Enter');await tick();
  assert.deepEqual(m.commits[0].candidate.chords.filter(c=>c.label==='Fm').map(c=>c.id),['c9']);   // pass 3's chord
});

test('Edit: an unsupported saved grouping can be reset without losing lyrics or chords', async () => {
  const f=fixture();f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[],compact:{groups:[{section_id:'s',mode:'repeat',passes:[{start:0,end:99,measure_ids:['zzz'],chord_ids:[]}]}]}};
  const m=editChordSetup(f);const reset=byClass(m.root,'secondary').find(n=>n.textContent==='Reset repeat grouping');assert.ok(reset);
  reset.onclick();await tick();assert.equal(m.commits[0].label,'Reset repeat grouping');
  assert.equal(m.commits[0].candidate.chords.length,16);assert.equal(m.commits[0].candidate.layout.compact,undefined);
});

// ===================== modes =====================
test('switching mode keeps the chart and shows what each mode is for', () => {
  const m=mount(fixture());
  assert.equal(m.root.dataset.mode,'nav');assert.equal(byClass(m.root,'add-chord').length,0);
  m.view.setMode('edit');assert.equal(m.root.dataset.mode,'edit');assert.equal(byClass(m.root,'add-chord').length,4);
  m.view.setMode('timing');assert.equal(m.root.dataset.mode,'timing');assert.equal(byClass(m.root,'tbar').length,4);
  m.view.setMode('nav');assert.equal(chordButtons(m.root).length,4);
  assert.equal(m.view.setMode('bogus'),'nav');
});

test('mode and zoom changes are reported so the toolbar can follow', () => {
  installDom();const root=new Node(),events=[];
  const view=mountChartPage(root,{onModeChange:m=>events.push(['mode',m]),onTimingChange:s=>events.push(['timing',s.zoom,s.snap])});
  view.update({...fixture(),documentId:'d',revision:0,songId:'s',transport:{seconds:0}});
  view.setMode('timing');view.zoomBy(1);view.setSnap('quarter');view.zoomBy(-1);view.zoomBy(-1);
  assert.deepEqual(events,[['mode','timing'],['timing',3,'eighth'],['timing',3,'quarter'],['timing',2,'quarter'],['timing',1.5,'quarter']]);
  assert.equal(view.getZoom(),1.5);
});

test('Edit: a repeated row has one line for every pass, and a new line belongs to its pass', async () => {
  const f=fixture();f.content.sections[0].lyrics='first pass words';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0}]}]};
  const m=editChordSetup(f);
  const lines=byClass(m.root,'lyr');assert.equal(lines.length,4);
  assert.deepEqual(byClass(m.root,'lane-tag').map(t=>t.textContent),['1','2','3','4']);
  assert.deepEqual(lines.map(l=>l.textContent),['first pass words','','','']);
  lines[1].textContent='second pass words';lines[1].oninput();press(lines[1],'Enter');await tick();
  const c=m.commits[0].candidate;assert.equal(c.sections[0].lyrics,'first pass words\nsecond pass words');
  const pin=c.layout.lines.find(p=>p.line===1).words[0];assert.equal(pin.measure_id,'m4');          // pass 2 starts on bar 5
  assert.equal(c.layout.lines.find(p=>p.line===1).start_measure,'m4');
});

test('Edit: several pasted lines flow into the following lines, one per pass', async () => {
  const f=fixture();f.content.sections[0].lyrics='first pass words';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0}]}]};
  const m=editChordSetup(f);
  const lines=byClass(m.root,'lyr');
  lines[1].textContent='second pass\nthird pass\n\nfourth pass';lines[1].oninput();press(lines[1],'Enter');await tick();
  assert.equal(m.commits.length,1);
  assert.equal(m.commits[0].candidate.sections[0].lyrics,'first pass words\nsecond pass\nthird pass\nfourth pass');
  const toomany=editChordSetup(f);const l2=byClass(toomany.root,'lyr');
  l2[2].textContent='a\nb\nc';l2[2].oninput();press(l2[2],'Enter');await tick();
  assert.equal(toomany.commits.length,0);assert.match(toomany.root.textContent,/only 2 lines/);
});

test('Edit: Enter on a line moves to the next line', async () => {
  const f=fixture();f.content.sections[0].lyrics='first pass words';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0}]}]};
  const m=editChordSetup(f);let focused=null;
  const lines=byClass(m.root,'lyr');lines[1].focus=()=>{focused=1;};
  press(lines[0],'Enter');await tick();
  assert.equal(focused,1);assert.equal(m.commits.length,0);                                // nothing changed, nothing saved
});

// ===================== split and join sections =====================
test('Edit: a section can be joined with the one above it, never the first', async () => {
  const m=editChordSetup(repeated());
  const joins=byClass(m.root,'join-prev');assert.equal(joins.length,2);
  joins[0].onclick();await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Join sections');
  assert.equal(m.commits[0].candidate.sections.length,2);
  assert.equal(byClass(editChordSetup(fixture()).root,'join-prev').length,0);
  assert.equal(byClass(mount(repeated()).root,'join-prev').length,0);                // Edit only
});

test('Edit: a section splits at a row or bar boundary into two non-empty sections and the new name is ready to type', async () => {
  const f=fixture();f.content.chords.forEach((c,i)=>{if(c.start>=16)c.label=['Am','F','C','E'][i%4];});
  const m=editChordSetup(f);
  const splits=byClass(m.root,'split-here');assert.ok(splits.length>0);
  const rowSplit=byClass(m.root,'split-gap')[0]?.children[0];assert.ok(rowSplit,'a split point sits between rows');
  rowSplit.onclick();await tick();
  assert.equal(m.commits.length,1);assert.equal(m.commits[0].label,'Split section');
  const next=m.commits[0].candidate.sections;assert.equal(next.length,2);assert.equal(next[1].name,'New section');
  assert.equal(next[0].end,next[1].start);assert.ok(next[0].end>next[0].start&&next[1].end>next[1].start);
  assert.equal(byClass(mount(f).root,'split-here').length,0);                         // Edit only
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
