// A song's key, guessed from its chords: the key whose own chords cover the most playing time, with a nudge for chords that
// are the key's tonic, dominant and subdominant. It is only a starting point; the key chip lets the player change it.
import {displayChordLabel} from './editor.js';

const SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const PITCH={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
// Keys that are usually written with flats; the rest use sharps.
const FLAT_MAJOR=new Set([5,10,3,8,1]),FLAT_MINOR=new Set([2,7,0,5,10]);

export function parseChord(label){
  const shown=displayChordLabel(label);
  const match=/^([A-G])([#b]{0,2})(.*)$/.exec(String(shown||''));if(!match)return null;
  let pitch=PITCH[match[1]];for(const c of match[2])pitch+=c==='#'?1:-1;
  const rest=match[3].split('/')[0];
  const quality=/^dim|^m7b5|^hdim/.test(rest)?'dim':/^m(?!aj)|^min/.test(rest)?'min':'maj';
  return {pitch:((pitch%12)+12)%12,quality};
}

// Chords of each key as [semitones above the tonic, quality, weight].
const MAJOR_KEY=[[0,'maj',1.3],[2,'min',.8],[4,'min',.6],[5,'maj',1],[7,'maj',1.1],[9,'min',1],[11,'dim',.3]];
const MINOR_KEY=[[0,'min',1.3],[2,'dim',.3],[3,'maj',1],[5,'min',.9],[7,'min',.7],[7,'maj',.9],[8,'maj',1],[10,'maj',1]];

export function keyName(tonic,mode){
  const names=(mode==='minor'?FLAT_MINOR:FLAT_MAJOR).has(tonic)?FLAT:SHARP;
  return names[tonic]+' '+mode;
}

// chords: [{label,start,end}] -> {tonic,mode,label} or null when there is nothing to go on.
export function estimateKey(chords){
  const heard=[];
  for(const chord of chords||[]){
    const parsed=parseChord(chord.label),length=(chord.end??0)-(chord.start??0);
    if(parsed&&length>0)heard.push({...parsed,length});
  }
  if(!heard.length)return null;
  let best=null;
  for(let tonic=0;tonic<12;tonic++)for(const [mode,table] of [['major',MAJOR_KEY],['minor',MINOR_KEY]]){
    let score=0;
    for(const chord of heard){
      const hit=table.find(([step,quality])=>(tonic+step)%12===chord.pitch&&quality===chord.quality);
      score+=hit?chord.length*hit[2]:-chord.length*.35;
    }
    // the song usually begins and ends on its tonic
    const [first,last]=[heard[0],heard.at(-1)];
    for(const edge of [first,last])if(edge.pitch===tonic&&edge.quality===(mode==='minor'?'min':'maj'))score+=heard.reduce((n,c)=>n+c.length,0)*.04;
    if(!best||score>best.score+1e-9)best={score,tonic,mode};
  }
  return {tonic:best.tonic,mode:best.mode,label:keyName(best.tonic,best.mode)};
}

// Every key a player can pick, for the chip's menu.
export const KEY_CHOICES=[...Array(12).keys()].flatMap(tonic=>[keyName(tonic,'major'),keyName(tonic,'minor')]);
