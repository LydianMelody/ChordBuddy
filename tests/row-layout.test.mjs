import test from 'node:test';
import assert from 'node:assert/strict';
import {planRows} from '../chordbuddy/web/row-layout.js';

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
