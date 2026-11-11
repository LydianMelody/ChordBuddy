import test from 'node:test';
import assert from 'node:assert/strict';
import {fontPlan,readOverlay,safeFontFile,familyName,looksLikeFont,createFontLoader,MAX_BYTES,MAX_FONTS} from '../chordbuddy/web/visual-fonts.js';
import {drawChordHud,drawLyricHud} from '../chordbuddy/web/visual-hud.js';

// ---- which files a visualization may ask for ----
test('a font is a plain file name, never a path, of a font type', () => {
  for(const ok of ['Pixel.ttf','DotGothic16-Regular.ttf','My Font (v2).woff2','a.OTF','a_b-c.woff'])assert.ok(safeFontFile(ok),ok);
  for(const bad of ['fonts/DotGothic16-Regular.ttf','sub/x.ttf','../x.ttf','fonts/../../x.ttf','/abs.ttf','./x.ttf','.hidden.ttf','fonts//x.ttf','x.ttf/','http://evil.example/x.ttf','//evil.example/x.ttf',
    'C:/Windows/Fonts/arial.ttf','C:\\x.ttf','\\\\host\\share\\x.ttf','fonts\\x.ttf','x.ttf?v=1','x.ttf#a','%2e%2e/x.ttf','x%2Fy.ttf','data:font/ttf;base64,AAAA',
    'x.exe','x.js','x.svg','x','.ttf','a/b/c/d/e.ttf','x\u0000.ttf','x\n.ttf','x'.repeat(100)+'.ttf',null,undefined,5,{},['x.ttf']])
    assert.equal(safeFontFile(bad),false,String(bad).slice(0,40));
});

test('the plan keeps good fonts, always looked for in the fonts folder, and names what it leaves out', () => {
  const plan=fontPlan({id:'rose window',fonts:{pixel:{file:'My Font.ttf',weight:700,style:'italic',optional:true},bad:{file:'../x.ttf'},'1x':{file:'a.ttf'},
    plain:{file:'a.woff2'},odd:{file:'b.ttf',optional:'yes'}}},'/my-visuals/');
  assert.deepEqual(plan.fonts.map(f=>f.name),['pixel','plain']);
  assert.equal(plan.fonts[0].url,'/my-visuals/fonts/My%20Font.ttf');assert.equal(plan.fonts[0].optional,true);assert.equal(plan.fonts[1].optional,false);
  assert.equal(plan.fonts[0].weight,700);assert.equal(plan.fonts[0].style,'italic');
  assert.equal(plan.fonts[1].weight,400);assert.equal(plan.fonts[1].style,'normal');
  assert.equal(plan.problems.length,3);
  for(const f of plan.fonts)assert.match(f.url,/^\/my-visuals\/fonts\/[^/]+$/,'only ever one file in the fonts folder');
  assert.equal(fontPlan({id:'x',fonts:{a:{file:'fonts/a.ttf'}}},'/v/').fonts.length,0,'a folder in the name is refused');
  assert.deepEqual(fontPlan({id:'x'},'/my-visuals/'),{fonts:[],problems:[]});
  assert.equal(fontPlan({id:'x',fonts:[1,2]},'/my-visuals/').problems.length,1);
  assert.equal(fontPlan({id:'x',fonts:'x.ttf'},'/my-visuals/').fonts.length,0);
  assert.equal(fontPlan({id:'x',fonts:{a:{file:'a.ttf',weight:'bold'}}},'/v/').fonts.length,0,'weight is a number');
  assert.equal(fontPlan({id:'x',fonts:{a:{file:'a.ttf',style:'oblique'}}},'/v/').fonts.length,0);
  assert.equal(fontPlan({id:'x',fonts:{__proto__:null,a:null}},'/v/').fonts.length,0);
});

test('no more than four fonts are used', () => {
  const fonts=Object.fromEntries(['a','b','c','d','e','f'].map(n=>[n,{file:n+'.ttf'}]));
  const plan=fontPlan({id:'x',fonts},'/v/');
  assert.equal(plan.fonts.length,MAX_FONTS);assert.ok(plan.problems.some(p=>/first 4/.test(p)));
});

