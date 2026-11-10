import test from 'node:test';
import assert from 'node:assert/strict';
import {newPerformance,addRepeat,address,editPass,copyPreviousPass,resetPass,movePass,removePass,setPlays,customizedPasses,editShared,loopKey} from '../chordbuddy/web/performance-model.js';
import {compilePerformance,furtherPass,gridFingerprint,validBeatLengths,endForBeats,addressPosition,RATE} from '../chordbuddy/web/performance-compiler.js';
import {pathSeconds,musicSeconds,showSeconds,timing,clockText,spareText} from '../chordbuddy/web/performance-duration.js';
import {checkAction,describeAction,writesOf,ACTIONS,mixFromState,domainOfProperty,helixPresetName} from '../chordbuddy/web/performance-actions.js';
import {defaultMix} from '../chordbuddy/web/pcm-mixer-core.js';

// Bars of 2 seconds at 4 beats, unless told otherwise: a pickup, and an odd 3-beat bar, are easy to add.
function grid(lengths=Array(60).fill(4),sec=.5){
  let t=0;const measures=lengths.map((beats,i)=>{const m={id:`m${i+1}`,number:i+1,start:t,end:t+beats*sec,beats:Array.from({length:beats},(_,b)=>t+b*sec)};t=m.end;return m;});
  return {measures,frames:Math.round(t*RATE)};
}
const G=grid(),pos=addressPosition(G.measures);
let n=0;const uid=()=>`id${++n}`;
const bar=i=>address(`m${i}`);
const song=()=>newPerformance({songId:'s',id:'p'});
const mute=(track,mute=true)=>({type:'track.set',track,mute});
const cue=(id,i,action,extra={})=>({id,at:bar(i),action,...extra});
const f=s=>Math.round(s*RATE);

test('no repeats: the whole song is one segment, and exactly its length', () => {
 const c=compilePerformance(song(),G);
 assert.equal(c.ok,true);assert.equal(c.segments.length,1);
 assert.deepEqual([c.segments[0].start,c.segments[0].end],[0,G.frames]);
 assert.equal(pathSeconds(c.segments).music,120);
});

test('a finite repeat: K plays add (K-1) x its length, and each pass has its own identity over the same frames', () => {
 const p=addRepeat(song(),{start:bar(1),end:bar(5),plays:3,id:'r'},uid);
 const c=compilePerformance(p,G);
 assert.equal(c.ok,true);
 const passes=c.segments.filter(s=>s.regionId==='r');
 assert.equal(passes.length,3);
 for(const s of passes)assert.deepEqual([s.start,s.end],[0,f(8)]);
 assert.equal(new Set(passes.map(s=>s.key)).size,3);
 assert.equal(pathSeconds(c.segments).music,136);
});

test('each pass is edited on its own: a new pass copies the source, then editing Pass 2 cannot change Pass 1 or 3', () => {
 let p=song();p={...p,cues:[cue('shared',2,mute('lead'))]};
 p=addRepeat(p,{start:bar(1),end:bar(5),plays:3,id:'r'},uid);
 const [a,b,c3]=p.regions[0].passes.map(x=>x.id);
 const edited=editPass(p,'r',b,(program)=>{program[0].action=mute('drums');program.push(cue('extra',3,{type:'visual.scene',scene:'abstract'}));},pos,uid);
 assert.equal(p.regions[0].passes[1].program,null,'the original value is untouched');
 const seg=compilePerformance(edited,G).segments;
 assert.deepEqual(seg[0].actions.map(x=>x.action.track),['lead']);
 assert.deepEqual(seg[1].actions.map(x=>x.action.type),['track.set','visual.scene']);
 assert.equal(seg[1].actions[0].action.track,'drums');
 assert.deepEqual(seg[2].actions.map(x=>x.action.track),['lead']);
 assert.deepEqual(customizedPasses(edited.regions[0]),[b]);
 const back=resetPass(edited,'r',b);
 assert.equal(compilePerformance(back,G).segments[1].actions[0].action.track,'lead');
 void a;void c3;
});

test('copy previous, reorder and delete keep pass ids, and programs follow their passes', () => {
 let p=addRepeat(song(),{start:bar(1),end:bar(5),plays:3,id:'r'},uid);
 const [a,b,c3]=p.regions[0].passes.map(x=>x.id);
 p=editPass(p,'r',a,program=>program.push(cue('x',2,mute('bass'))),pos,uid);
 p=copyPreviousPass(p,'r',b,pos,uid);
 const copied=p.regions[0].passes[1].program;
 assert.equal(copied[0].action.track,'bass');assert.notEqual(copied[0].id,p.regions[0].passes[0].program[0].id);
 p=movePass(p,'r',a,2);
 assert.deepEqual(p.regions[0].passes.map(x=>x.id),[b,c3,a]);
 assert.equal(compilePerformance(p,G).segments[2].actions[0].action.track,'bass');
 assert.equal(compilePerformance(p,G).segments[1].actions.length,0);
 p=removePass(p,'r',c3);
 assert.equal(p.regions[0].plays,2);assert.deepEqual(p.regions[0].passes.map(x=>x.id),[b,a]);
});

