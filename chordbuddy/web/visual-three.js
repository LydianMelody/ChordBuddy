// three.js for visualizations: 3D scenes and Shadertoy-style shaders, drawn into the visualizer's ordinary canvas so the shared chord and
// lyric overlay (visual-hud.js) still goes on top and nothing about the visualizer changes. A visualization imports it like any helper:
//   import {THREE,createThreeView,shadertoyPass,noiseTexture,disposeScene} from '../visual-three.js';
//
// Why it is safe: three.js 0.187.0 is bundled (vendor/three, the official npm release, its files' SHA-256 pinned in installer-pins.json
// and checked by the installer and the tests), so nothing is fetched from the internet. It needs no change to the page's security policy:
// it uses no eval, and its loaders could only reach this app's own server anyway (connect-src and img-src are 'self'). Shaders run on the
// graphics card inside the browser's own WebGL sandbox. A visualization still cannot do anything an ordinary visualization file cannot.
//
// Why it is fast: every three.js visualization in a page shares ONE WebGL renderer (a page only gets a handful of WebGL contexts, and a
// visualization that is edited and reloaded must not leak one). Its canvas only ever grows; each frame renders into its lower-left corner
// at the size needed and copies that onto the visualizer's canvas (a GPU-to-GPU copy). Resolution follows the frame rate: when frames
// start arriving late (the display's refresh rate cannot be kept) the picture is drawn at a lower resolution and upscaled, down to half,
// and it climbs back once there is time to spare. So a scene keeps the display's full rate (144 Hz on a 144 Hz monitor) on slower cards.
//
//   const view=createThreeView({scale:1, minScale:0.5});   // in create(); scale < 1 (with pixelated:true) for a deliberately low-resolution look;
//                                                           // maxHeight:1080 draws a heavy scene at most 1080 pixels tall and upscales it
//   draw(g,frame,env){
//     const {width,height,aspect}=view.begin(g,env);       // this frame's size in device pixels; also clears to black
//     camera.aspect=aspect;camera.updateProjectionMatrix();
//     view.render(scene,camera);                            // as many passes as you like (view.clearDepth() between layers)
//     view.finish(g,env);                                   // copies the picture onto the visualizer's canvas
//   }
//   dispose(){view.dispose();disposeScene(scene);}
//
// Shadertoy: shadertoyPass(source) takes a shader written for shadertoy.com's Image tab (a mainImage(out vec4, in vec2) function, using
// iResolution, iTime, iTimeDelta, iFrame, iFrameRate, iMouse, iDate, iChannel0-3) and makes a full-screen pass of it:
//   const sky=shadertoyPass(SOURCE,{uniforms:{uGlow:{value:0}}, channels:[noiseTexture(256)]});
//   sky.set({time:frame.time, dt:env.dt, width, height});  view.render(sky.scene,sky.camera);
// Your own uniforms are declared for you from `uniforms` (float, vec2-4, color as vec3, int as float unless {type:'int'}; an array as
// {value:[...], type:'vec4', count:10}). `common` is put before the source, like Shadertoy's Common tab.
// Multi-pass shaders (Shadertoy's Buffer A-D tabs): view.buffer() makes an off-screen picture at the size you give it, and
// view.renderTo(buffer, pass.scene, pass.camera) draws a pass into it; give buffer.texture to the next pass as a channel. A pass that
// reads its own last frame (a feedback buffer) gets {feedback:true}: read buffer.texture, draw, and it flips to the new frame by itself.
// {mipmaps:true} for a channel read with textureLod at a level above 0, {precision:'full'} for one that accumulates tiny changes, and
// {alpha:true} on the pass for a buffer that keeps data in its alpha channel. Diamond Dust Mk II shows all of it.
// Only shaders whose license allows reuse may be adapted: keep the author's credit and link at the top of the file, exactly as they ask,
// and never use one marked "you cannot host, display, distribute or share" or similar. Shadertoy's own sample textures belong to their
// owners: use noiseTexture() or draw your own instead of copying them.
import * as THREE from './vendor/three/three.module.js';
export {THREE};

const MAX_SIDE=4096;                // never larger than this (the visualizer's own canvas is capped at 2560x1440 worth of pixels)

let shared=null;                    // {renderer, canvas, width, height, lost, users}
let makeRenderer=canvas=>new THREE.WebGLRenderer({canvas,antialias:false,alpha:false,depth:true,stencil:false,powerPreference:'high-performance',
  preserveDrawingBuffer:false,premultipliedAlpha:true});
