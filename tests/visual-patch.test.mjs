import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScene,sampleFrame,withFeatures,STEM_ORDER} from '../chordbuddy/web/visual-scene.js';
import {frameEvents} from '../chordbuddy/web/visualizer-view.js';
import {sourceRange,fitUnit,sourceCatalog,sourceValue,catalogMap,Patcher,readInputs,defaultPatch,choosePatch,cleanPatch,adapterSettings,canConnect,id,idParts,zero}
  from '../chordbuddy/web/visual-patch.js';

// ---- a small song: 4/4 bars of 4 s (a beat a second), a vocal melody, every stem, and one MIDI part of your own ----
const content={duration:16,chords:[{id:'b',label:'C',start:1,end:5},{id:'c',label:'Am',start:5,end:9},{id:'d',label:'F',start:9,end:16}],
  sections:[{id:'s1',name:'Verse',start:1,end:9},{id:'s2',name:'Chorus',start:9,end:16}]};
const bar=start=>({start,end:start+4,beats:[start,start+1,start+2,start+3]});
const music={measures:[bar(1),bar(5),bar(9),bar(13)]};
const b64=bytes=>Buffer.from(Uint8Array.from(bytes)).toString('base64');
function features(frames=1700){
  const track=(level,bright)=>({level:b64(Array(frames).fill(level)),bands:b64(Array(frames*8).fill(level)),brightness:b64(Array(frames).fill(bright)),
    flux:b64(Array(frames).fill(51)),hits:[[2,0.8],[2.5,0.4],[6,1]],peak_db:-6});
  return {fps:100,frames,floor_db:-60,band_edges_hz:[],tracks:Object.fromEntries(['original',...STEM_ORDER].map(r=>[r,track(204,r==='drums'?60:200)]))};
}
const keys={name:'Keys',kind:'notes',signals:[{key:'notes',label:'Notes',type:'notes'},{key:'hits',label:'Note starts',type:'trigger'},
  {key:'cc1',label:'Mod wheel',type:'amount'},{key:'cc64',label:'Sustain pedal',type:'gate'},{key:'bend',label:'Pitch bend',type:'bend'}],
  notes:[{start:3,end:4,pitch:60,velocity:64},{start:3.5,end:5,pitch:72,velocity:127}],
  controls:{cc1:[{time:0,value:0.25},{time:4,value:0.75}],cc64:[{time:3,value:1},{time:5,value:0}],bend:[{time:3,value:-0.5}]}};
const scene=withFeatures(buildScene({content,music,midi:{vocal:[{start:2,end:3,pitch:60},{start:6,end:8,pitch:72}]},extras:[keys]}),features());
const catalog=sourceCatalog(scene),byId=catalogMap(catalog);

// Plays the song from `from` to `to` at 60 frames a second, running the patch; returns each frame's inputs (and the frames).
function play(inputs,patch,{from=0,to=8,fps=60,mix=null}={}){
  const patcher=new Patcher(),out=[];let previous=null;
  for(let t=from;t<=to+1e-9;t+=1/fps){
    const frame=sampleFrame(scene,t,{playing:true,mix}),events=frameEvents(previous,frame,scene);
    out.push({t,frame,events,inputs:patcher.run(inputs,patch,{frame,previous,events,scene,dt:1/fps,catalog:byId})});previous=frame;
  }
  return out;
}

test('the catalog lists the song, every stem, the melodies and your own MIDI part, each with a type', () => {
  const has=(source,type)=>assert.equal(byId.get(source)?.type,type,source);
  has('song/beat','trigger');has('song/playing','gate');has('song/bar-phase','amount');
  for(const role of STEM_ORDER){has(`stem/${role}/hit`,'trigger');has(`stem/${role}/level`,'amount');}
  has('stem/drums/kick','trigger');
  has('melody/lead/notes','notes');has('melody/vocal/on','trigger');has('melody/vocal/held','gate');
  assert.ok(!byId.has('melody/instrumental/notes'),'a melody the song does not have is not offered');
  has('mine/Keys/notes','notes');has('mine/Keys/cc64','gate');has('mine/Keys/bend','bend');has('mine/Keys/held','gate');
  assert.ok(catalog.every(s=>s.label&&s.group&&s.help&&s.short),'every source explains itself and has a short name');
  // the patch bay shows them as a tree: group -> part (a stem, a melody, one of your MIDI parts) -> signals; the song's own have no part
  assert.ok(catalog.filter(s=>s.group==='Song').every(s=>s.part===null));
  assert.deepEqual([...new Set(catalog.filter(s=>s.group==='Stems').map(s=>s.part))].length,STEM_ORDER.length);
  assert.ok(catalog.filter(s=>s.group==='Your MIDI').every(s=>s.part==='Keys'));
  assert.deepEqual(idParts(id('mine','Bass / 2','cc1')),['mine','Bass / 2','cc1'],'part names with slashes survive');
});