test('a shared edit reaches passes that follow it, and a customized pass only when named', () => {
 let p={...song(),cues:[cue('shared',2,mute('lead'))]};
 p=addRepeat(p,{start:bar(1),end:bar(5),plays:3,id:'r'},uid);
 const [,b,c3]=p.regions[0].passes.map(x=>x.id);
 p=editPass(p,'r',b,program=>{program.push(cue('mine',3,mute('bass')));},pos,uid);
 p=editPass(p,'r',c3,()=>{},pos,uid);
 const add=cues=>cues.push(cue('new',4,mute('piano')));
 const quiet=editShared(p,add);
 assert.ok(!quiet.regions[0].passes[1].program.some(x=>x.from==='new'));
 const named=editShared(p,add,{regionId:'r',propagateTo:[b],position:pos,uid});
 assert.ok(named.regions[0].passes[1].program.some(x=>x.from==='new'));
 assert.ok(named.regions[0].passes[1].program.some(x=>x.id==='mine'),'its own edits stay');
 assert.ok(!named.regions[0].passes[2].program.some(x=>x.from==='new'));
});

test('an until-released loop plans four plays in all; further passes use the template and are added only when they start', () => {
 let p=addRepeat(song(),{start:bar(1),end:bar(5),plays:'live',id:'r'},uid);
 assert.equal(p.regions[0].passes.length,4);
 const c=compilePerformance(p,G);
 assert.equal(c.requiresLiveControl,true);
 assert.equal(c.segments.filter(s=>s.live).length,4);
 const r=pathSeconds(c.segments);assert.equal(r.music,120+3*8);assert.equal(r.estimated,true);
 p={...p,regions:[{...p.regions[0],further:{entry:[mute('vocals')],program:null}}]};
 const fifth=furtherPass(p,G,'r',4,1);
 assert.equal(fifth.further,true);assert.deepEqual(fifth.actions.map(a=>a.action.track),['vocals']);
 const explicit=setPlays(p,'r','live');assert.equal(explicit.regions[0].passes.length,4);
});

test('the example from the plan: 120 s song, 8 s range, four plays 144 s; exit in pass 2 leaves 128 s', () => {
 const p=addRepeat(song(),{start:bar(10),end:bar(14),plays:'live',id:'r'},uid);
 const segs=compilePerformance(p,G).segments;
 assert.equal(pathSeconds(segs).music,144);
 const exited=segs.filter(s=>!(s.live&&s.passIndex>1));
 assert.equal(pathSeconds(exited).music,128);
});

test('the show example: two 120 s songs, 8 s of loops, a 10 s gap; five minutes left, and a pause only costs the slot', () => {
 const one=compilePerformance(addRepeat(song(),{start:bar(1),end:bar(5),plays:2,id:'r'},uid),G).segments,two=compilePerformance(song(),G).segments;
 const totals=showSeconds([{segments:one},{segments:two,transition:{kind:'gap',seconds:10}}]);
 assert.equal(clockText(totals.music),'4:08');assert.equal(clockText(totals.planned),'4:18');
 const a=timing(totals,{now:1000,deadline:1300});
 assert.equal(a.spare,42);assert.equal(spareText(a.spare),'42s to spare');assert.equal(a.expectedFinish,1258);
 const paused=timing(totals,{now:1020,deadline:1300});
 assert.equal(paused.music,248);assert.equal(paused.spare,22);
 assert.equal(spareText(-38),'38s over');assert.equal(clockText(134),'2:14');
});

test('a speed change counts: half speed doubles the rest, from the exact bar, and carries into the next segment', () => {
 const p={...song(),cues:[cue('slow',31,{type:'rate.set',percent:50})]};
 const segs=compilePerformance(p,G).segments;
 assert.equal(pathSeconds(segs).music,60+120);
 assert.equal(musicSeconds(segs[0]).rate,50);
 assert.equal(pathSeconds(segs,{fixedRate:true}).music,120,'a live speed override means planned changes will not happen');
});

