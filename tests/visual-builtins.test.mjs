import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {buildScene,sampleFrame,withFeatures,STEM_ORDER} from '../chordbuddy/web/visual-scene.js';
import {frameEvents} from '../chordbuddy/web/visualizer-view.js';
import {hudZones} from '../chordbuddy/web/visual-hud.js';
import {Patcher,readInputs,choosePatch,sourceCatalog,catalogMap,canConnect} from '../chordbuddy/web/visual-patch.js';

// Every built-in visualization (and the template) drawn for a few seconds of a song, with its inputs fed by the patch bay's engine
// exactly as the visualizer does, on a stand-in canvas that accepts any drawing call. Catches a visualization that breaks on its inputs.
const anything=()=>new Proxy(function(){},{get:(_,key)=>key===Symbol.toPrimitive?()=>0:key==='canvas'?{width:800,height:450}:anything(),apply:()=>anything(),set:()=>true});
const canvas=()=>({width:800,height:450,getContext:()=>anything()});
globalThis.document??={createElement:()=>canvas()};
globalThis.OffscreenCanvas??=class{constructor(w,h){this.width=w;this.height=h;}getContext(){return anything();}};
globalThis.Path2D??=class{constructor(){return anything();}};
globalThis.DOMMatrix??=class{constructor(){return anything();}};

const content={duration:12,chords:[{id:'b',label:'C',start:0,end:4},{id:'c',label:'Am',start:4,end:8},{id:'d',label:'F',start:8,end:12}],
  sections:[{id:'s1',name:'Verse',start:0,end:6},{id:'s2',name:'Chorus',start:6,end:12}]};
const music={measures:[0,2,4,6,8,10].map(s=>({start:s,end:s+2,beats:[s,s+.5,s+1,s+1.5]}))};
const b64=bytes=>Buffer.from(Uint8Array.from(bytes)).toString('base64');
const frames=1300,wave=i=>Math.round(128+100*Math.sin(i/7));
const track=()=>({level:b64(Array.from({length:frames},(_,i)=>wave(i))),bands:b64(Array.from({length:frames*8},(_,i)=>wave(i>>3))),
  brightness:b64(Array(frames).fill(90)),flux:b64(Array(frames).fill(40)),hits:Array.from({length:24},(_,i)=>[i*0.5,0.9]),peak_db:-6});
const extras=[{name:'Pads',kind:'notes',signals:[{key:'notes',label:'Notes',type:'notes'},{key:'hits',label:'Note starts',type:'trigger'},{key:'cc64',label:'Sustain pedal',type:'gate'}],
  notes:[{start:1,end:3,pitch:60,velocity:90}],controls:{cc64:[{time:1,value:1},{time:3,value:0}]}}];
// as an analysis writes them: the vocal melody, and the combined melody (the vocal and the instrumental one together)
const vocal=[{start:1,end:2,pitch:64},{start:5,end:7,pitch:67}];
const scene=withFeatures(buildScene({content,music,midi:{vocal,melody:[...vocal,{start:3,end:4,pitch:55}]},extras}),
  {fps:100,frames,floor_db:-60,band_edges_hz:[],tracks:Object.fromEntries(['original',...STEM_ORDER].map(r=>[r,track()]))});
const catalog=sourceCatalog(scene),byId=catalogMap(catalog);

function run(definition,patch){
  const inputs=readInputs(definition),patcher=new Patcher(),visual=definition.create(),zones=hudZones(800,450,true);
  visual.resize?.(800,450);let previous=null;
  for(let t=0;t<6;t+=1/30){
    const frame=sampleFrame(scene,t,{playing:true}),events=frameEvents(previous,frame,scene);
    const env={w:800,h:450,dt:1/30,wall:t,calm:false,lyrics:true,zones,song:scene,events,status:'',fps:30,inputs:{}};
    if(inputs.length)env.inputs=patcher.run(inputs,patch??choosePatch(inputs),{frame,previous,events,scene,dt:1/30,catalog:byId});
    visual.draw(anything(),frame,env);previous=frame;
  }
  visual.dispose?.();
}

const files=readdirSync(new URL('../chordbuddy/web/visualizations/',import.meta.url)).filter(f=>f.endsWith('.js'));
for(const file of files){
  test(`${file} draws a song with its default patch, and with every input rewired`, async () => {
    const definition=(await import(`../chordbuddy/web/visualizations/${file}`)).default;
    const inputs=readInputs(definition);
    for(const input of inputs){
      assert.ok(input.label&&input.help,`${input.key} says what it does`);
      if(input.default)assert.ok(byId.has(input.default)&&canConnect(byId.get(input.default).type,input.type),`${input.key}: its default ${input.default} is a source of a matching type`);
    }
    run(definition);
    // every input fed from a different source of each kind (through the adapters), so nothing assumes its default's shape
    const others=['stem/bass/hit','mine/Pads/cc64','song/bar-phase','mine/Pads/notes'];
    for(const from of others){
      const cables=inputs.filter(i=>canConnect(byId.get(from).type,i.type)).map(i=>({from,to:i.key}));
      if(cables.length)run(definition,{cables});
    }
    run(definition,{cables:[]});                    // everything unplugged
  });
}