test('a default patch passes values through untouched, so an un-patched visual behaves as before', () => {
  const inputs=readInputs({inputs:{kick:{label:'Kick',type:'trigger',default:'stem/drums/hit'},spin:{label:'Spin',type:'amount',default:'stem/drums/level'},
    breathe:{label:'Breathe',type:'trigger',default:'song/beat'},comet:{label:'Comet',type:'notes',default:'melody/lead/notes'}}});
  for(const {frame,events,inputs:v} of play(inputs,defaultPatch(inputs))){
    assert.deepEqual(v.kick,events.hits.drums||[]);
    assert.equal(v.spin,frame.tracks.drums.level);
    assert.deepEqual(v.breathe,events.beat?[events.beat.downbeat?1:0.55]:[]);
    const {all,...now}=v.comet;assert.deepEqual(now,frame.notes.vocal);
    assert.deepEqual(all,scene.midi.vocal.notes,'and the whole melody, for visuals that plan ahead');
  }
});

test('a notes cable carries its whole melody, the same list every frame; a range trims it, and silenced vocals leave it', () => {
  const mix=mutes=>({gains:Array(7).fill(1),mutes:Array.from({length:7},(_,i)=>!!mutes[i]),solos:Array(7).fill(false),master:1});
  const value=(source,t,m=null)=>sourceValue(source,{frame:sampleFrame(scene,t,{mix:m}),events:{hits:{}},scene,held:{}});
  const a=value('melody/vocal/notes',1),b=value('melody/vocal/notes',7);
  assert.equal(a.all,b.all,'the same list: a visual can keep what it planned from it');
  assert.deepEqual(a.all.map(n=>n.pitch),[60,72]);
  assert.equal(value('melody/lead/notes',1).all.length,2);
  assert.deepEqual(value('melody/vocal/notes',2.5,mix({3:true})).all,[],'vocals muted: no notes');
  assert.deepEqual(value('melody/lead/notes',2.5,mix({3:true})).all,[],'the lead melody leaves the vocal notes out (this song has no other melody)');
  assert.equal(value('melody/lead/notes',2.5,mix({3:true})).active.length,0);
  const p=new Patcher(),inputs=readInputs({inputs:{path:{label:'p',type:'notes',default:'melody/vocal/notes'}}}),patch={cables:[{from:'melody/vocal/notes',to:'path',fit:[59,65]}]};
  const run=t=>p.run(inputs,patch,{frame:sampleFrame(scene,t),previous:null,events:{hits:{}},scene,dt:1/60}).path;
  const first=run(1),second=run(2);
  assert.deepEqual(first.all.map(n=>n.pitch),[60],'only the notes inside the range');assert.equal(first.all,second.all,'worked out once');
});

test('beat, bar start, chord and section triggers fire once each, never across a seek', () => {
  const inputs=readInputs({inputs:{b:{label:'b',type:'trigger',default:'song/beat'},d:{label:'d',type:'trigger',default:'song/downbeat'},
    c:{label:'c',type:'trigger',default:'song/chord'},s:{label:'s',type:'trigger',default:'song/section'}}});
  const run=play(inputs,defaultPatch(inputs),{from:0.5,to:9.5}),count=k=>run.filter(r=>r.inputs[k].length).length;
  assert.equal(count('b'),9);assert.equal(count('d'),3);assert.equal(count('c'),3);assert.equal(count('s'),1);
  const patcher=new Patcher(),a=sampleFrame(scene,1.5,{playing:true}),b=sampleFrame(scene,9.5,{playing:true});
  assert.deepEqual(patcher.run(inputs,defaultPatch(inputs),{frame:b,previous:a,events:frameEvents(a,b,scene),scene,dt:1/60,catalog:byId}).b,[]);
});

