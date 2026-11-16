// After a show has stopped or finished, with its Perform screen still open, the player's Play must not quietly play the plain song.
// (The show lets go of the player when it ends; Play then played the recording with no flags, no MIDI and no visuals under a screen that said
// "Stopped". Play now asks the show page to run the show again, the way its "Run it again" button does.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport} from '../chordbuddy/web/transport.js';

const audio={addEventListener(){},pause(){},play:async()=>{},load(){},removeAttribute(){}};
function rig(){
  const t=new Transport({audio,token:'x',createPcm:async()=>({})});
  t.state.ready=true;t.state.duration=100;
  const plain=[];
  t.pcm={play:v=>plain.push(['pcm',v]),prime:async()=>{},mix(){},mode(){},dispose(){}};
  return {t,plain};
}

test('Play on an ended show runs it again, and does not start the plain player', async()=>{
  const {t,plain}=rig();let again=0;
  t.showAgain=()=>{again++;return true;};
  await t.play();
  assert.equal(again,1);assert.deepEqual(plain,[],'nothing of the plain player was started');
  assert.equal(t.getSnapshot().playIntent,false);
});

test('when no show is waiting to be run again, Play plays the song as usual', async()=>{
  const {t,plain}=rig();let again=0;
  t.showAgain=()=>{again++;return false;};
  await t.play();
  assert.equal(again,1);assert.ok(t.getSnapshot().playIntent,'the ordinary Play went ahead');
});

test('while a show is in hand, Play goes to the show as before and never asks to run it again', async()=>{
  const {t}=rig();let again=0,pressed=0;
  t.showAgain=()=>{again++;return true;};
  t.attachPerformer({playPressed(){pressed++;},resume(){},pause(){}});
  await t.play();
  assert.equal(pressed,1);assert.equal(again,0);
});