/** For tests without a graphics card: make(canvas) returns a stand-in with WebGLRenderer's methods. Starts a fresh shared renderer. */
export function setRendererMaker(make){makeRenderer=make;shared=null;}
function sharedRenderer(){
  if(shared)return shared;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  let renderer;
  try{
    renderer=makeRenderer(canvas);
  }catch(error){
    throw Error('This visualization needs WebGL (3D graphics), and this browser could not start it. Turning on hardware acceleration in the browser\'s settings, or updating the graphics driver, usually fixes it.');
  }
  renderer.setPixelRatio(1);renderer.autoClear=false;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  const state={renderer,canvas,width:1,height:1,lost:false,users:0};
  canvas.addEventListener?.('webglcontextlost',event=>{event.preventDefault();state.lost=true;});   // the driver reset: wait for it to come back
  canvas.addEventListener?.('webglcontextrestored',()=>{state.lost=false;});                     // three.js rebuilds its own state
  shared=state;return state;
}

/** A three.js view for one visualization: begin(g, env) -> {width, height, aspect}; render(scene, camera); clearDepth(); finish(g, env). */
export function createThreeView({scale=1,minScale=0.5,adaptive=true,pixelated=false,maxHeight=Infinity}={}){
  const gl=sharedRenderer();gl.users++;
  const maxScale=Math.max(0.05,Math.min(1,scale));let floor=Math.min(maxScale,Math.max(0.05,minScale));
  let quality=maxScale,width=1,height=1,disposed=false;
  // frame pacing: the shortest gap seen lately is the display's refresh interval; a frame much later than that was missed
  let interval=Infinity,late=0,counted=0,goodWindows=0;
  const buffers=new Set();
  function restore(){const r=gl.renderer;r.setRenderTarget(null);r.setViewport(0,0,width,height);r.setScissor(0,0,width,height);r.setScissorTest(true);}
  function pace(dt){
    if(!adaptive||!(dt>0)||dt>=0.1)return;                       // a paused or hidden window says nothing about speed
    interval=Math.min(interval*1.002,dt);counted++;if(dt>interval*1.6)late++;
    if(counted<30)return;
    if(late>6){quality=Math.max(floor,quality*0.85);goodWindows=0;}
    else if(late===0&&++goodWindows>=4&&quality<maxScale){quality=Math.min(maxScale,quality*1.06);goodWindows=0;}
    late=0;counted=0;
  }
  return {
    get scale(){return quality;},
    get lost(){return gl.lost;},
    renderer:gl.renderer,
    begin(g,env){
      if(disposed)throw Error('This three.js view was disposed.');
      pace(env.dt);
      // the visualizer's canvas is env.w x env.h CSS pixels at some device ratio: render at that many pixels times the quality
      let ratio=(g?.canvas?.width||env.w)/Math.max(1,env.w);
      // maxHeight: never draw taller than this many pixels at full quality (a heavy scene holds the frame rate on big screens), upscaled
      if(env.h*ratio>maxHeight)ratio=maxHeight/Math.max(1,env.h);
      width=Math.max(1,Math.min(MAX_SIDE,Math.round(env.w*ratio*quality)));height=Math.max(1,Math.min(MAX_SIDE,Math.round(env.h*ratio*quality)));
      if(width>gl.width||height>gl.height){gl.width=Math.max(gl.width,width);gl.height=Math.max(gl.height,height);gl.renderer.setSize(gl.width,gl.height,false);}
      const r=gl.renderer;r.setViewport(0,0,width,height);r.setScissor(0,0,width,height);r.setScissorTest(true);
      r.setClearColor(0x000000,1);r.clear(true,true,false);
      return {width,height,aspect:width/height,scale:quality};
    },
    render(scene,camera){if(!gl.lost)gl.renderer.render(scene,camera);},
    clearDepth(){gl.renderer.clearDepth();},
    finish(g,env){
      if(gl.lost){g.fillStyle='#000';g.fillRect(0,0,env.w,env.h);return;}
      // WebGL's rows start at the bottom, so the picture sits in the canvas's lower-left corner
      const smooth=g.imageSmoothingEnabled;g.imageSmoothingEnabled=!pixelated;
      g.drawImage(gl.canvas,0,gl.height-height,width,height,0,0,env.w,env.h);
      g.imageSmoothingEnabled=smooth;
    },
    /** Hold a deliberately low resolution: no adaptive scaling above `value` (0.05-1). */
    setFloor(value){floor=Math.min(maxScale,Math.max(0.05,value));quality=Math.max(quality,floor);},
    /** An off-screen picture for a multi-pass shader (see the top of this file). */
    buffer(options={}){const b=makeBuffer(gl,options,restore);buffers.add(b);b.onDispose=()=>buffers.delete(b);return b;},
    /** Draw a scene into a buffer from buffer(), then carry on drawing this frame's picture. */
    renderTo(buffer,scene,camera){
      if(gl.lost)return;
      if(!buffer?.target)throw Error('renderTo needs a buffer made by view.buffer() and sized with buffer.resize(width, height).');
      gl.renderer.setRenderTarget(buffer.target);gl.renderer.render(scene,camera);restore();buffer.drawn();
    },
    dispose(){if(disposed)return;disposed=true;gl.users--;for(const b of [...buffers])b.dispose();},
  };
}

