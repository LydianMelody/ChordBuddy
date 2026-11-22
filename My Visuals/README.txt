MY VISUALS
==========

Your own visualizations live here. Chord Buddy never changes, replaces or deletes anything in this folder,
including when it updates, so this is the safe place for looks you make or download.

How it works
- Each visualization is one .js file. Drop it in and it appears on the visualizer's toolbar within a few
  seconds (no restart). Edit it and save: the visualizer reloads it. Delete it and it disappears.
- File names may use letters, digits, spaces, - and _. A name starting with _ stays hidden (for drafts).
- To change one of the built-in looks, copy it here from chordbuddy\web\visualizations and edit the copy.
  Keep its id: your copy then replaces the built-in one, and deleting your copy brings the original back.
- Pictures or fonts a visualization uses can sit here too, in subfolders if you like.
- A visualization can use font files for its own drawing and for the chord and lyrics. Put them in the "fonts" folder in here (a .woff2,
  .woff, .ttf or .otf, up to 8 MB each). A visualization names a font by file name only, never a folder or a web address; Chord Buddy
  looks in that one folder, checks the file is really a font and keeps it private to that visualization. A visualization says in its first
  lines which font files it expects (Rose Window can use DotGothic16-Regular.ttf, but works without it). Free fonts under the SIL Open
  Font License are a good choice. See the README in the fonts folder.
- If a visualization has a mistake, only that one stops (with the error shown); the others keep working.

Starting a new one
- Copy chordbuddy\web\visualizations\_template.js here, rename it (no _ at the start), and change its id and name.
- Imports work the same as in the built-in folder, for example:  import {chordColor} from '../visual-color.js';
- The full guide is the "chordbuddy-visuals" skill. Ask Claude to "make a Chord Buddy visualization" and it
  knows what a visualization can use: chords, beats, sections, lyrics, MIDI melodies, the loop and all seven stems.

3D and shaders (three.js)
- A visualization can draw in 3D, or with shaders like the ones on shadertoy.com, using three.js, which comes with Chord Buddy (nothing
  is downloaded):  import {THREE,createThreeView,shadertoyPass} from '../visual-three.js';
  The chord and lyrics are still drawn on top as usual. The first lines of chordbuddy\web\visual-three.js explain each part,
  including a shader with several passes, like Shadertoy's Buffer A-D tabs.
- It keeps your monitor's full frame rate (144 Hz on a 144 Hz monitor): when the graphics card falls behind, the picture is drawn at a
  lower resolution, never below half, and goes back up when there is time again.
- Adapting someone else's code (a shader from Shadertoy, say): only use it if its author allows it. Keep the author's credit and link
  at the top of your file, exactly as they ask. Never use one that says you cannot host, display, distribute or share it (or anything like that), and do not copy
  Shadertoy's own sample pictures and textures; noiseTexture() in visual-three.js makes a noise texture instead.

In a show
- A show can switch to your visualization and fire or set the parts it declares as `inputs`, so declare the ones worth controlling.
- A show file names your visualization but never carries its code. On another computer, copy the .js file here too.
- To make a live loop repeat the same way each pass, use env.random() in place of Math.random(), and start over when env.events.replay is set.
