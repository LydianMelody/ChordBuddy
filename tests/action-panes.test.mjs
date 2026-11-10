import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,all} from './compact-dom.mjs';
import {FIELDS} from '../chordbuddy/web/performance-plan.js';
import {fieldRows} from '../chordbuddy/web/action-panes.js';
installDom();

test('the Helix preset is picked the way the Helix names it, 1A to 32D, and saved as its number', () => {
 let saved=null;const rows=fieldRows(FIELDS['midi.helix'],{device:'helix',channel:1,preset:6},v=>{saved=v;});
 const pick=rows.flatMap(r=>[r,...all(r)]).find(n=>n.tagName==='select'&&n.children[1]?.textContent==='1A');
 assert.ok(pick,'a list of presets');
 const names=pick.children.map(o=>o.textContent);
 assert.deepEqual([names[0],names[1],names[4],names[5],names.at(-1)],['No change','1A','1D','2A','32D']);assert.equal(names.length,129);
 assert.equal(pick.value,'6');
 pick.value='9';pick.onchange();assert.equal(saved.preset,9,'3A is preset 9');
 pick.value='';pick.onchange();assert.ok(!('preset' in saved),'No change leaves the preset out');
});
