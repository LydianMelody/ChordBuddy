import test from 'node:test';
import assert from 'node:assert/strict';
import {shortKey,totalLabel,keyLabelFor,createSongFacts} from '../chordbuddy/web/song-facts.js';

test('badges and totals are short', () => {
  assert.deepEqual(['C# minor','Eb major','A minor','F# major','nonsense'].map(shortKey),['C♯m','E♭','Am','F♯','']);
  assert.deepEqual([305,0,59.6,3600,4321].map(totalLabel),['5:05','0:00','1:00','1:00:00','1:12:01']);
});

test('a key picked from the chip wins; otherwise the key is worked out as for the open song', () => {
  assert.equal(keyLabelFor(null,[{label:'C'}],'Eb major'),'Eb major');
  assert.equal(keyLabelFor({tonic:0,mode:'major',label:'C major'},[{label:'C'},{label:'F'},{label:'G'}],''),'C major');
});

test('each analyzed song is read once per analysis, one at a time', async () => {
  const asked=[],docs={
    '/api/song/a':{documents:[{id:'ch',kind:'chart',kept:true,name:'derived/Song chart.json'},{id:'k',kind:'text',name:'run/key.lab'}]},
    '/api/document/ch':{music:{timing:{bpm:119.6}},content:{chords:[{label:'C'},{label:'G'}]}},
    '/api/document/k':{content:{text:'0\t100\tC:maj'}}};
  let changes=0;
  const facts=createSongFacts({api:async path=>{asked.push(path);return docs[path];},onChange:()=>changes++});
  const songs=[{id:'a',active_run:'r1'},{id:'b',active_run:null}];
  facts.want(songs);facts.want(songs);
  await new Promise(r=>setTimeout(r,10));
  assert.deepEqual([facts.get('a').bpm,facts.get('a').key],[120,'C major']);assert.equal(facts.get('b'),null,'not analyzed: nothing to read');
  assert.equal(asked.filter(p=>p==='/api/song/a').length,1,'asked once');
  facts.want(songs);await new Promise(r=>setTimeout(r,10));assert.equal(asked.filter(p=>p==='/api/song/a').length,1,'and not again');
  facts.set('a','r1',100,'A minor');assert.deepEqual([facts.get('a').bpm,facts.get('a').key],[100,'A minor']);assert.equal(changes,2);
});
