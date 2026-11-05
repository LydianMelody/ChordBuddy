// This window would otherwise outlive Chord Buddy and keep WebView2 running, so it closes when the main window or the local server is gone.
let misses=0;
setInterval(async()=>{
  if(window.opener?.closed){window.close();return;}
  try{await fetch('/obs-sound.js',{cache:'no-store'});misses=0;}
  catch{if(++misses>=2)window.close();}
},2000);