test('a font is registered under a private name that no other font or page style can share, whatever the id', () => {
  for(const id of ['rose-window','x y','a"b;c{d}','</style>','Space Mono'])
    assert.match(familyName(id,'pixel'),/^cbv-[A-Za-z0-9_-]+-pixel$/);
  assert.notEqual(familyName('Space','Mono'),'Space Mono');
  const css=fontPlan({id:'a"b\\c',fonts:{p:{file:'p.ttf'}}},'/v/').fonts[0].css;
  assert.equal(css.split(',')[0],'"cbv-a_b_c-p"','an id full of quotes and slashes becomes plain letters inside one quoted name');
});

test('only bytes that begin like a font are accepted', () => {
  const pad=(...head)=>Uint8Array.from([...head,...Array(16).fill(0)]);
  assert.ok(looksLikeFont(pad(0x77,0x4F,0x46,0x32)));          // wOF2
  assert.ok(looksLikeFont(pad(0x77,0x4F,0x46,0x46)));          // wOFF
  assert.ok(looksLikeFont(pad(0,1,0,0)));                      // TrueType
  assert.ok(looksLikeFont(pad(0x4F,0x54,0x54,0x4F)));          // OTTO
  for(const bad of [Uint8Array.from(Buffer.from('<!doctype html><title>x</title>')),Uint8Array.from(Buffer.from('MZ'+'\u0000'.repeat(20))),Uint8Array.from(Buffer.from('export default {}; // js')),new Uint8Array(4),null])
    assert.equal(looksLikeFont(bad),false);
});

// ---- the overlay's style ----
test('the overlay can name its own fonts or a bundled one, and anything else is ignored', () => {
  const own={pixel:'"cbv-x-pixel",system-ui'};
  assert.equal(readOverlay({},own).style,null);
  assert.equal(readOverlay({overlay:{font:'pixel',weight:400,step:16}},own).style.family,'"cbv-x-pixel",system-ui');
  assert.match(readOverlay({overlay:{font:'mono'}},own).style.family,/Space Mono/);
  const odd=readOverlay({overlay:{font:'Arial; color:red',weight:'bold',step:2}},own);
  assert.equal(odd.problems.length,3);assert.equal(odd.style.weight,null);assert.equal(odd.style.step,0);assert.match(odd.style.family,/system-ui/);
  assert.equal(readOverlay({overlay:{font:'__proto__'}},own).problems.length,1);
  assert.equal(readOverlay({overlay:{font:'constructor'}},own).problems.length,1);
  assert.equal(readOverlay({overlay:[1]},own).style,null);
  assert.equal(readOverlay({overlay:{step:64}},own).style.step,64);assert.equal(readOverlay({overlay:{step:65}},own).style.step,0);
});

// ---- the loader, with a fake browser ----
const woff2=(n=64)=>{const b=new Uint8Array(n);b.set([0x77,0x4F,0x46,0x32]);return b.buffer;};
function lab({files={},limit}={}){
  const calls=[],added=[],removed=[],warnings=[];
  class FontFace{constructor(family,buffer,options){Object.assign(this,{family,buffer,options});}async load(){this.loaded=true;}}
  const fetchFn=async(url,options)=>{
    calls.push({url,options});
    const file=files[url];
    if(file===undefined)return {ok:false,status:404};
    return {ok:true,status:200,headers:{get:()=>limit??null},arrayBuffer:async()=>file};
  };
  const set={add:f=>added.push(f),delete:f=>removed.push(f)};
  return {calls,added,removed,warnings,loader:createFontLoader({fetchFn,FontFaceCtor:FontFace,set,warn:t=>warnings.push(t)})};
}
const settle=()=>new Promise(r=>setTimeout(r,5));

