import test from 'node:test';
import assert from 'node:assert/strict';
import {createStage,BEAT} from '../chordbuddy/web/visual-stage.js';
import {readOrder,writeOrder,orderScenes,stepScene,moveScene} from '../chordbuddy/web/visual-setup.js';

// Only one visualizer draws at a time (visual-stage.js).
function stage(){
  const said=[];let clock=0;
  const s=createStage({post:m=>said.push(m),now:()=>clock});
  return {s,said,last:()=>said.at(-1),wait:ms=>{clock+=ms;}};
}

test('a lone visualizer draws, and the newest one opened takes over and closes the older one on screen', ()=>{
  const {s,last}=stage();
  s.receive({type:'here',id:'pop',kind:'window'});
  assert.deepEqual(last(),{type:'stage',drawer:'pop',close:[]});
  s.receive({type:'here',id:'full',kind:'overlay'});
  assert.deepEqual(last(),{type:'stage',drawer:'full',close:['pop']});
  s.receive({type:'here',id:'pop',kind:'window'});            // a late heartbeat from the closed one does not bring it back
  assert.equal(s.drawer,'full');
});

test('the editor preview waits while its look is in a window, and takes it back without closing itself', ()=>{
  const {s,last}=stage();
  s.receive({type:'here',id:'editor',kind:'editor'});
  assert.equal(last().drawer,'editor');
  s.receive({type:'here',id:'pop',kind:'window'});            // Pop out
  assert.deepEqual(last(),{type:'stage',drawer:'pop',close:[]});
  s.receive({type:'take',id:'editor'});                        // Show the preview here
  assert.deepEqual(last(),{type:'stage',drawer:'editor',close:['pop']});
  s.receive({type:'here',id:'pop2',kind:'window'});
  assert.deepEqual(last(),{type:'stage',drawer:'pop2',close:[]},'the editor is never closed');
});

test('while OBS draws, nothing here does; hidden in OBS, the newest one here draws again', ()=>{
  const {s,last}=stage();
  s.receive({type:'here',id:'pop',kind:'window'});
  s.obs({connected:1,drawing:1});
  assert.deepEqual(last(),{type:'stage',drawer:'obs',close:[]});
  s.receive({type:'here',id:'controls',kind:'controls'});
  assert.equal(last().drawer,'obs');
  s.obs({connected:1,drawing:0});
  assert.deepEqual(last(),{type:'stage',drawer:'pop',close:[]});
  assert.deepEqual(s.obsState,{connected:1,drawing:0});
});

test('the Stream controls window never draws or closes, and a visualizer that vanished is forgotten', ()=>{
  const {s,last,said,wait}=stage();
  s.receive({type:'here',id:'controls',kind:'controls'});
  assert.equal(last().drawer,null);
  s.receive({type:'here',id:'pop',kind:'window'});
  assert.equal(last().drawer,'pop');
  const before=said.length;
  for(let i=0;i<3;i++){wait(BEAT);s.receive({type:'here',id:'controls',kind:'controls'});s.tick();}
  assert.equal(said.length,before,'heartbeats say nothing new');
  wait(BEAT);s.tick();                                         // pop stopped saying "here" (crashed, or closed without a word)
  assert.equal(last().drawer,null);
  s.receive({type:'bye',id:'controls'});
  assert.deepEqual(s.kinds(),[]);
});

test('messages that are not for the stage are left alone', ()=>{
  const {s,said}=stage();
  for(const m of [null,{type:'here'},{type:'here',id:'x',kind:'tv'},{type:'here',id:'x'.repeat(65),kind:'window'},{type:'clock',id:'x'}])
    assert.equal(s.receive(m),false);
  assert.deepEqual(said,[]);
});

// The picker's order (visual-setup.js)
const scenes=['abstract','starlane','runner','skyward','rainydesk'].map(id=>({id,name:id}));
test('the picker shows your order first, then the rest in file order', ()=>{
  assert.deepEqual(orderScenes(scenes,['runner','gone','abstract']).map(s=>s.id),['runner','abstract','starlane','skyward','rainydesk']);
  assert.deepEqual(orderScenes(scenes,[]).map(s=>s.id),scenes.map(s=>s.id));
});

test('next and previous go around at the ends', ()=>{
  assert.equal(stepScene(scenes,'rainydesk',1).id,'abstract');
  assert.equal(stepScene(scenes,'abstract',-1).id,'rainydesk');
  assert.equal(stepScene(scenes,'starlane',1).id,'runner');
  assert.equal(stepScene(scenes,'missing',1).id,'abstract');
  assert.equal(stepScene([],'abstract',1),null);
});

test('dragging a look to a new place keeps every other one where it was', ()=>{
  assert.deepEqual(moveScene(scenes,'rainydesk',0),['rainydesk','abstract','starlane','runner','skyward']);
  assert.deepEqual(moveScene(scenes,'abstract',99),['starlane','runner','skyward','rainydesk','abstract']);
  assert.deepEqual(moveScene(scenes,'nope',1),scenes.map(s=>s.id));
});

test('a saved order keeps only real ids, once each', ()=>{
  assert.deepEqual(readOrder('["a","b","a",3,"bad id!",""]'),['a','b']);
  assert.deepEqual(readOrder('not json'),[]);assert.deepEqual(readOrder('{"a":1}'),[]);
  assert.equal(writeOrder(['x','x','y']),'["x","y"]');
});