// off-screen pictures: half precision floats unless asked for full; a feedback buffer is two pictures that take turns
let copyPass=null;
function makeBuffer(gl,{precision='half',mipmaps=false,feedback=false,smooth=true}={},restore){
  const r=gl.renderer,has=name=>r.extensions?.has?.(name)??true;
  if(!has('EXT_color_buffer_float'))throw Error('This visualization needs floating-point drawing (WebGL 2 with EXT_color_buffer_float), which this graphics driver does not offer. Updating the graphics driver usually fixes it.');
  // full floats can only be smoothed when the card allows it; half floats always can
  const type=precision==='full'&&has('OES_texture_float_linear')?THREE.FloatType:THREE.HalfFloatType;
  const filter=smooth?THREE.LinearFilter:THREE.NearestFilter;
  const make=(w,h)=>new THREE.WebGLRenderTarget(w,h,{type,format:THREE.RGBAFormat,depthBuffer:false,stencilBuffer:false,generateMipmaps:mipmaps,
    magFilter:filter,minFilter:mipmaps?(smooth?THREE.LinearMipmapLinearFilter:THREE.NearestMipmapNearestFilter):filter,colorSpace:THREE.NoColorSpace});
  let targets=[],written=0,width=0,height=0,drawnOnce=false,disposed=false;
  const buffer={
    precision:type===THREE.FloatType?'full':'half',
    get width(){return width;},get height(){return height;},
    /** What was drawn last (for a feedback buffer, before this frame's draw: its last frame). */
    get texture(){return targets[written]?.texture??null;},
    get target(){return targets[feedback?1-written:0]??null;},
    /** Set the size in pixels; does nothing when it is unchanged. A feedback buffer keeps its picture, stretched to the new size. */
    resize(w,h){
      w=Math.max(1,Math.min(MAX_SIDE,Math.round(w)));h=Math.max(1,Math.min(MAX_SIDE,Math.round(h)));
      if(disposed||(w===width&&h===height))return;
      const old=targets;targets=feedback?[make(w,h),make(w,h)]:[make(w,h)];
      if(feedback&&drawnOnce&&old[written]&&!gl.lost){copyInto(r,old[written].texture,targets[0]);restore();}
      else drawnOnce=false;
      written=0;width=w;height=h;for(const t of old)t.dispose();
    },
    /** True until the buffer has a picture (also after a size change of a buffer without feedback). */
    get empty(){return !drawnOnce;},
    drawn(){drawnOnce=true;if(feedback)written=1-written;},
    dispose(){if(disposed)return;disposed=true;for(const t of targets)t.dispose();targets=[];buffer.onDispose?.();},
  };
  return buffer;
}
function copyInto(renderer,texture,target){
  if(!copyPass){
    const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,uniforms:{uFrom:{value:null}},depthTest:false,depthWrite:false,
      vertexShader:'in vec3 position;out vec2 vUv;void main(){vUv=position.xy*0.5+0.5;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:'precision highp float;uniform sampler2D uFrom;in vec2 vUv;out vec4 color;void main(){color=texture(uFrom,vUv);}'});
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);mesh.frustumCulled=false;
    const scene=new THREE.Scene();scene.add(mesh);copyPass={scene,camera:new THREE.OrthographicCamera(-1,1,1,-1,0,1),material};
  }
  copyPass.material.uniforms.uFrom.value=texture;
  renderer.setRenderTarget(target);renderer.render(copyPass.scene,copyPass.camera);copyPass.material.uniforms.uFrom.value=null;
}

/** Free a scene's geometries, materials and textures (call in dispose(); the shared renderer itself stays for the next visualization). */
export function disposeScene(root){
  const textures=new Set();
  root?.traverse?.(object=>{
    object.geometry?.dispose?.();
    for(const material of [object.material].flat().filter(Boolean)){
      for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
      for(const u of Object.values(material.uniforms||{}))if(u?.value?.isTexture)textures.add(u.value);
      material.dispose?.();
    }
  });
  for(const t of textures)t.dispose();
}

/** A repeating random texture (RGBA, each channel independent), the same every time for the same seed: for shaders that read noise from iChannel. */
export function noiseTexture(size=256,{seed=1,smooth=true}={}){
  const data=new Uint8Array(size*size*4);let s=seed>>>0||1;
  for(let i=0;i<data.length;i++){s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;data[i]=s&255;}
  const texture=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.magFilter=texture.minFilter=smooth?THREE.LinearFilter:THREE.NearestFilter;
  texture.needsUpdate=true;return texture;
}

