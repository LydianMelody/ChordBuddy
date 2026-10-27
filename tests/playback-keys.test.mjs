import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackAction,targetSeconds} from '../chordbuddy/web/playback-keys.js';

const key=(k,extra={})=>({key:k,code:k===' '?'Space':'',target:null,...extra});

test('Space plays and pauses, R loops, the arrows step a bar and Ctrl+arrows a section', () => {
  assert.deepEqual(playbackAction(key(' ')),{type:'toggle',repeat:false});
  assert.deepEqual(playbackAction(key('r')),{type:'loop',repeat:false});
  assert.deepEqual(playbackAction(key('R')),{type:'loop',repeat:false});
  assert.deepEqual(playbackAction(key('l')),{type:'loop',kind:'bars',repeat:false});
  assert.deepEqual(playbackAction(key('L')),{type:'loop',kind:'bars',repeat:false});
  assert.deepEqual(playbackAction(key('ArrowLeft')),{type:'bar',direction:-1,repeat:false});
  assert.deepEqual(playbackAction(key('ArrowRight',{ctrlKey:true})),{type:'section',direction:1,repeat:false});
});

test('the keys stay out of the way: typing, sliders, scroll bars, dialogs, keys already handled and other shortcuts', () => {
  assert.equal(playbackAction(key('r',{target:{isContentEditable:true}})),null);
  assert.equal(playbackAction(key('ArrowLeft',{target:{tagName:'INPUT'}})),null,'a range input moves itself');
  assert.equal(playbackAction(key('ArrowLeft',{target:{closest:sel=>sel.includes('scrollbar')?{}:null}})),null);
  assert.equal(playbackAction(key('ArrowLeft',{defaultPrevented:true})),null,'the lead sheet moved its selected note');
  assert.equal(playbackAction(key('r',{ctrlKey:true})),null);
  assert.equal(playbackAction(key('ArrowLeft',{shiftKey:true})),null);
  assert.equal(playbackAction(key('ArrowLeft',{altKey:true})),null);
  assert.equal(playbackAction(key('q')),null);
  assert.equal(playbackAction(key(' ',{repeat:true})).repeat,true,'a held space bar is swallowed, not repeated');
});

test('back goes to the start of the bar you are in, or the one before when you are at its start; forward to the next', () => {
  const starts=[0,2,4,6];
  assert.equal(targetSeconds(starts,3.2,-1),2);
  assert.equal(targetSeconds(starts,2.1,-1),0,'just past a barline: the bar before');
  assert.equal(targetSeconds(starts,0.1,-1),0);
  assert.equal(targetSeconds(starts,0,-1),null,'nowhere before the start');
  assert.equal(targetSeconds(starts,3.2,1),4);
  assert.equal(targetSeconds(starts,6.5,1),null,'nowhere after the last');
});

// The Keyboard shortcuts list names every playback key, so the two cannot drift apart.
test('the shortcuts list shows every playback key', async () => {
  const {SHORTCUTS}=await import('../chordbuddy/web/shortcuts.js');
  const playing=SHORTCUTS.find(g=>g.title==='Playing').rows.map(([keys])=>keys.join(' '));
  for(const k of ['Space','R','L'])assert.ok(playing.includes(k),k);
  for(const k of [' ','r','l','ArrowLeft'])assert.ok(playbackAction(key(k)),k);
  assert.ok(SHORTCUTS.find(g=>g.title==='Visualizer').rows.some(([keys])=>keys.join('')==='Y'),'lyrics moved to Y');
});