test('a declared font is fetched from its own folder only, registered privately, and reported ready', async () => {
  const t=lab({files:{'/my-visuals/fonts/Pixel.woff2':woff2()}});
  const def={id:'rose-window',name:'Rose Window',mine:true,fonts:{pixel:{file:'Pixel.woff2'}},overlay:{font:'pixel',step:16}};
  const used=t.loader.use(def);
  assert.equal(used.ready,false);assert.equal(used.waiting,true);
  assert.equal(used.families.pixel,'"cbv-rose-window-pixel",system-ui,"Segoe UI",sans-serif');
  await settle();
  assert.equal(used.ready,true);assert.equal(used.waiting,false);
  assert.deepEqual(used.loaded,{pixel:true},'the look can tell its own font from the fallback');
  assert.equal(used.loaded,used.loaded,'the same object until something changes');
  assert.deepEqual(t.calls.map(c=>c.url),['/my-visuals/fonts/Pixel.woff2']);
  assert.equal(t.calls[0].options.credentials,'same-origin');
  assert.equal(t.added.length,1);assert.equal(t.added[0].family,'cbv-rose-window-pixel');assert.equal(t.added[0].options.weight,'400');
  assert.equal(used.style.step,16);
  assert.equal(t.loader.use(def),used,'asked once per copy of the visualization');assert.equal(t.calls.length,1);
  assert.deepEqual(t.warnings,[]);
});

test('a built-in visualization reads its fonts from the built-in folder', async () => {
  const t=lab({files:{'/visualizations/fonts/f.ttf':woff2()}});
  t.loader.use({id:'a',name:'A',fonts:{f:{file:'f.ttf'}}});await settle();
  assert.equal(t.added.length,1);
});

test('a missing, wrong, oversized or non-font file is refused with a note, and the scene still has its fallback', async () => {
  const html=new TextEncoder().encode('<!doctype html><title>not a font</title>').buffer;
  const cases={missing:{files:{}},html:{files:{'/my-visuals/fonts/a.ttf':html}},big:{files:{'/my-visuals/fonts/a.ttf':woff2(MAX_BYTES+1)}},declared:{files:{'/my-visuals/fonts/a.ttf':woff2()},limit:String(MAX_BYTES+1)}};
  for(const [name,spec] of Object.entries(cases)){
    const t=lab(spec),used=t.loader.use({id:'x',name:'X',mine:true,fonts:{f:{file:'a.ttf'}},overlay:{font:'f'}});await settle();
    assert.equal(used.ready,true,name);assert.equal(used.waiting,false,name);assert.equal(t.added.length,0,name);
    assert.equal(t.warnings.length,1,name);assert.match(t.warnings[0],/fallback/,name);
    assert.match(used.families.f,/system-ui/,'a fallback is always in the list');
  }
});

test('an optional font that is not in the folder is skipped quietly, a required one is reported', async () => {
  const t=lab({files:{}});
  const quiet=t.loader.use({id:'x',name:'X',mine:true,fonts:{f:{file:'Pixel.ttf',optional:true}},overlay:{font:'f'}});
  const loud=t.loader.use({id:'y',name:'Y',mine:true,fonts:{f:{file:'Pixel.ttf'}}});await settle();
  assert.equal(quiet.ready,true);assert.equal(quiet.waiting,false);assert.match(quiet.families.f,/system-ui/,'the fallback is still named');
  assert.deepEqual(quiet.loaded,{},'a font that is not there is not reported as loaded');
  assert.equal(loud.ready,true);
  assert.equal(t.warnings.length,1);assert.match(t.warnings[0],/"Y"/);assert.match(t.warnings[0],/fonts folder/);
  const broken=lab({files:{'/my-visuals/fonts/Pixel.ttf':new TextEncoder().encode('<!doctype html><title>x</title>').buffer}});
  broken.loader.use({id:'z',name:'Z',mine:true,fonts:{f:{file:'Pixel.ttf',optional:true}}});await settle();
  assert.equal(broken.warnings.length,1,'optional only forgives a missing file, never a file that is not a font');
});

test('an unsafe path never reaches the network, and a browser without font loading just falls back', async () => {
  const t=lab();
  t.loader.use({id:'x',name:'X',mine:true,fonts:{a:{file:'../secret.ttf'},b:{file:'http://evil.example/a.ttf'},c:{file:'C:/x.ttf'},d:{file:'sub/x.ttf'}}});await settle();
  assert.equal(t.calls.length,0);assert.equal(t.warnings.length,4);
  const w=[];
  const none=createFontLoader({fetchFn:async()=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>woff2()}),FontFaceCtor:undefined,set:undefined,warn:t2=>w.push(t2)});
  const used=none.use({id:'x',name:'X',mine:true,fonts:{a:{file:'a.ttf'}}});await settle();
  assert.equal(used.ready,true);assert.equal(w.length,1);
});

