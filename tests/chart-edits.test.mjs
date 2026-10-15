import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildChartModel} from '../chordbuddy/web/chart-model.js';
import {planPageEdit} from '../chordbuddy/web/chart-edits.js';
import {layoutLine} from '../chordbuddy/web/word-layout.js';
import {effectiveMeasures} from '../chordbuddy/web/chart-layout.js';

// The shared fixture: one Chorus, G C D C played four times (bars of 2 s, 16 bars). The folded group shows bars 1-4.
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
function setup(lyrics='',lines=[]){
  const f=fixture();f.content.sections[0].lyrics=lyrics;f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines};
  const model=buildChartModel(f.content,f.music),group=model.sections[0].groups[0];
  return {...f,model,group};
}
const chunkAt=(group,bar)=>group.bars[bar].chunks[0];
const placed=(content,music,line=0)=>layoutLine(content,effectiveMeasures(music,content.layout),'s',line).tokens.map(t=>[t.text,+t.seconds.toFixed(3),t.pinned]);

test('typing under a chord starts a new lyric line, pinned to that chord and spread across the row', () => {
  const {content,music,model,group}=setup('');
  const r=planPageEdit.slotText({content,music,model,group,lane:{line:null,passNumber:1,tokens:[]},laneIndex:0,chunk:chunkAt(group,2),text:'hello big world'});
  assert.equal(r.conflicts.length,0);assert.equal(r.label,'Add lyrics');
  assert.equal(r.candidate.sections[0].lyrics,'hello big world');
  const tokens=placed(r.candidate,music);
  assert.deepEqual(tokens[0],['hello',4,true]);                       // pinned on the D chord at bar 3
  assert.ok(tokens[1][1]>4&&tokens[2][1]>tokens[1][1]);              // the rest spread between the pin and the end of the row
  assert.equal(r.candidate.layout.lines[0].start_measure,'m0');
});

test('a new line is appended after existing lines', () => {
  const {content,music,model,group}=setup('first line');
  const r=planPageEdit.slotText({content,music,model,group,lane:{line:null,passNumber:1,tokens:[]},laneIndex:1,chunk:chunkAt(group,0),text:'second'});
  assert.equal(r.candidate.sections[0].lyrics,'first line\nsecond');
});

test('typing nothing in a new slot does nothing', () => {
  const {content,music,model,group}=setup('');
  const r=planPageEdit.slotText({content,music,model,group,lane:{line:null,passNumber:1,tokens:[]},laneIndex:0,chunk:chunkAt(group,0),text:'  '});
  assert.equal(r.candidate,null);
});

function twoWordLine(){
  // "one two": "one" pinned on the G at bar 1, "two" pinned on the D at bar 3
  const s=setup('one two',[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m2',beat:0}]}]);
  s.lane=s.group.lanes[0];return s;
}

test('retyping a word under its chord keeps that word and every other pin', () => {
  const {content,music,model,group,lane}=twoWordLine();
  const r=planPageEdit.slotText({content,music,model,group,lane,laneIndex:0,chunk:chunkAt(group,0),text:'won'});
  assert.equal(r.candidate.sections[0].lyrics,'won two');
  assert.deepEqual(placed(r.candidate,music),[['won',0,true],['two',4,true]]);
});

test('fixing a typo keeps the pin where it was, even if it was dragged off its chord', () => {
  const s=setup('hello wrold',[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m2',beat:2}]}]);
  const lane=s.group.lanes[0],chunk=s.group.bars[2].chunks[0];    // "wrold" sits at 5 s, under the D chord
  const r=planPageEdit.slotText({...s,lane,laneIndex:0,chunk,text:'world'});
  assert.equal(r.lost,0);assert.deepEqual(placed(r.candidate,s.music),[['hello',0,true],['world',5,true]]);
});

test('typing under an empty chord inserts the words in time order and pins the first of them', () => {
  const {content,music,model,group,lane}=twoWordLine();
  const r=planPageEdit.slotText({content,music,model,group,lane,laneIndex:0,chunk:chunkAt(group,1),text:'and then'});
  assert.equal(r.candidate.sections[0].lyrics,'one and then two');
  assert.deepEqual(placed(r.candidate,music).map(t=>[t[0],t[1],t[2]]),[['one',0,true],['and',2,true],['then',3,false],['two',4,true]]);
});

test('clearing a chord\'s words removes them; the pins of the other words stay', () => {
  const {content,music,model,group,lane}=twoWordLine();
  const r=planPageEdit.slotText({content,music,model,group,lane,laneIndex:0,chunk:chunkAt(group,2),text:''});
  assert.equal(r.candidate.sections[0].lyrics,'one');assert.equal(r.lost,1);assert.deepEqual(placed(r.candidate,music).map(t=>[t[0],t[2]]),[['one',true]]);
});

test('clearing the only words of a line removes the line', () => {
  const s=setup('solo',[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0}]}]);
  const r=planPageEdit.slotText({...s,lane:s.group.lanes[0],laneIndex:0,chunk:chunkAt(s.group,0),text:''});
  assert.equal(r.candidate.sections[0].lyrics,'');assert.equal(r.candidate.layout.lines.length,0);
});

test('words typed under a chord stay together: they fall under that chord in the page model', () => {
  const {content,music,model,group,lane}=twoWordLine();
  const r=planPageEdit.slotText({content,music,model,group,lane,laneIndex:0,chunk:chunkAt(group,1),text:'and then'});
  const next=buildChartModel(r.candidate,music).sections[0].groups[0];
  const words=bar=>(next.bars[bar].chunks[0].lanes[0]||[]).map(t=>t.text).join(' ');
  assert.equal(words(0),'one');assert.equal(words(1),'and then');assert.equal(words(2),'two');
});

test('an unplaced line can be placed on the row so its words spread across it', () => {
  const s=setup('free floating words');
  assert.equal(s.group.lanes[0].flow,true);
  const next=planPageEdit.placeOnRow({content:s.content,group:s.group,pass:s.group.passes[0],lane:s.group.lanes[0]});
  const l=layoutLine(next,effectiveMeasures(s.music,next.layout),'s',0);assert.equal(l.placed,true);assert.equal(l.tokens[0].seconds,0);assert.ok(l.tokens[2].seconds>l.tokens[1].seconds);
});

test('the original document is never changed by planning an edit', () => {
  const {content,music,model,group,lane}=twoWordLine();const before=JSON.stringify(content);
  planPageEdit.slotText({content,music,model,group,lane,laneIndex:0,chunk:chunkAt(group,0),text:'changed'});
  assert.equal(JSON.stringify(content),before);
});
