import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all,installDom} from './compact-dom.mjs';
import {renderLibraryPage,tapeTint} from '../chordbuddy/web/library-page.js';

const has=(n,c)=>String(n.className||'').split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const songs=[{id:'a',title:'Real Thing',artist:'LeBrock',active_run:'r',duration:305},{id:'b',title:'Tek It',artist:'Cafuné',active_run:null,duration:193}];
const lists=[{id:'g',name:'Gig',song_ids:['a']},{id:'h',name:'Practice',song_ids:['a','b']}];

function mount(extra={}){
  installDom();const root=new Node(),calls=[];
  renderLibraryPage(root,{songs,setlists:lists,selected:'a',busy:null,query:'',...extra},{
    onOpen:id=>calls.push(['open',id]),onRemove:(l,s)=>calls.push(['remove',l,s]),onDragStart:id=>calls.push(['drag',id]),onDragEnd:()=>calls.push(['end']),
    onSearch:q=>calls.push(['search',q]),onImport:()=>calls.push(['import']),line:s=>{const n=new Node('b');n.className='fact-badge';n.textContent=s.active_run?'♩120':'';return n;},total:'8:18',time:t=>Math.floor(t/60)+':'+String(t%60).padStart(2,'0')});
  return {root,calls};
}

test('All songs lists every song with the set lists it is in; each card is dragged onto a set list and opens on click', () => {
  const {root,calls}=mount();
  const cards=byClass(root,'library-song');
  assert.deepEqual(cards.map(c=>c.dataset.song),['a','b']);assert.ok(has(cards[0],'selected'));assert.equal(cards[1].dataset.status,'new');
  assert.deepEqual(byClass(cards[0],'library-tag').map(t=>t.textContent),['Gig','Practice']);
  assert.deepEqual(byClass(cards[1],'library-tag').map(t=>t.textContent),['Practice']);
  assert.equal(cards[0].draggable,true);
  cards[1].ondragstart({dataTransfer:{setData(){},effectAllowed:''}});cards[1].ondragend();
  byClass(cards[1],'library-open')[0].onclick();
  byClass(cards[0],'library-untag')[0].onclick({stopPropagation(){}});
  assert.deepEqual(calls,[['drag','b'],['end'],['open','b'],['remove','g','a']]);
});

test('search narrows the list; an empty library offers Import', () => {
  assert.deepEqual(byClass(mount({query:'lebr'}).root,'library-song').map(c=>c.dataset.song),['a']);
  const empty=mount({songs:[]});
  assert.equal(byClass(empty.root,'library-song').length,0);
  all(empty.root).find(n=>n.tagName==='button'&&has(n,'hot')).onclick();assert.deepEqual(empty.calls,[['import']]);
});

test('each song is a little cassette: its artist on the label, tempo and key in the window; the list shows its total length', () => {
  const {root}=mount();
  assert.deepEqual(byClass(root,'list-total').map(n=>n.textContent),['8:18 total']);
  const tape=byClass(root,'library-song')[0];
  assert.equal(byClass(tape,'tape-label')[0].children[1].textContent,'LeBrock');
  assert.ok(byClass(byClass(tape,'tape-window')[0],'fact-badge').length,'tempo and key in the tape window');
  assert.deepEqual(byClass(root,'library-song').map(c=>c.dataset.tint),byClass(root,'library-song').map(c=>String(tapeTint(c.dataset.song))),'each song keeps its own color');
  assert.equal(tapeTint('abc'),tapeTint('abc'));assert.ok([0,1,2,3,4].includes(tapeTint('song-7')));
});