test('melody note starts and your own part’s hits fire with their strength; held and pitch follow the notes', () => {
  const inputs=readInputs({inputs:{on:{label:'on',type:'trigger',default:'melody/vocal/on'},held:{label:'h',type:'gate',default:'mine/Keys/held'},
    hits:{label:'k',type:'trigger',default:'mine/Keys/hits'},pitch:{label:'p',type:'amount',default:'mine/Keys/pitch'},pedal:{label:'ped',type:'gate',default:'mine/Keys/cc64'}}});
  const run=play(inputs,defaultPatch(inputs),{from:1.5,to:6.5});
  assert.equal(run.filter(r=>r.inputs.on.length).length,2);
  assert.deepEqual(run.filter(r=>r.inputs.hits.length).map(r=>r.inputs.hits[0]).map(v=>Math.round(v*127)),[64,127]);
  const at=t=>run.reduce((best,r)=>Math.abs(r.t-t)<Math.abs(best.t-t)?r:best);
  assert.equal(at(3.2).inputs.held,true);assert.equal(at(5.5).inputs.held,false);
  assert.equal(at(4.2).inputs.pitch,1);assert.equal(at(5.5).inputs.pitch,1,'pitch holds between notes');
  assert.equal(at(3.2).inputs.pedal,true);assert.equal(at(5.5).inputs.pedal,false);
});

test('adapters convert between types instead of refusing (only notes stay with notes)', () => {
  assert.equal(canConnect('notes','amount'),false);assert.equal(canConnect('trigger','notes'),false);assert.equal(canConnect('notes','notes'),true);
  assert.deepEqual(adapterSettings('trigger','amount'),['decay','min','max','invert','smooth']);
  assert.deepEqual(adapterSettings('amount','gate'),['threshold','invert']);
  assert.deepEqual(adapterSettings('trigger','gate'),['hold']);

  // a trigger to an amount: a glow that jumps to the hit's strength and fades
  const glow=readInputs({inputs:{g:{label:'g',type:'amount',default:null}}});
  const fade=play(glow,{cables:[{from:'stem/bass/hit',to:'g',decay:0.25}]},{from:1.9,to:2.45});
  const peak=Math.max(...fade.map(r=>r.inputs.g));assert.ok(Math.abs(peak-0.8)<1e-9,'peak '+peak);
  const last=fade.at(-1).inputs.g;assert.ok(last<0.8*Math.exp(-0.3/0.25)&&last>0,'faded to '+last);

  // a gate to a trigger fires on the way on; an amount to a gate switches at the threshold
  const t=readInputs({inputs:{t:{label:'t',type:'trigger',default:null},on:{label:'o',type:'gate',default:null}}});
  const edges=play(t,{cables:[{from:'mine/Keys/cc64',to:'t'},{from:'song/beat-phase',to:'on',threshold:0.75}]},{from:2.5,to:5.5});
  assert.equal(edges.filter(r=>r.inputs.t.length).length,1);
  const onFraction=edges.filter(r=>r.inputs.on).length/edges.length;assert.ok(Math.abs(onFraction-0.25)<0.04,'on '+onFraction);

  // a bend to an amount maps -1..1 onto 0..1; min, max and invert shape any amount
  const a=readInputs({inputs:{x:{label:'x',type:'amount',default:null},y:{label:'y',type:'amount',default:null}}});
  const shaped=play(a,{cables:[{from:'mine/Keys/bend',to:'x'},{from:'song/playing',to:'y',min:0.2,max:0.6,invert:true}]},{from:3.5,to:3.6});
  assert.equal(shaped[0].inputs.x,0.25);assert.ok(Math.abs(shaped[0].inputs.y-0.2)<1e-9);
});