function glslType(u){
  const v=u.value;
  if(u.type)return u.type;
  if(typeof v==='number'||typeof v==='boolean')return 'float';
  if(v?.isVector2)return 'vec2';if(v?.isVector3||v?.isColor)return 'vec3';if(v?.isVector4)return 'vec4';
  if(v?.isMatrix3)return 'mat3';if(v?.isMatrix4)return 'mat4';if(v?.isTexture)return 'sampler2D';
  throw Error('shadertoyPass: cannot tell the type of a uniform; give it a type, e.g. {value:..., type:"float"}');
}
const IDENT=/^[A-Za-z_][A-Za-z0-9_]*$/;

/** A full-screen pass of a Shadertoy "Image" shader: {scene, camera, material, uniforms, set({time, dt, width, height, mouse})}. */
export function shadertoyPass(source,{uniforms={},channels=[],defines={},common='',alpha=false}={}){
  if(typeof source!=='string'||!/void\s+mainImage\s*\(/.test(source))throw Error('shadertoyPass: the shader needs a mainImage(out vec4 fragColor, in vec2 fragCoord) function.');
  const blank=noiseTexture(1,{seed:7});
  const own={};
  for(const [name,u] of Object.entries(uniforms)){if(!IDENT.test(name))throw Error('shadertoyPass: bad uniform name '+name);own[name]=u;}
  const all={
    iResolution:{value:new THREE.Vector3(1,1,1)},iTime:{value:0},iTimeDelta:{value:1/60},iFrameRate:{value:60},iFrame:{value:0},
    iMouse:{value:new THREE.Vector4()},iDate:{value:new THREE.Vector4()},
    iChannelTime:{value:[0,0,0,0]},iChannelResolution:{value:[0,1,2,3].map(()=>new THREE.Vector3(1,1,1))},
    ...Object.fromEntries([0,1,2,3].map(i=>[`iChannel${i}`,{value:channels[i]||blank}])),
    ...own,
  };
  channels.forEach((t,i)=>{const img=t?.image;if(img)all.iChannelResolution.value[i].set(img.width||1,img.height||1,1);});
  const declare=Object.entries(own).map(([name,u])=>{
    if(u.count==null)return `uniform ${glslType(u)} ${name};`;
    if(!Number.isInteger(u.count)||u.count<1||u.count>256||!Array.isArray(u.value)||u.value.length!==u.count||!IDENT.test(String(u.type)))
      throw Error('shadertoyPass: an array uniform needs {value:[...count items], type, count}: '+name);
    return `uniform ${u.type} ${name}[${u.count}];`;
  }).join('\n');
  if(typeof common!=='string')throw Error('shadertoyPass: common must be shader text.');
  const defineLines=Object.entries(defines).filter(([k])=>IDENT.test(k)).map(([k,v])=>`#define ${k} ${Number(v)}`).join('\n');
  const fragmentShader=`precision highp float;precision highp int;precision highp sampler2D;
#define HW_PERFORMANCE 1
${defineLines}
uniform vec3 iResolution;uniform float iTime;uniform float iTimeDelta;uniform float iFrameRate;uniform int iFrame;
uniform vec4 iMouse;uniform vec4 iDate;uniform float iChannelTime[4];uniform vec3 iChannelResolution[4];
uniform sampler2D iChannel0;uniform sampler2D iChannel1;uniform sampler2D iChannel2;uniform sampler2D iChannel3;
${declare}
out vec4 cbFragColor;
${common}
${source}
void main(){vec4 color=vec4(0.0,0.0,0.0,1.0);mainImage(color,gl_FragCoord.xy);cbFragColor=${alpha?'color':'vec4(color.rgb,1.0)'};}`;
  const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,uniforms:all,depthTest:false,depthWrite:false,
    vertexShader:'in vec3 position;void main(){gl_Position=vec4(position.xy,0.0,1.0);}',fragmentShader});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);mesh.frustumCulled=false;
  const scene=new THREE.Scene();scene.add(mesh);
  const camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  let frameIndex=0;
  return {scene,camera,material,uniforms:all,
    set({time=0,dt=1/60,width=1,height=1,mouse=null}={}){
      all.iResolution.value.set(width,height,1);all.iTime.value=time;all.iTimeDelta.value=dt;all.iFrameRate.value=dt>0?1/dt:60;
      all.iFrame.value=frameIndex++;if(mouse)all.iMouse.value.set(...mouse);
      const d=new Date();all.iDate.value.set(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours()*3600+d.getMinutes()*60+d.getSeconds());
    },
    dispose(){mesh.geometry.dispose();material.dispose();blank.dispose();},
  };
}
