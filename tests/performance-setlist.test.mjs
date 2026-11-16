// One place chooses which arrangement of a song a set list plays: the Performance dropdown at the top of the song's Perform tab.
// The set list keeps what it says (arrangementOf, chooseArrangement); the line under a song in the sidebar has no second choice of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './compact-dom.mjs';

installDom();
const {createSetlistPanel}=await import('../chordbuddy/web/performance-setlist.js');
const settle=(ms=20)=>new Promise(r=>setTimeout(r,ms));

function rig(){
  const calls=[];
  const show={schema:1,id:'list-L',name:'Nov Show',sourceList:'L',target:null,policy:{all:'until-released'},transitions:{kind:'immediate',seconds:0},devices:[],
    entries:[{id:'e1',songId:'a',performanceId:null,revision:null,transition:null},{id:'e2',songId:'b',performanceId:'p9',revision:2,transition:null}]};
  const saved={a:[{id:'p1',name:'Outrun the Night!',head:3,updated:'x'},{id:'p2',name:'Acoustic',head:5,updated:'y'}],b:[{id:'p9',name:'Live',head:2,updated:'z'}]};
  const api=async(path,body)=>{
    calls.push([path,body]);
    if(path==='/api/show/list-L')return {id:'list-L',head:1,body:structuredClone(show),draft:null};
    if(path.startsWith('/api/performances/'))return saved[path.split('/').pop()]||[];
    return {};
  };
  let redraws=0;
  const panel=createSetlistPanel({api,scenes:()=>[],setlists:()=>[{id:'L',name:'Nov Show',song_ids:['a','b']}],refresh(){},redraw(){redraws++;},showError(e){throw e;},onMidiSetup(){},onPerform(){},
    entryLength:async()=>({segments:[],measures:[],countBars:0,music:60,live:false})});
  return {panel,calls,drafts:()=>calls.filter(c=>c[0]==='/api/show/draft').map(c=>c[1].body),redraws:()=>redraws};
}

test('the set list says which arrangement each of its songs plays', async()=>{
  const r=rig();
  assert.equal(r.panel.arrangementOf('a'),undefined,'nothing is known until a set list is chosen and has loaded');
  r.panel.sync('L');await settle();
  assert.equal(r.panel.arrangementOf('a'),null,'the Original arrangement');
  assert.equal(r.panel.arrangementOf('b'),'p9');
  assert.equal(r.panel.arrangementOf('zzz'),undefined,'a song that is not in this set list');
  r.panel.sync('default');
  assert.equal(r.panel.arrangementOf('a'),undefined,'All songs is not a set list');
});

test('choosing in the Perform tab is what the set list then plays, and it is saved', async()=>{
  const r=rig();r.panel.sync('L');await settle();
  r.panel.chooseArrangement('a','p1');
  assert.equal(r.panel.arrangementOf('a'),'p1');
  await settle(750);                                        // the draft is saved a moment after the last change
  const entry=r.drafts().at(-1).entries.find(e=>e.songId==='a');
  assert.deepEqual([entry.performanceId,entry.revision],['p1',3]);
  assert.equal(r.drafts().at(-1).entries.find(e=>e.songId==='b').performanceId,'p9','the other songs are left alone');
  r.panel.chooseArrangement('a',null);
  assert.equal(r.panel.arrangementOf('a'),null,'back to the Original arrangement');
  await settle(750);
  assert.deepEqual([r.drafts().at(-1).entries[0].performanceId,r.drafts().at(-1).entries[0].revision],[null,null]);
});

test('choosing what it already plays, or a song that is not in the list, changes nothing', async()=>{
  const r=rig();r.panel.sync('L');await settle();
  const before=r.redraws();
  r.panel.chooseArrangement('b','p9');r.panel.chooseArrangement('zzz','p1');
  await settle(750);
  assert.equal(r.drafts().length,0);assert.equal(r.redraws(),before);
});

test('the line under a song says which arrangement plays, and offers no second choice of it', async()=>{
  const r=rig();r.panel.sync('L');await settle();
  r.panel.chooseArrangement('a','p1');await settle();
  const closed=r.panel.rowDetails('a','Real Thing');
  assert.match(closed.querySelector('.set-summary').textContent,/Outrun the Night!/,'it still says which one');
  closed.querySelector('.set-summary').onclick();           // open the line
  const open=r.panel.rowDetails('a','Real Thing');
  const labels=open.querySelectorAll('select').map(s=>s.attributes['aria-label']||'');
  assert.ok(!labels.some(l=>/arrangement/i.test(l)),'no arrangement dropdown here: '+labels.join(' | '));
  assert.ok(!/Arrangement/.test(open.querySelectorAll('label, .field, span').map(n=>n.textContent).join(' ').replace(/Outrun the Night!.*?(?= )/,'')),'and no Arrangement field');
});