test('an edited copy of a visualization replaces the font its earlier copy registered', async () => {
  const t=lab({files:{'/my-visuals/fonts/a.woff2':woff2()}});
  t.loader.use({id:'x',name:'X',mine:true,fonts:{f:{file:'a.woff2'}}});await settle();
  t.loader.use({id:'x',name:'X',mine:true,version:'2',fonts:{f:{file:'a.woff2'}}});await settle();
  assert.equal(t.added.length,2);assert.equal(t.removed.length,1);assert.equal(t.removed[0],t.added[0]);
});

// ---- the overlay drawn in a bitmap font ----
function fakeCanvas(){
  const log=[],ctx={font:'',fillStyle:'',strokeStyle:'',lineWidth:1,textAlign:'left',textBaseline:'alphabetic',lineJoin:'',miterLimit:10,
    save(){},restore(){},fillRect(){},strokeRect(){},beginPath(){},arc(){},stroke(){},
    createLinearGradient:()=>({addColorStop(){}}),
    measureText(text){const px=parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);return {width:String(text).length*px*0.5};},
    fillText(text,x,y){log.push({kind:'fill',text,x,y,font:this.font});},
    strokeText(text,x,y){log.push({kind:'stroke',text,x,y,font:this.font,width:this.lineWidth,join:this.lineJoin});}};
  return {ctx,log};
}
const chordFrame={time:5,chord:{label:'B/D#',start:4,next:{label:'A',start:8},timeToNext:3,upcoming:[{label:'A'},{label:'B'},{label:'C#m'}]},
  cue:{text:'pick scratch'},lyric:{line:{text:'x',end:9},next:{text:'Kare wa mukuchi',in:2},words:[{text:'Kare',state:'sung'},{text:'wa',state:'now'},{text:'muku-',state:'ahead'},{text:'chi',state:'ahead'}]}};
const sizesOf=log=>[...new Set(log.map(e=>parseFloat(/(\d+(?:\.\d+)?)px/.exec(e.font)[1])))];

test('the usual overlay is unchanged: system font, soft halo, free sizes', () => {
  const {ctx,log}=fakeCanvas();
  drawChordHud(ctx,chordFrame,1280,720,{});drawLyricHud(ctx,chordFrame,1280,720);
  assert.ok(log.every(e=>/system-ui/.test(e.font)));
  assert.ok(sizesOf(log).some(s=>s%16!==0),'sizes follow the window');
});

test('with a bitmap font the overlay uses whole multiples of its size, whole pixels and a hard outline', () => {
  for(const [w,h] of [[1280,720],[800,450],[1920,1080],[640,360],[1081,607]]){
    const {ctx,log}=fakeCanvas(),style={family:'"cbv-x-pixel",system-ui',weight:400,step:16};
    drawChordHud(ctx,chordFrame,w,h,{style});drawLyricHud(ctx,chordFrame,w,h,{style});
    assert.ok(log.length>6,'it drew');
    for(const e of log){
      assert.match(e.font,/^400 \d+px "cbv-x-pixel"/,'the chosen font and weight');
      assert.equal(parseFloat(/(\d+)px/.exec(e.font)[1])%16,0,`${w}x${h}: ${e.font}`);
      assert.ok(Number.isInteger(e.x)&&Number.isInteger(e.y),`${w}x${h}: ${e.text} at ${e.x},${e.y}`);
    }
    const outlines=log.filter(e=>e.kind==='stroke');
    assert.ok(outlines.length&&outlines.every(e=>e.join==='miter'),'the outline is hard');
    for(const e of outlines)assert.equal(e.width%2,0,'one whole font pixel on each side');
  }
});

test('a long line shrinks in whole steps or wraps rather than running off the screen, and never goes below the font\'s own size', () => {
  const words=Array.from({length:14},(_,i)=>({text:'word'+i,state:'ahead'}));
  const {ctx,log}=fakeCanvas();
  drawLyricHud(ctx,{...chordFrame,lyric:{...chordFrame.lyric,words}},640,360,{style:{family:'p',weight:400,step:16}});
  assert.ok(sizesOf(log).every(s=>s>=16&&s%16===0));
});
