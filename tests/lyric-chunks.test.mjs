import test from 'node:test';
import assert from 'node:assert/strict';
import {lyricTokens,boundaryOffsetMap,lyricPlacementLosses,joinsNext,shownPiece,shownLine} from '../chordbuddy/web/lyric-chunks.js';

test('syllable hyphens split a word into separately placeable chunks that keep their spelling and codepoint offsets', () => {
  assert.deepEqual(lyricTokens('u-ni-corn beau-ti-ful'),[{text:'u-',offset:0},{text:'ni-',offset:2},{text:'corn',offset:5},{text:'beau-',offset:10},{text:'ti-',offset:15},{text:'ful',offset:18}]);
  assert.deepEqual(lyricTokens('😀u-ni é-lan'),[{text:'😀u-',offset:0},{text:'ni',offset:3},{text:'é-',offset:6},{text:'lan',offset:9}]);
});

test('hyphens at an edge or doubled, and non-breaking hyphens, stay literal', () => {
  assert.deepEqual(lyricTokens('-edge edge- a--b mother‑in‑law').map(t=>t.text),['-edge','edge-','a--b','mother‑in‑law']);
});

test('an empty or blank line has no chunks', () => {
  assert.deepEqual(lyricTokens(''),[]);assert.deepEqual(lyricTokens('   '),[]);
});

test('turning a word into syllables (or back) keeps every boundary that survives', () => {
  const map=boundaryOffsetMap('unicorn tail','u-ni-corn tail');
  assert.equal(map.get(0),0);assert.equal(map.get(8),10);
  assert.equal(boundaryOffsetMap('unicorn','different'),null);
});

test('a hidden split (soft hyphen) cuts a word like a typed dash, but is shown as nothing, or as a dash at the end of a line', () => {
  assert.deepEqual(lyricTokens('trou­ble o-own­ing ad­'),[{text:'trou­',offset:0},{text:'ble',offset:5},{text:'o-',offset:9},{text:'own­',offset:11},{text:'ing',offset:15},{text:'ad­',offset:19}]);
  assert.equal(joinsNext('trou­'),true);assert.equal(joinsNext('o-'),true);assert.equal(joinsNext('ble'),false);
  assert.equal(shownPiece('trou­'),'trou');assert.equal(shownPiece('ad­',true),'ad-');assert.equal(shownPiece('o-',true),'o-');
  assert.equal(shownLine('trou­ble o-own­ing and ad­'),'trouble o-owning and ad-');
});

test('placement losses are the pins that no longer exist', () => {
  const before={layout:{lines:[{words:[1,2,3]}]},chords:[{line:0,offset:0}]},after={layout:{lines:[{words:[1]}]},chords:[{line:null,offset:null}]};
  assert.equal(lyricPlacementLosses(before,after),3);assert.equal(lyricPlacementLosses(before,before),0);
});