test('irregular bars: real lengths, never four-beat guesses; a beat length that ends inside a bar is refused with lengths that work', () => {
 const odd=grid([4,3,4,2,4,4]);
 const c=compilePerformance(addRepeat(song(),{start:address('m2'),end:address('m3'),plays:2,id:'r'},uid),odd);
 assert.equal(c.ok,true);
 assert.equal(pathSeconds(c.segments).music,(4+3+4+2+4+4)*.5+1.5);
 assert.deepEqual(validBeatLengths(odd.measures,'m1',12),[4,7,11]);
 assert.ok(endForBeats(odd.measures,'m1',6).error.includes('ends inside a bar'));
 assert.deepEqual(endForBeats(odd.measures,'m1',7).end,address('m3'));
 assert.deepEqual(endForBeats(odd.measures,'m6',4).end,{measure:'m6',beat:{n:4,d:1}},'to the very end of the song');
});

test('invalid things are refused with a useful reason', () => {
 const check=(p,code)=>{const c=compilePerformance(p,G);assert.equal(c.ok,false,code);assert.ok(c.errors.some(e=>e.code===code),`${code}: ${JSON.stringify(c.errors)}`);};
 check(addRepeat(song(),{start:bar(5),end:bar(5),plays:2},uid),'range');
 check(addRepeat(song(),{start:bar(5),end:address('m6',2),plays:2},uid),'barline');
 check(addRepeat(addRepeat(song(),{start:bar(1),end:bar(5),plays:2},uid),{start:bar(3),end:bar(7),plays:2},uid),'overlap');
 check({...song(),cues:[cue('a',2,mute('lead')),cue('b',2,mute('lead',false))]},'conflict');
 check({...song(),cues:[cue('a',999,mute('lead'))]},'anchor');
 check({...song(),cues:[cue('a',2,{type:'exec.python',code:'x'})]},'action');
 check({...song(),jumps:[{id:'j',at:bar(9),to:bar(5),times:Infinity}]},'cycle');
 check({...song(),jumps:[{id:'j',at:bar(9),to:bar(1),times:9999999}]},'cycle');
 check({...song(),jumps:[{id:'j',at:address('m9',1),to:bar(5),times:1}]},'barline');
});

test('two actions on the same spot are fine when put in order, or when they touch different things', () => {
 const ordered={...song(),cues:[cue('b',2,mute('lead',false),{order:2}),cue('a',2,mute('lead'),{order:1})]};
 const c=compilePerformance(ordered,G);
 assert.equal(c.ok,true);assert.deepEqual(c.segments[0].actions.map(x=>x.id),['a','b']);
 assert.equal(compilePerformance({...song(),cues:[cue('a',2,mute('lead')),cue('b',2,mute('bass'))]},G).ok,true);
});

test('a finite jump goes back the set number of times, then the song carries on', () => {
 const c=compilePerformance({...song(),jumps:[{id:'j',at:bar(9),to:bar(5),times:2}]},G);
 assert.equal(c.ok,true);assert.equal(pathSeconds(c.segments).music,120+16);
 assert.deepEqual(c.segments.map(s=>[s.start,s.end]).slice(0,3),[[0,f(16)],[f(8),f(16)],[f(8),f(16)]]);
});

test('holds: a timed hold counts, and a wait for a control is an estimate or unknown', () => {
 const timed=pathSeconds(compilePerformance({...song(),holds:[{id:'h',at:bar(5),seconds:6}]},G).segments);
 assert.equal(timed.music,120);assert.equal(timed.holds,6);assert.equal(timed.planned,126);
 const waitC=compilePerformance({...song(),holds:[{id:'h',at:bar(5),seconds:null,expected:30}]},G);
 assert.equal(waitC.requiresLiveControl,true);assert.equal(pathSeconds(waitC.segments).estimated,true);assert.equal(pathSeconds(waitC.segments).planned,150);
 const unknownC=compilePerformance({...song(),holds:[{id:'h',at:bar(5),seconds:null}]},G);
 assert.equal(unknownC.unknownWait,true);assert.equal(pathSeconds(unknownC.segments).unknown,true);
 assert.equal(timing({music:1,planned:1,unknown:true},{now:0,deadline:10}).spare,null);
});

test('state at each segment: the path remembers what was set before it, pass by pass', () => {
 let p=addRepeat(song(),{start:bar(1),end:bar(5),plays:2,id:'r'},uid);
 const [a,b]=p.regions[0].passes.map(x=>x.id);
 p=editPass(p,'r',a,prog=>prog.push(cue('x',2,mute('lead'))),pos,uid);
 p=editPass(p,'r',b,prog=>prog.push(cue('y',2,mute('lead',false))),pos,uid);
 const s=compilePerformance(p,G).segments;
 assert.equal(s[0].state['track.lead.mute'],undefined);
 assert.equal(s[1].state['track.lead.mute'],true);
 assert.equal(s[2].state['track.lead.mute'],false);
});

