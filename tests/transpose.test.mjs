import test from 'node:test';
import assert from 'node:assert/strict';
import {pitchOfLetter,parseKey,stepOffset,wrapOffset,nearestStep,intervalFor,invertInterval,transposeNote,transposeChord,transposeKey,offsetText}
  from '../chordbuddy/web/transpose.js';

const NOTE_PC={C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,Fb:4,'E#':5,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11,Cb:11,'B#':0};
const pc=note=>{const m=/^([A-G])(#{0,2}|b{0,2})$/.exec(note);return ((({C:0,D:2,E:4,F:5,G:7,A:9,B:11})[m[1]]+[...m[2]].reduce((n,c)=>n+(c==='#'?1:-1),0))%12+12)%12;};

test('a typed key letter gives its pitch; qualities and junk give nothing', () => {
  for(const [text,want] of Object.entries(NOTE_PC))assert.equal(pitchOfLetter(text),want,text);
  assert.equal(pitchOfLetter('f♯'),6);assert.equal(pitchOfLetter(' D♭ '),1);assert.equal(pitchOfLetter('a'),9);
  for(const bad of ['Am','C minor','H','','C##','#',null,undefined])assert.equal(pitchOfLetter(bad),null,String(bad));
});

test('stepping wraps around the corner as in the table: up from A reaches Eb at +6, then E at -5', () => {
  const up=[];let n=0;for(let i=0;i<8;i++){n=stepOffset(n,1);up.push(n);}
  assert.deepEqual(up,[1,2,3,4,5,6,-5,-4]);
  const down=[];n=0;for(let i=0;i<8;i++){n=stepOffset(n,-1);down.push(n);}
  assert.deepEqual(down,[-1,-2,-3,-4,-5,-6,5,4]);
  const names=[];n=0;for(let i=0;i<7;i++){n=stepOffset(n,1);names.push(intervalFor('A minor',n).key);}
  assert.deepEqual(names,['Bb minor','B minor','C minor','C# minor','D minor','Eb minor','E minor']);
  assert.deepEqual([wrapOffset(7),wrapOffset(-7),wrapOffset(6),wrapOffset(-6),wrapOffset(12),wrapOffset(13)],[-5,5,6,-6,0,1]);
});

test('typing a key letter goes the shorter way from the key shown now, and a tritone tie goes up', () => {
  const A=9;
  assert.equal(nearestStep(0,pitchOfLetter('C'),A),3);
  assert.equal(nearestStep(0,pitchOfLetter('F'),A),-4);
  assert.equal(nearestStep(0,pitchOfLetter('Eb'),A),6);    // tie: up
  assert.equal(nearestStep(0,pitchOfLetter('A'),A),0);
  assert.equal(nearestStep(5,pitchOfLetter('E'),A),-5);    // from D (+5) up 2 comes round the corner
  assert.equal(nearestStep(-5,pitchOfLetter('D'),A),-7+12);// from E (-5) down 2 is D (+5)
  assert.equal(nearestStep(3,pitchOfLetter('C'),A),3);
});

test('the shown key keeps its mode and uses the app\'s usual key spelling', () => {
  assert.equal(intervalFor('A minor',3).key,'C minor');
  assert.equal(intervalFor('C major',-5).key,'G major');
  assert.equal(intervalFor('C major',1).key,'Db major');
  assert.equal(intervalFor('E major',2).key,'Gb major');assert.equal(transposeChord('G#m',intervalFor('E major',2)),'Bbm');
  assert.equal(transposeKey('A minor',intervalFor('A minor',3)),'C minor');
  assert.equal(transposeKey('nonsense',intervalFor('A minor',3)),'nonsense');
  assert.deepEqual(intervalFor('',3),{offset:3,semis:3,letters:null,key:null});
  assert.equal(parseKey('Bb major').pitch,10);assert.equal(parseKey('x'),null);
});

test('chords move by the interval between the keys, spelled by letter', () => {
  const CtoG=intervalFor('C major',-5);
  assert.equal(transposeChord('F',CtoG),'C');
  assert.equal(transposeChord('Am7',CtoG),'Em7');
  assert.equal(transposeChord('Bdim',CtoG),'F#dim');
  assert.equal(transposeChord('G/B',CtoG),'D/F#');
  assert.equal(transposeChord('Csus4',CtoG),'Gsus4');
  assert.equal(transposeChord('D7sus4',CtoG),'A7sus4');
  assert.equal(transposeChord('Bbmaj7/D',CtoG),'Fmaj7/A');
  assert.equal(transposeChord('Dm7b5',CtoG),'Am7b5');
  assert.equal(transposeChord('Cm(maj7)',CtoG),'Gm(maj7)');
  const AmToCm=intervalFor('A minor',3);
  assert.equal(transposeChord('E7',AmToCm),'G7');
  assert.equal(transposeChord('G#dim',AmToCm),'Bdim');   // the leading tone stays a leading tone
  assert.equal(transposeChord('F',AmToCm),'Ab');
  assert.equal(transposeChord('C',AmToCm),'Eb');
  // raw analysis labels and scale-degree basses
  assert.equal(transposeChord('A:min',AmToCm),'C:min');
  assert.equal(transposeChord('A:min/b3',AmToCm),'C:min/b3');
});

test('things that are not chords are left alone, and offset 0 changes nothing', () => {
  const iv=intervalFor('C major',3);
  for(const label of ['N','X','','rest','N.C.'])assert.equal(transposeChord(label,iv),label);
  assert.equal(transposeChord(null,iv),null);
  const zero=intervalFor('C major',0);
  for(const label of ['C#m7/G#','Ebmaj7','F##'])assert.equal(transposeChord(label,zero),label);
});

test('a double sharp or flat becomes its plain neighbor, unless the chord had one', () => {
  const up=intervalFor('C# minor',1);   // C# minor -> D minor: up 1 letter, 1 half step
  assert.equal(transposeNote('B#',up),'C#');
  const CtoD=intervalFor('C major',2);   // C -> D: up 1 letter, 2 half steps
  assert.equal(transposeNote('G#',CtoD),'A#');
  assert.equal(transposeNote('D#',CtoD),'E#');
  assert.equal(transposeNote('E#',CtoD),'G');      // F## -> G
  const down=invertInterval(intervalFor('C major',2)); // D back to C: down 1 letter, 2 half steps
  assert.equal(transposeNote('Fb',down),'D');            // Ebb -> D
  assert.equal(transposeNote('F##',intervalFor('C major',0)),'F##');
  assert.equal(transposeNote('F##',CtoD),'G##');   // it had a double sharp already, so it keeps one
});

test('every chord comes back exactly after a round trip, at every offset and key', () => {
  const keys=['C major','A minor','Eb major','F# minor','Db major','B major','G minor','C# minor'];
  const chords=['C','Dm','Em7','F/A','G7sus4','Am(maj7)','Bdim','Bb','Ebmaj7','Ab6','C#m7b5','F#/A#','Gb','D#dim7'];
  for(const key of keys)for(let n=-6;n<=6;n++){
    const there=intervalFor(key,n),back=invertInterval(there);
    for(const chord of chords){
      const moved=transposeChord(chord,there);
      const root=moved.match(/^[A-G](#{1,2}|b{1,2})?/)[0],orig=chord.match(/^[A-G](#{1,2}|b{1,2})?/)[0];
      assert.equal(pc(root),(pc(orig)+n+12)%12,`${chord} in ${key} at ${n}: pitch`);
      // Where the letter moved by the interval's letter count, nothing was simplified, and the way back is exact. (A chromatic chord
      // that would need a double sharp or flat is written plainly instead, so its way back is right by pitch but may be respelled.)
      const notes=label=>[label.match(/^[A-G]/)[0],...(label.match(/\/([A-G])/)?.slice(1)||[])];
      const letterMoved=notes(moved).every((l,i)=>('CDEFGAB'.indexOf(l)-'CDEFGAB'.indexOf(notes(chord)[i])+7)%7===there.letters);
      if(letterMoved)assert.equal(transposeChord(moved,back),chord,`${chord} in ${key} at ${n}: round trip via ${moved}`);
      else assert.equal(pc(transposeChord(moved,back).match(/^[A-G](#{1,2}|b{1,2})?/)[0]),pc(orig),`${chord} in ${key} at ${n}: pitch back`);
    }
  }
});

test('typing while transposed: F typed in G (song in C) is saved as Bb, and F saved in C reads C in G', () => {
  const shownInG=intervalFor('C major',7);              // +7 comes round to -5, still G
  assert.equal(shownInG.key,'G major');assert.equal(shownInG.offset,-5);
  assert.equal(transposeChord('F',invertInterval(shownInG)),'Bb');
  assert.equal(transposeChord('Bb',intervalFor('C major',0)),'Bb');
  assert.equal(transposeChord('F',shownInG),'C');
  assert.equal(transposeChord('Fm7/Ab',invertInterval(shownInG)),'Bbm7/Db');
});

test('songs with no key still move, by pitch, keeping each chord\'s own kind of accidental', () => {
  const up=intervalFor(null,1);
  assert.equal(transposeChord('C',up),'C#');
  assert.equal(transposeChord('Bb',up),'B');
  assert.equal(transposeChord('Db',up),'D');
  assert.equal(transposeChord('Eb',up),'E');
  assert.equal(transposeChord('Ab/C',up),'A/C#');
  assert.equal(transposeChord('E',intervalFor(null,-1)),'D#');
});

test('offsets are written with a sign', () => {
  assert.deepEqual([offsetText(0),offsetText(3),offsetText(-2)],['0','+3','-2']);
});
