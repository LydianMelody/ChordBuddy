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
- If a visualization has a mistake, only that one stops (with the error shown); the others keep working.

Starting a new one
- Copy chordbuddy\web\visualizations\_template.js here, rename it (no _ at the start), and change its id and name.
- Imports work the same as in the built-in folder, for example:  import {chordColor} from '../visual-color.js';
- The full guide is the "chordbuddy-visuals" skill. Ask Claude to "make a Chord Buddy visualization" and it
  knows what a visualization can use: chords, beats, sections, lyrics, MIDI melodies, the loop and all seven stems.
