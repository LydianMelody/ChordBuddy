import test from 'node:test';import assert from 'node:assert/strict';
import {buildPlacementTargets,addressAtSeconds,secondsAtAddress,musicalPosition,secondsAtMusicalPosition,hitPlacementTarget} from '../chordbuddy/web/musical-grid.js';
const bar=(meter=[4,4],n=1)=>{const q=meter[0]*4/meter[1],beats=Array.from({length:Math.ceil(q)},(_,i)=>i);return {id:'m'+n,number:n,start:0,end:q,beats,meter,quarter_positions:[...beats,q]};};
for(const [meter,count] of [[[4,4],8],[[3,4],6],[[6,8],6],[[3,8],3],[[2,2],8]])test(meter+' uses note duration instead of interval count',()=>{
 const m=bar(meter),r=buildPlacementTargets([m],{snap:'eighth'});assert.equal(r.targets.length,count);
 for(const t of r.targets)assert.equal(secondsAtAddress([m],addressAtSeconds([m],t.seconds)),t.seconds);
});
test('half-quarter detections and nonuniform times keep meter-aware targets',()=>{
 const m={...bar([6,8]),beats:[0,.2,.7,1,1.6,2],end:2.5,quarter_positions:[0,.5,1,1.5,2,2.5,3]};
 const r=buildPlacementTargets([m],{snap:'eighth'});assert.equal(r.targets.length,6);assert.equal(r.targets[2].seconds,.7);
 assert.equal(musicalPosition([m],.7).beat,3);assert.equal(secondsAtMusicalPosition([m],1,3),.7);
});
test('all six snaps retain exact off-grid anchors without editing data',()=>{
 const m=bar(),anchors=[{measure_id:m.id,beat:1+1/3}],before=JSON.stringify(anchors);
 for(const snap of ['whole','half','quarter','eighth','sixteenth','thirty-second']){
  const r=buildPlacementTargets([m],{snap,anchors,onsets:[1.17]});assert.ok(r.targets.some(t=>t.address.beat===1+1/3));assert.ok(r.targets.some(t=>t.seconds===1.17));assert.equal(JSON.stringify(anchors),before);
 }
});
test('unknown grid does not invent a tempo; exact known anchors remain usable',()=>{
 const m=bar();delete m.quarter_positions;const r=buildPlacementTargets([m],{snap:'eighth',anchors:[{measure_id:m.id,beat:1/3}]});
 assert.equal(r.targets.length,1);assert.match(r.reason,/unavailable/i);
});
test('a next-bar boundary belongs to the next bar, and click/drag share nonoverlapping geometry',()=>{
 const a=bar(),b={...bar([3,4],2),start:4,end:7,beats:[4,5,6]};assert.deepEqual(addressAtSeconds([a,b],4),{measure_id:'m2',beat:0});
 const targets=buildPlacementTargets([a],{snap:'eighth'}).targets,geometry=targets.map((t,i)=>({id:t.id,x:i*32,y:0,width:30,height:40}));
 for(let i=0;i<targets.length;i++)assert.equal(hitPlacementTarget(targets,geometry,{x:i*32+5,y:8}).id,targets[i].id);
 assert.equal(hitPlacementTarget(targets,[{...geometry[0],width:40},{...geometry[1],x:20}],{x:25,y:8}),null);
});