test('Set from range: a MIDI signal’s real span in the song is measured and stretched to the full scale', () => {
  assert.deepEqual(sourceRange('mine/Keys/cc1',scene),{low:0.25,high:0.75});
  assert.deepEqual(sourceRange('mine/Keys/velocity',scene),{low:64/127,high:1});
  assert.equal(sourceRange('mine/Keys/bend',scene),null,'a bend that never moves has no range');
  assert.equal(sourceRange('stem/bass/level',scene),null,'only MIDI');
  assert.equal(sourceRange('mine/Keys/cc64',scene),null,'not an on/off');
  const a=readInputs({inputs:{x:{label:'x',type:'amount',default:null}}});
  const run=play(a,{cables:[{from:'mine/Keys/cc1',to:'x',fit:[0.25,0.75]}]},{from:3.9,to:4.1});
  assert.equal(run[0].inputs.x,0,'the lowest it goes is the bottom');assert.equal(run.at(-1).inputs.x,1,'the highest it goes is the top');
  assert.deepEqual(cleanPatch({cables:[{from:'a',to:'x',fit:[0.6,0.2]},{from:'b',to:'x',fit:[0.2,0.6]}]}).cables,[{from:'a',to:'x'},{from:'b',to:'x',fit:[0.2,0.6]}]);
});

test('Set from range works on every MIDI signal that is not on/off: notes, pitch, hits, and the model’s melodies', () => {
  assert.equal(fitUnit('mine/Keys/notes','notes'),'note');assert.equal(fitUnit('mine/Keys/pitch','amount'),'note');
  assert.equal(fitUnit('mine/Keys/hits','trigger'),'midi','your velocities read 0-127');assert.equal(fitUnit('mine/Keys/cc1','amount'),'midi');
  assert.equal(fitUnit('mine/Keys/bend','bend'),'level');assert.equal(fitUnit('melody/vocal/on','trigger'),'level','the model’s strengths are measured, not played');
  assert.equal(fitUnit('mine/Keys/cc64','gate'),null);assert.equal(fitUnit('stem/bass/level','amount'),null);
  assert.deepEqual(sourceRange('mine/Keys/notes',scene),{low:60,high:72});
  assert.deepEqual(sourceRange('melody/vocal/pitch',scene),{low:60,high:72});
  assert.deepEqual(sourceRange('mine/Keys/hits',scene),{low:64/127,high:1});

  // a range of notes: only the notes inside pass (a keyboard split), and the range is the melody's bottom and top
  const n=readInputs({inputs:{low:{label:'l',type:'notes',default:null},high:{label:'h',type:'notes',default:null},p:{label:'p',type:'amount',default:null}}});
  const split=play(n,{cables:[{from:'mine/Keys/notes',to:'low',fit:[48,66]},{from:'mine/Keys/notes',to:'high',fit:[67,84]},{from:'mine/Keys/pitch',to:'p',fit:[60,84]}]},{from:3.6,to:3.7});
  const f=split[0].inputs;
  assert.deepEqual(f.low.active.map(x=>x.pitch),[60]);assert.deepEqual(f.high.active.map(x=>x.pitch),[72]);
  assert.deepEqual([f.low.low,f.low.high],[48,66]);
  assert.equal(f.p,0.5,'72 is halfway up 60..84');

  // hits: their strengths stretched from the range to full scale
  const t=readInputs({inputs:{t:{label:'t',type:'trigger',default:null}}});
  const hits=play(t,{cables:[{from:'mine/Keys/hits',to:'t',fit:[64/127,1]}]},{from:2.9,to:3.6}).flatMap(r=>r.inputs.t);
  assert.deepEqual(hits.map(v=>Math.round(v*100)/100),[0,1]);
});

test('outside the range: clip holds a value at the edge, leave out ignores it', () => {
  const t=readInputs({inputs:{clip:{label:'c',type:'trigger',default:null},drop:{label:'d',type:'trigger',default:null},
    lowNotes:{label:'n',type:'notes',default:null},clipped:{label:'k',type:'notes',default:null},a:{label:'a',type:'amount',default:null}}});
  const range=[0.6,1];                                 // velocity 64 (0.50) is below it, 127 inside
  const run=play(t,{cables:[{from:'mine/Keys/hits',to:'clip',fit:range},{from:'mine/Keys/hits',to:'drop',fit:range,outside:'drop'},
    {from:'mine/Keys/notes',to:'lowNotes',fit:[48,66]},{from:'mine/Keys/notes',to:'clipped',fit:[48,66],outside:'clip'},
    {from:'mine/Keys/cc1',to:'a',fit:[0.5,1],outside:'drop'}]},{from:2.9,to:4.2});
  assert.deepEqual(run.flatMap(r=>r.inputs.clip),[0,1],'clipped: the soft hit fires at the bottom');
  assert.deepEqual(run.flatMap(r=>r.inputs.drop),[1],'left out: only the hard hit fires');
  const both=run.find(r=>Math.abs(r.t-3.6)<0.01).inputs;
  assert.deepEqual(both.lowNotes.active.map(n=>n.pitch),[60],'notes leave out by default (a keyboard split)');
  assert.deepEqual(both.clipped.active.map(n=>n.pitch).sort(),[60,66],'clipped: the high note is held at the top');
  assert.equal(run.find(r=>Math.abs(r.t-3.6)<0.01).inputs.a,0,'a level below a left-out range reads as nothing');
  assert.equal(run.at(-1).inputs.a,0.5,'0.75 is halfway up 0.5..1');
  assert.equal(cleanPatch({cables:[{from:'a',to:'x',outside:'sideways'}]}).cables[0].outside,undefined);
});

