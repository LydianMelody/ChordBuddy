import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// visual-three.js: the bundled three.js release, the shared view that copies a 3D picture onto the visualizer's canvas, and the Shadertoy
// adapter. No graphics card here: a stand-in renderer records what would be drawn. Real shader compiling is checked in a browser.
const calls=[];
globalThis.document??={createElement:()=>({width:1,height:1,getContext:()=>null})};
const {THREE,createThreeView,shadertoyPass,noiseTexture,disposeScene,setRendererMaker}=await import('../chordbuddy/web/visual-three.js');
setRendererMaker(()=>{const r={};for(const m of ['setPixelRatio','setSize','setViewport','setScissor','setScissorTest','setClearColor','clear','clearDepth','render','setRenderTarget'])r[m]=(...a)=>calls.push([m,...a]);r.extensions={has:()=>true};return r;});

test('the bundled three.js is the pinned release, byte for byte', () => {
  assert.equal(THREE.REVISION,'187');
  const pin=JSON.parse(readFileSync(new URL('../installer-pins.json',import.meta.url))).web_libraries.find(p=>p.name==='three.js');
  for(const [name,file] of Object.entries(pin.files)){
    const bytes=readFileSync(new URL(`../${pin.folder}/${name}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,name);
  }
});

test('the bundled three.js never evaluates code from strings', () => {
  for(const name of ['three.module.js','three.core.js']){
    const source=readFileSync(new URL(`../chordbuddy/web/vendor/three/${name}`,import.meta.url),'utf8');
    assert.ok(!/new Function\s*\(|[^.\w]eval\s*\(/.test(source),name);
  }
});

function canvasTarget(width,height){
  const drawn=[];
  return {drawn,g:{canvas:{width,height},imageSmoothingEnabled:true,drawImage:(...a)=>drawn.push(a),fillRect(){},set fillStyle(v){}}};
}

test('a view renders at the canvas\'s real pixel size and copies the picture into the whole canvas', () => {
  calls.length=0;
  const view=createThreeView(),{g,drawn}=canvasTarget(1600,900),env={w:800,h:450,dt:1/60};
  const size=view.begin(g,env);
  assert.deepEqual([size.width,size.height],[1600,900]);              // a 2x screen: twice the CSS size
  view.render(new THREE.Scene(),new THREE.PerspectiveCamera());view.finish(g,env);
  const [source,sx,sy,sw,sh,dx,dy,dw,dh]=drawn[0];
  assert.deepEqual([sw,sh,dx,dy,dw,dh],[1600,900,0,0,800,450]);
  assert.equal(sy,0);                                                  // the largest size asked for so far: its rows fill the canvas
  assert.ok(calls.some(c=>c[0]==='render'));
  view.dispose();
});

test('when frames keep arriving late the picture gets smaller, never below the floor, and grows back once there is time', () => {
  const view=createThreeView({minScale:0.5}),{g}=canvasTarget(1000,500),env=dt=>({w:1000,h:500,dt});
  for(let i=0;i<60;i++)view.begin(g,env(1/144));                     // a 144 Hz display, on time
  assert.equal(view.scale,1);
  for(let i=0;i<600;i++)view.begin(g,env(i%2?1/144:1/48));           // every other frame missed
  assert.ok(view.scale<1&&view.scale>=0.5,`scale ${view.scale}`);
  const low=view.scale;
  for(let i=0;i<3000;i++)view.begin(g,env(1/144));
  assert.ok(view.scale>low,'climbs back');assert.ok(view.scale<=1);
  // a paused or hidden window (dt at its cap) says nothing about speed
  const steady=createThreeView();for(let i=0;i<300;i++)steady.begin(g,env(0.1));assert.equal(steady.scale,1);
  view.dispose();steady.dispose();
});

test('every view shares one renderer, so reloading a visualization never uses up WebGL contexts', () => {
  const a=createThreeView(),b=createThreeView();
  assert.equal(a.renderer,b.renderer);a.dispose();b.dispose();
});

test('a Shadertoy shader becomes a full-screen pass with Shadertoy\'s inputs and your own uniforms declared', () => {
  const pass=shadertoyPass('void mainImage(out vec4 c,in vec2 p){c=vec4(uGlow*p.x/iResolution.x,0.0,0.0,1.0);}',{uniforms:{uGlow:{value:0.5},uTint:{value:new THREE.Vector3()}}});
  const source=pass.material.fragmentShader;
  for(const line of ['uniform vec3 iResolution;','uniform float iTime;','uniform int iFrame;','uniform sampler2D iChannel0;','uniform float uGlow;','uniform vec3 uTint;'])
    assert.ok(source.includes(line),line);
  assert.ok(/mainImage\(color,gl_FragCoord\.xy\)/.test(source));
  pass.set({time:12.5,dt:1/144,width:640,height:360});
  assert.equal(pass.uniforms.iTime.value,12.5);assert.deepEqual(pass.uniforms.iResolution.value.toArray(),[640,360,1]);
  assert.equal(Math.round(pass.uniforms.iFrameRate.value),144);
  pass.dispose();
});

test('the Shadertoy adapter refuses shaders and names it cannot use', () => {
  assert.throws(()=>shadertoyPass('void main(){}'),/mainImage/);
  assert.throws(()=>shadertoyPass('void mainImage(out vec4 c,in vec2 p){}',{uniforms:{'x;discard':{value:1}}}),/bad uniform name/);
  assert.throws(()=>shadertoyPass('void mainImage(out vec4 c,in vec2 p){}',{uniforms:{u:{value:'text'}}}),/type/);
});

test('noise textures repeat exactly for the same seed', () => {
  const a=noiseTexture(16,{seed:3}),b=noiseTexture(16,{seed:3}),c=noiseTexture(16,{seed:4});
  assert.deepEqual(a.image.data,b.image.data);assert.notDeepEqual(a.image.data,c.image.data);
  const scene=new THREE.Scene();scene.add(new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial({map:a})));
  let disposed=0;a.addEventListener('dispose',()=>disposed++);disposeScene(scene);assert.equal(disposed,1);
});

test('buffers: a pass draws into its buffer, a feedback buffer flips to the new frame and keeps its picture when resized', () => {
  calls.length=0;
  const view=createThreeView(),{g}=canvasTarget(800,450),env={w:800,h:450,dt:1/60};
  view.begin(g,env);
  const plain=view.buffer({mipmaps:true}),fluid=view.buffer({feedback:true,precision:'full'});
  assert.throws(()=>view.renderTo(plain,new THREE.Scene(),new THREE.Camera()),/resize/);   // no size yet
  plain.resize(400,225);fluid.resize(800,450);
  assert.equal(plain.texture.generateMipmaps,true);assert.equal(fluid.precision,'full');
  assert.equal(plain.texture,plain.target.texture);                     // a plain buffer reads what it last drew
  assert.ok(fluid.empty);
  const before=fluid.texture;assert.notEqual(fluid.target.texture,before);   // feedback: draw into one, read the other
  view.renderTo(fluid,new THREE.Scene(),new THREE.Camera());
  assert.notEqual(fluid.texture,before);assert.equal(fluid.target.texture,before);assert.ok(!fluid.empty);
  // after drawing into a buffer, the view's own viewport comes back for the next pass
  const last=calls.filter(c=>c[0]==='setViewport').at(-1);assert.deepEqual(last.slice(1),[0,0,800,450]);
  calls.length=0;fluid.resize(1600,900);
  assert.ok(calls.some(c=>c[0]==='render'),'the old picture is copied into the new size');assert.ok(!fluid.empty);
  calls.length=0;fluid.resize(1600,900);assert.equal(calls.length,0);   // same size: nothing happens
  view.dispose();assert.equal(fluid.texture,null);
});

test('shadertoyPass: Common code, kept alpha and uniform arrays', () => {
  const swirls=[new THREE.Vector4(),new THREE.Vector4()];
  const pass=shadertoyPass('void mainImage(out vec4 c,in vec2 p){c=vec4(f(),0.,0.,.5);}',
    {common:'float f(){return uSwirl[1].x;}',alpha:true,uniforms:{uSwirl:{value:swirls,type:'vec4',count:2}}});
  const source=pass.material.fragmentShader;
  assert.ok(source.includes('uniform vec4 uSwirl[2];'));
  assert.ok(source.indexOf('uniform vec4 uSwirl[2];')<source.indexOf('float f()'));   // declared before Common uses it
  assert.ok(source.indexOf('float f()')<source.indexOf('void mainImage'));
  assert.ok(/cbFragColor=color;/.test(source));
  assert.ok(/cbFragColor=vec4\(color\.rgb,1\.0\)/.test(shadertoyPass('void mainImage(out vec4 c,in vec2 p){}').material.fragmentShader));
  assert.throws(()=>shadertoyPass('void mainImage(out vec4 c,in vec2 p){}',{uniforms:{uA:{value:[1],type:'vec4',count:2}}}),/array uniform/);
  assert.throws(()=>shadertoyPass('void mainImage(out vec4 c,in vec2 p){}',{uniforms:{uA:{value:[1],type:'vec4;x',count:1}}}),/array uniform/);
  pass.dispose();
});

test('maxHeight caps the drawing size and keeps the shape; the copy still fills the whole canvas', () => {
  const view=createThreeView({maxHeight:1080}),{g,drawn}=canvasTarget(2560,1440),env={w:2560,h:1440,dt:1/60};
  const size=view.begin(g,env);
  assert.deepEqual([size.width,size.height],[1920,1080]);
  view.finish(g,env);
  assert.deepEqual(drawn.at(-1).slice(3,9),[1920,1080,0,0,2560,1440]);
  const small=canvasTarget(1280,720),smallSize=view.begin(small.g,{w:1280,h:720,dt:1/60});
  assert.deepEqual([smallSize.width,smallSize.height],[1280,720]);                // smaller windows are untouched
  view.dispose();
});
