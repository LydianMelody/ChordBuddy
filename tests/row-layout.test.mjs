import test from 'node:test';
import assert from 'node:assert/strict';
import {planRows,lanesToKeep,applyRows} from '../chordbuddy/web/row-layout.js';

test('bars that all fit stay on one line', () => {
  assert.deepEqual(planRows([200,200,200,200],900),[4]);
  assert.deepEqual(planRows([300],100),[1]);
  assert.deepEqual(planRows([],100),[0]);
});

test('four bars where only three fit become two lines of two, not three and one', () => {
  assert.deepEqual(planRows([220,220,220,220],700),[2,2]);
});

test('five bars become three and two, and six become three and three', () => {
  assert.deepEqual(planRows([200,200,200,200,200],650),[3,2]);
  assert.deepEqual(planRows([150,150,150,150,150,150],650),[3,3]);
});

test('uneven bars: the even split is used only when every line really fits', () => {
  assert.deepEqual(planRows([500,100,100,500],650),[2,2]);            // plain wrapping would give 3 + 1; 500+100 and 100+500 both fit
  assert.deepEqual(planRows([400,400,100,100],850),[2,2]);
  assert.deepEqual(planRows([100,100,400,400],700),[3,1]);            // an even 2 + 2 would need 800 px on the second line, so the plain wrapping stays
});

test('the number of lines never grows and every bar is placed once', () => {
  for(const widths of [[230,310,250,260,220],[100,100,100,100,100,100,100],[640,180,180,180]]){
    const rows=planRows(widths,700);
    assert.equal(rows.reduce((a,b)=>a+b,0),widths.length);
    let plain=1,sum=0,count=0;for(const w of widths){if(count&&sum+w>700){plain++;sum=0;count=0;}sum+=w;count++;}
    assert.equal(rows.length,plain);
  }
});

test('a wrapped line keeps the lyric lanes up to its last one with words', () => {
  assert.equal(lanesToKeep([false,false,false,false]),0);
  assert.equal(lanesToKeep([true,false,false,false]),1);
  assert.equal(lanesToKeep([false,true,false,false]),2,'an empty lane above a used one stays, so each pass keeps its height');
  assert.equal(lanesToKeep([]),0);
});

// Just enough of the DOM for applyRows: classes, data attributes, nesting, and the selectors it uses.
class El {
  constructor(cls='',data={},width=0){this.classes=new Set(cls.split(' ').filter(Boolean));this.dataset=data;this.children=[];this.parent=null;this.offsetWidth=width;
    this.classList={add:c=>this.classes.add(c),remove:c=>this.classes.delete(c),contains:c=>this.classes.has(c)};}
  append(...kids){for(const k of kids){k.parent=this;this.children.push(k);}return this;}
  after(node){const at=this.parent.children.indexOf(this);node.parent=this.parent;this.parent.children.splice(at+1,0,node);}
  remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);}
  matches(sel){const m=/^((?:\.[\w-]+)+)(?:\[data-([\w-]+)\])?$/.exec(sel);return [...m[1].split('.').filter(Boolean)].every(c=>this.classes.has(c))&&(!m[2]||m[2] in this.dataset);}
  querySelectorAll(sel){const out=[];const walk=n=>{for(const c of n.children){if(c.matches(sel))out.push(c);walk(c);}};walk(this);return out;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  closest(sel){let n=this;while(n&&!n.matches(sel))n=n.parent;return n;}
}
function bar(words){                    // words[i]: whether lane i of this bar has a word
  const chunk=new El('chunk');
  words.forEach((has,i)=>{const lyr=new El('lyr',{lane:String(i)});if(has)lyr.append(new El('w'));chunk.append(new El('lane').append(lyr));});
  return new El('bar',{},300).append(chunk);
}
const idle=b=>b.querySelectorAll('.lane').map(l=>l.classList.contains('lane-idle'));

test('a repeated row whose words are all on its first line: the wrapped line drops its empty lanes', () => {
  globalThis.document={createElement:()=>new El()};
  const bars=[bar([true,true,true,true]),bar([true,true,true,true]),bar([false,false,false,false]),bar([false,true,false,false])];
  const container=new El('bars').append(...bars);container.clientWidth=700;     // two bars to a line
  applyRows(container);
  assert.deepEqual(idle(bars[0]),[false,false,false,false],'the first line is left as it is');
  assert.deepEqual(idle(bars[2]),[false,false,true,true],'the second line keeps lanes 1-2 (pass 2 has a word in bar 4)');
  assert.deepEqual(idle(bars[3]),[false,false,true,true]);
  bars[3].querySelector('.w').remove();applyRows(container);
  assert.deepEqual([...idle(bars[2]),...idle(bars[3])],Array(8).fill(true),'with no words left the line has no lanes');
  container.clientWidth=2000;applyRows(container);
  assert.ok(bars.every(b=>idle(b).every(x=>!x)),'back on one line, every lane shows again');
  delete globalThis.document;
});
