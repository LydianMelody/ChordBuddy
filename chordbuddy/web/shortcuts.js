// Every keyboard shortcut, for the Keyboard shortcuts dialog (More options, or ?). Keep it in step with the handlers:
// playback-keys.js, app.js, chart-page.js, lead-sheet.js (lead-tool-info.js), visualizer-view.js and visualizer-page.js.
// keys: what to press, each a list of keycaps shown side by side ('/' between alternatives).
export const SHORTCUTS=[
  {title:'Playing',note:'These work in the visualizer too.',rows:[
    [['Space'],'Play or pause'],
    [['R'],'Loop the section you’re in. An intro starts at bar 1, past any fade-in; an outro that fades out loops its first 4 bars. Again to stop.'],
    [['L'],'Loop 4 bars of the section (1–4, 5–8 …), or the pass you’re in of a ×4, ×8 … phrase. Again to stop.'],
    [['←','/','→'],'Previous or next bar'],
    [['Ctrl','←','/','→'],'Previous or next section'],
  ],after:'Drag the loop handles on the waveform for any range: they win over R and L, and either key then ends the loop.'},
  {title:'Chord chart',rows:[
    [['Hold Ctrl'],'Editing tools'],
    [['Hold Shift'],'Timing tools'],
    [['Esc'],'Put the tool down'],
    [['Ctrl','Z'],'Undo'],
    [['Ctrl','Shift','Z','/','Ctrl','Y'],'Redo'],
    [['+','/','−'],'Zoom in or out (timing view)'],
    [['Ctrl','+','/','−','/','0'],'Zoom the page'],
  ]},
  {title:'Typing lyrics',rows:[
    [['Enter'],'Next line (on the last one: done)'],
    [['Tab','/','Shift','Tab'],'Next or previous pass'],
    [['Esc'],'Drop this row’s changes'],
  ],after:'Click away to save the row.'},
  {title:'Lead sheet',rows:[
    [['V','C','L','B'],'Select, Chords, Lyrics or Breaks tool (here L picks the tool, not a loop)'],
    [['←','/','→'],'Previous or next note'],
    [['↑','/','↓'],'Raise or lower the note (with Shift: an octave)'],
    [['Delete','/','0'],'Make it a rest'],
    [['#'],'Sharpen'],
    [['Esc'],'Back to Select, or deselect'],
  ]},
  {title:'Visualizer',rows:[
    [['1','–','9'],'Choose a scene'],
    [['Y'],'Lyrics on or off'],
    [['C'],'Calm'],
    [['M'],'Mixer'],
    [['P'],'Frame rate'],
    [['F'],'Full screen (visualizer window)'],
  ]},
  {title:'Anywhere',rows:[[['?'],'This list']]},
];