test('one-shots leave no state, and pass conditions pick where a cue runs', () => {
 let p={...song(),cues:[cue('flash',2,{type:'visual.trigger',input:'flash'},{when:{first:true}})]};
 p=addRepeat(p,{start:bar(1),end:bar(5),plays:2,id:'r'},uid);
 const c=compilePerformance(p,G);
 assert.equal(c.segments[0].actions[0].oneShot,true);
 assert.equal(c.segments[1].state['visual.trigger'],undefined);
 const passB=p.regions[0].passes[1].id;
 const only=compilePerformance({...p,cues:[cue('flash',2,{type:'visual.trigger',input:'flash'},{when:{passes:[passB]}})]},G);
 assert.equal(only.segments[0].actions.length,0);assert.equal(only.segments[1].actions.length,1);
});

test('exit actions land where the region ends and pass state still starts from the plan', () => {
 let p=addRepeat(song(),{start:bar(1),end:bar(5),plays:2,id:'r'},uid);
 p.regions[0].onExit=[mute('drums')];
 const s=compilePerformance(p,G).segments;
 assert.deepEqual(s[2].actions.map(a=>a.action.track),['drums']);assert.equal(s[2].actions[0].frame,f(8));
});

test('a changed grid asks for a look and never moves anything by guessing', () => {
 const p={...song(),grid:gridFingerprint(G.measures),cues:[cue('a',2,mute('lead'))]};
 assert.equal(compilePerformance(p,G).needsReview,false);
 const other=grid(Array(61).fill(4));
 const c=compilePerformance(p,other);
 assert.equal(c.needsReview,true);assert.equal(c.warnings[0].code,'moved');
 const gone=compilePerformance({...p,cues:[cue('a',59,mute('lead'))]},grid([4,4]));
 assert.equal(gone.needsReview,true);assert.equal(gone.ok,false);
});

test('L and R: an authored region names its own key', () => {
 const r=addRepeat(song(),{start:bar(1),end:bar(5),plays:2,family:'section',id:'r'},uid).regions[0];
 assert.equal(loopKey(r),'R');assert.equal(loopKey({family:'bars'}),'L');
});

test('actions: every one in the registry has plain help, and values are checked', () => {
 for(const [type,def] of Object.entries(ACTIONS)){assert.ok(def.label.length>4,type);assert.ok(['state','oneshot'].includes(def.kind),type);}
 assert.equal(checkAction({type:'rate.set',percent:40}),'Speed must be between 50% and 125%.');
 assert.equal(checkAction({type:'constructor'}),'Chord Buddy doesn’t know how to do “constructor”.');
 assert.match(describeAction({type:'track.set',track:'lead',mute:true}),/^Mute Lead guitar/);
 assert.deepEqual(writesOf({type:'track.set',track:'bass',gain:.5,mute:false}).map(w=>w[0]),['track.bass.gain','track.bass.mute']);
 assert.equal(domainOfProperty('track.bass.gain'),'tracks');assert.equal(domainOfProperty('midi.helix.tone'),'midi');
});

test('Helix: human numbers in the editor, wire numbers on the wire, in the documented order', () => {
 const a={type:'midi.helix',device:'helix',channel:1,setlist:2,preset:5,snapshot:3};
 assert.equal(checkAction(a),null);
 assert.deepEqual(ACTIONS['midi.helix'].bytes(a),[[0xB0,32,1],[0xC0,4],[0xB0,69,2]]);
 assert.equal(checkAction({...a,snapshot:9}),'Setlists run 1–8, presets 1A–32D, snapshots 1–8.');
 assert.match(describeAction({type:'midi.helix',device:'helix',channel:1,snapshot:3}),/Helix: Snapshot 3/);
 assert.deepEqual([1,2,4,5,8,9,128].map(helixPresetName),['1A','1B','1D','2A','2D','3A','32D'],'named the way the Helix shows them');
 assert.match(describeAction({type:'midi.helix',device:'helix',channel:1,preset:6}),/Helix: Preset 2B/);
});

test('a state becomes a mixer setting, leaving what it never set', () => {
 const mix=mixFromState({'track.lead.mute':true,'track.bass.gain':.5,master:.8},defaultMix());
 assert.equal(mix.mutes[5],true);assert.equal(mix.gains[0],.5);assert.equal(mix.master,.8);assert.equal(mix.gains[1],1);
});