test('smoothing glides toward a new level instead of jumping', () => {
  const a=readInputs({inputs:{x:{label:'x',type:'amount',default:null}}});
  const run=play(a,{cables:[{from:'mine/Keys/cc1',to:'x',smooth:0.5}]},{from:3.9,to:4.6});
  const after=run.filter(r=>r.t>4.01).map(r=>r.inputs.x);
  assert.ok(after[0]>0.25&&after[0]<0.3,'starts gliding '+after[0]);
  assert.ok(after.every((v,i)=>i===0||v>=after[i-1]),'never steps back');assert.ok(after.at(-1)>0.6&&after.at(-1)<0.75,'nearly there '+after.at(-1));
});

test('several cables into one input combine: triggers merge, gates or, amounts take the largest', () => {
  const inputs=readInputs({inputs:{t:{label:'t',type:'trigger',default:null},g:{label:'g',type:'gate',default:null},a:{label:'a',type:'amount',default:null}}});
  const patch={cables:[{from:'stem/bass/hit',to:'t'},{from:'stem/piano/hit',to:'t'},{from:'mine/Keys/cc64',to:'g'},{from:'song/playing',to:'g'},
    {from:'song/beat-phase',to:'a'},{from:'stem/bass/level',to:'a'}]};
  const run=play(inputs,patch,{from:1.9,to:2.1});
  assert.ok(run.some(r=>r.inputs.t.length===2),'both hits at 2 s');
  assert.ok(run.every(r=>r.inputs.g===true));
  assert.ok(run.every(r=>r.inputs.a===Math.max(r.frame.beat.phase,r.frame.tracks.bass.level)));
});

test('a cable from a source this song does not have leaves the input on its default', () => {
  const inputs=readInputs({inputs:{kick:{label:'Kick',type:'trigger',default:'stem/drums/hit'},glow:{label:'Glow',type:'amount',default:null}}});
  const patch={cables:[{from:'mine/Bass from another song/hits',to:'kick'},{from:'mine/Nope/cc1',to:'glow'}]};
  const run=play(inputs,patch,{from:1.9,to:2.1});
  assert.ok(run.some(r=>r.inputs.kick.length),'the kick still follows the drums');
  assert.ok(run.every(r=>r.inputs.glow===0));
});

test('the patch in use: the song’s own, else the usual one, else the defaults; saved patches are cleaned', () => {
  const inputs=readInputs({inputs:{kick:{label:'Kick',type:'trigger',default:'stem/drums/hit'}}});
  const song={cables:[{from:'stem/bass/hit',to:'kick'}]},usual={cables:[{from:'stem/piano/hit',to:'kick'}]};
  assert.equal(choosePatch(inputs,{song,usual}).cables[0].from,'stem/bass/hit');
  assert.equal(choosePatch(inputs,{usual}).cables[0].from,'stem/piano/hit');
  assert.equal(choosePatch(inputs).cables[0].from,'stem/drums/hit');
  assert.deepEqual(choosePatch(inputs,{usual:{cables:[]}}).cables,[],'everything unplugged on purpose stays unplugged');
  const dirty=cleanPatch({cables:[{from:'song/beat',to:'x',decay:99,invert:'yes',evil:'<script>'},{from:'song/beat',to:'x'},{to:'x'},null,{from:'a'.repeat(400),to:'x'}]});
  assert.deepEqual(dirty,{cables:[{from:'song/beat',to:'x',decay:4,invert:false}]});
  assert.equal(cleanPatch('junk'),null);assert.equal(cleanPatch({cables:'no'}),null);
});

