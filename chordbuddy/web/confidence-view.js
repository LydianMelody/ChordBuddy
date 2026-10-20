export function isLowConfidence(score,threshold){return typeof score==='number'&&Number.isFinite(score)&&score>=0&&score<=1&&score*100<Number(threshold);}
export function chordConfidence(chord,music){
  if(chord?.confirmed===true)return null;
  const found=music?.confidence?.chords?.find(c=>Math.abs(c.time-chord.start)<1e-6&&c.label===chord.label);
  return typeof found?.score==='number'?found.score:null;
}
export function chordOpacity(chord,music,settings={}){
  if(chord?.confirmed===true)return 1;
  const score=chordConfidence(chord,music);
  const minimum=Math.max(0,Math.min(100,Number(settings.chord_opacity_min??40)));
  const maximum=Math.max(minimum,Math.min(100,Number(settings.chord_opacity_max??100)));
  if(typeof score!=='number'||!Number.isFinite(score))return maximum/100;
  const threshold=Math.max(0,Math.min(100,Number(settings.chord_flag_threshold??50)))/100;
  const normalized=threshold>0?Math.min(1,score/threshold):1;
  return (minimum+(maximum-minimum)*Math.max(0,normalized))/100;
}
export function decorateScoreConfidence(tune,content,music,settings){
  const chords=content.chords?.filter(c=>Number.isInteger(c.abc_index))||[];
  for(const line of tune.lines)for(const staff of line.staff||[])for(const voice of staff.voices||[])for(const item of voice){
    if(!item.chord||!Number.isInteger(item.startChar)||!Number.isInteger(item.endChar))continue;
    for(const chord of chords.filter(c=>c.abc_index>=item.startChar&&c.abc_index<item.endChar)){
      const annotation=item.chord.find(a=>a.name===chord.label);
      if(annotation)annotation._chordOpacity=chordOpacity(chord,music,settings);
    }
  }
}
