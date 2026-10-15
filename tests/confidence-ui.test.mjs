import test from 'node:test';
import assert from 'node:assert/strict';
test('confidence flags require a known score below the chosen threshold',async()=>{
  const {isLowConfidence}=await import('../chordbuddy/web/confidence-view.js');
  assert.equal(isLowConfidence(null,50),false);
  assert.equal(isLowConfidence(undefined,50),false);
  assert.equal(isLowConfidence(.5,50),false);
  assert.equal(isLowConfidence(.49,50),true);
  assert.equal(isLowConfidence(0,0),false);
});
test('manually relabeled or retimed chords do not inherit unrelated model scores',async()=>{
  const {chordConfidence}=await import('../chordbuddy/web/confidence-view.js');
  const music={confidence:{chords:[{time:2,score:.3,label:'Em'}]}};
  assert.equal(chordConfidence({start:2,label:'Em'},music),.3);
  assert.equal(chordConfidence({start:2,label:'Am'},music),null);
  assert.equal(chordConfidence({start:3,label:'Em'},music),null);
});
test('chord confidence uses the configured opacity range and confirmation clears it',async()=>{
  const {chordOpacity}=await import('../chordbuddy/web/confidence-view.js');
  const music={confidence:{chords:[{time:2,score:.25,label:'Am'}]}};
  const settings={chord_flag_threshold:50,chord_opacity_min:40,chord_opacity_max:100};
  assert.equal(chordOpacity({start:2,label:'Am'},music,settings),.7);
  assert.equal(chordOpacity({start:2,label:'Am',confirmed:true},music,settings),1);
});
