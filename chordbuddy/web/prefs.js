// Small interface preferences (theme, folded panels, a song's key). The app opens on a different local port every launch, so the
// browser's own storage cannot be trusted to remember anything: the library keeps the real copy (see /api/prefs) and
// localStorage is only a fast first paint. Every access is guarded; a failure just means "use the default".
const cache=new Map(),pending={},listeners=[];
let send=null,timer=null;
try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key.startsWith('cb-'))cache.set(key,localStorage.getItem(key));}}catch{/* blocked storage */}

function flush(){
  timer=null;if(!send||!Object.keys(pending).length)return;
  const batch={...pending};for(const key of Object.keys(batch))delete pending[key];
  Promise.resolve(send(batch)).catch(()=>{for(const [key,value] of Object.entries(batch))if(!(key in pending))pending[key]=value;});
}
function schedule(){if(!timer&&send)timer=setTimeout(flush,350);}

export const prefs={
  get(key,fallback){return cache.has(key)?cache.get(key):fallback;},
  set(key,value){
    value=String(value);if(cache.get(key)===value&&!(key in pending))return;
    cache.set(key,value);try{localStorage.setItem(key,value);}catch{/* blocked storage */}
    pending[key]=value;schedule();
  },
  // Called once the connection exists: `write` saves a batch, `read` returns everything saved for this library.
  async connect(write,read){
    send=write;
    try{
      const saved=await read();
      for(const [key,value] of Object.entries(saved||{})){
        if(key in pending)continue;
        cache.set(key,value);try{localStorage.setItem(key,value);}catch{/* blocked storage */}
      }
    }catch{/* offline: keep what we have */}
    listeners.forEach(fn=>fn());flush();
  },
  onLoad(fn){listeners.push(fn);},
};