test('only well-formed inputs are read from a visualization', () => {
  const inputs=readInputs({inputs:{good:{label:'Good',type:'amount',default:'song/beat-phase'},'bad key':{type:'amount'},odd:{type:'colour'},none:null}});
  assert.deepEqual(inputs.map(i=>i.key),['good']);
  assert.deepEqual(readInputs({}),[]);assert.deepEqual(zero('notes').active,[]);
});

test('kick drum: drum hits only while the drums sound low and punchy', () => {
  assert.deepEqual(sourceValue('stem/drums/kick',{frame:sampleFrame(scene,2),events:{hits:{drums:[0.8]}},scene,held:{}}),[0.8]);
  const bright=withFeatures(buildScene({content,music}),{...features(),tracks:{...features().tracks,drums:{...features().tracks.vocals}}});
  assert.deepEqual(sourceValue('stem/drums/kick',{frame:sampleFrame(bright,2),events:{hits:{drums:[0.8]}},scene:bright,held:{}}),[]);
});

test('a stem the mixer silences sends nothing, and the vocal melody goes quiet with the vocals; the others carry on', () => {
  const mix=(mutes,solos=[])=>({gains:Array(7).fill(1),mutes:Array.from({length:7},(_,i)=>!!mutes[i]),solos:Array.from({length:7},(_,i)=>!!solos[i]),master:1});
  const value=(source,m)=>sourceValue(source,{frame:sampleFrame(scene,2.5,{mix:m}),events:{hits:{drums:[0.8],vocals:[0.6]}},scene,held:{}});
  const drums=1,vocals=3;                                              // STEM_ORDER: bass, drums, other, vocals, piano, lead, rhythm
  assert.deepEqual(value('stem/drums/hit',mix([])),[0.8]);assert.ok(value('stem/drums/brightness',mix([]))>0);
  assert.deepEqual(value('stem/drums/hit',mix({[drums]:true})),[],'muted: no hits');
  assert.equal(value('stem/drums/brightness',mix({[drums]:true})),0);assert.equal(value('stem/drums/level',mix({[drums]:true})),0);
  assert.deepEqual(value('stem/drums/hit',mix([],{[vocals]:true})),[],'another stem soloed silences it too');
  assert.deepEqual(value('stem/vocals/hit',mix([],{[vocals]:true})),[0.6],'the soloed one carries on');
  assert.equal(value('melody/vocal/held',mix([])),true);
  assert.equal(value('melody/vocal/held',mix({[vocals]:true})),false,'the vocal melody follows the vocals');
  assert.equal(value('melody/vocal/notes',mix({[vocals]:true})).active.length,0);
});

test('an input a visualization gains after a patch was saved starts on its default cable; one unplugged on purpose stays unplugged', () => {
  const inputs=readInputs({inputs:{lasers:{label:'l',type:'trigger',default:'song/beat'},rings:{label:'r',type:'notes',default:'melody/vocal/notes'}}});
  const old={cables:[{from:'song/downbeat',to:'lasers'}]};                         // saved before patches listed their inputs
  assert.deepEqual(choosePatch(inputs,{usual:old}).cables,[{from:'song/downbeat',to:'lasers'},{from:'melody/vocal/notes',to:'rings'}]);
  assert.deepEqual(choosePatch(inputs,{usual:old}).inputs,['lasers','rings']);
  const unplugged={cables:[{from:'song/downbeat',to:'lasers'}],inputs:['lasers','rings']};
  assert.deepEqual(choosePatch(inputs,{usual:unplugged}).cables,unplugged.cables,'it knew rings, so leaving it out was a choice');
  assert.deepEqual(choosePatch(inputs,{usual:{cables:[]}}).cables,[],'everything unplugged stays unplugged');
  assert.deepEqual(choosePatch(inputs,{song:old,usual:unplugged}).cables.map(c=>c.to),['lasers','rings'],'the song’s own patch is the one completed');
  assert.deepEqual(cleanPatch({cables:[],inputs:['ok','../bad',3,'ok']}).inputs,['ok']);
});
