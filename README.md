# Chord Buddy

A free practice app for Windows. Give it a song (an MP3) and it works out the chords, the melody and the song's sections, then gives you three ways to play along:

- **Chord chart:** the song's chords bar by bar, with the lyrics under them, repeats folded (`G C D C ×2`) and the current chord lit as the music plays.
- **Lead sheet:** the melody on a staff with chord symbols and lyrics, ready to print or save as a PDF.
- **Piano roll:** every note of the vocal melody, the instruments and the chords, in their own colors.

It can also split the recording into seven stems (bass, drums, vocals, piano, lead guitar, rhythm guitar and the rest), so you can turn parts up, down or off while you practice.

Everything runs on your own computer. Your music is never uploaded anywhere.

## What you can do

- **Practice:** loop any stretch, slow the music down without changing the pitch, follow along on the chart, the lead sheet or the piano roll, and mute or solo stems in the mixer.
- **Correct the chart:** retype chords and words, split and join sections, fold or unfold repeats, time the words to the beat, and fix bar lines for short or long bars. Every change can be undone, even after closing the app.
- **Edit the lead sheet:** fix chord symbols, type lyrics (they are shared with the chart), choose where lines break, or open it in MuseScore or another notation program as a MusicXML file.
- **Export:** PDF of the chart or the lead sheet, MIDI (one multichannel file or one file per track), a mix of the stems as an MP3, or a zip of everything the model produced. **Whole song · zip** moves a song to another computer with everything that belongs to it: your edits, your own MIDI files, its visual connections and look, and its arrangements.
- **Make it yours:** three color themes, each with a light and dark look.

## Install

You need Windows 10 or 11 (64-bit) and a few GB of free space. An NVIDIA graphics card makes the analysis much faster, but it is not required.

1. Download or clone this repository into a folder with a short path, such as `C:\ChordBuddy`.
2. Double-click **InstallWindowsDependencies.cmd**. It sets up everything Chord Buddy needs inside that folder only: its own Python, PyTorch, the audio tools, the stem models and the chord and melody model ([SheetSage2](https://huggingface.co/m-a-p/SheetSage2), with [MERT-v2-FullSong](https://huggingface.co/m-a-p/MERT-v2-FullSong), at fixed versions). It picks the NVIDIA version of PyTorch automatically when it finds an NVIDIA card. It is safe to run again.

The models are public, so you don't need a Hugging Face account. To download them later instead (they are a few GB), run `InstallWindowsDependencies.cmd --skip-models`. Chord Buddy then shows a **Download** button for each model when it first needs it.

## Use it

1. Double-click **Start Chord Buddy.cmd**. (If the window does not open, **Start in browser.cmd** opens Chord Buddy in your web browser instead.)
2. Drop an MP3 into the window, or choose **Import MP3**.
3. Check the title and artist (they are read from the file's tags), choose whether to split the stems, and choose what to process with: **Automatic**, **NVIDIA GPU only** or **CPU only**. Then choose **Analyze**.
4. When the analysis is done, switch between **Chart**, **Lead sheet** and **MIDI** at the top of the page, and use the player at the bottom.

Your songs and everything you change are saved in the **Data** folder next to the app. Back it up like any other folder.

**Settings → Check for updates** tells you if a newer version is out. It checks only when you press it, reads one small file from this project's GitHub page, sends nothing about your songs, and never installs anything.

Handy keys: **Space** plays and pauses, **Esc** puts a tool down, letters pick tools (hover over a tool to see its key), and in the piano roll **Ctrl + wheel** zooms time and **Ctrl + Shift + wheel** zooms pitch. **Ctrl + wheel** over the chart or the lead sheet makes the page bigger or smaller.

## Your own MIDI for the visualizer

The model's MIDI has no dynamics, pedals or bends, and no bass or drum parts. You can bring your own: drop a `.mid` file anywhere on the window (or use **Your MIDI** in the MIDI view). It goes with the open song, unless the playhead is at the very start or end, in which case Chord Buddy asks which song it is for. Then you line it up:

- **Follow the song's beats** lays the file's beats on the beats found in the recording, so a missing or wrong tempo (files that say 120 because nobody set it), drift and a live feel all come out right. **Use the file's tempo** is for a file made over this very recording.
- **Guess** slides the file along the song and proposes where it fits best, how sure it is, and other good fits. It also notices a file written in another key.
- Drag the part to move it (it snaps to the song's grid, finer as you zoom in; turn **Snap** off to place it freely). Use **Pin** (or Shift-drag) to pin a note where it belongs. Two pins stretch the file between them, like stretch markers. Space plays the song with your notes as a quiet tone.
- For each part, choose **Visual extra**, **Replace the vocal melody**, **Replace the instrumental melody** or **Leave out**. Only what is really in your file is offered. Replacing changes what the visualizer sees, never the chart or the model's MIDI.

Your file is kept unchanged in the song's `my-midi` folder, with its placement beside it.

**From Reaper (or another DAW):** the easiest way is **Your MIDI → Add custom MIDI data**. It makes a new file laid out on the song's own beats, with the model's melodies in it and an empty track for your part. Open it in Reaper with **Open in your DAW** (it uses the program Windows opens `.mid` files with; or **Show folder** and drag it into Reaper), keep the file's tempo map when Reaper asks, play or draw your part, and export back over the same file. Chord Buddy picks up the change by itself, already lined up. A file exported from a Reaper project you built over the song's recording, starting at the project's start, also lines up on its own.

## The Advanced Visuals Editor: choose what moves what

Each visualization reacts to the music in its own way: Abstract's shockwave follows the kick drum, Starlane's lasers fire on the beat, and so on. **Visualizer → Advanced Visuals Editor** (or **Edit visuals** on a visualizer's toolbar) opens the editor in the main window, in place of the chart, where you can rewire those reactions. The sidebar and the player stay, so you can play the song while you work. Across the top, **Editing** chooses the visualization (it starts on the one showing, and every visualizer follows your choice). Below that are three columns: the sounds and signals on the left (the beat, chord and section changes, each stem's hits and loudness, the melodies, and everything in your own MIDI: notes, velocity, the sustain pedal, the mod wheel, pitch bend, MPE pressure), the visualization's inputs in the middle, and a live preview on the right. Each source and input has a small light that shows its value as the song plays. Under the preview is the mixer (its chevron folds it down): muting a stem, or soloing another, also stops everything that stem moves in the visuals (muting the vocals takes their notes out of the melodies too), without unplugging anything, so you can see and hear one part on its own. This works in every visualizer, not just the preview. **Pop out** opens the visualizer in its own window too, to put on another monitor; **✕** goes back to the chart.

- Click a source, then an input, to connect them with a cable (or drag from one to the other). An input can have several cables.
- Click an input to see what moves it: its cables stand out and its settings appear under the preview. Each cable says in plain words what it does, and has settings where they make sense: how long a flash fades, a threshold, Min and Max, Invert, smoothing. On a cable from MIDI (your own, or the model's melodies), **Range** picks which part of the signal counts: **Set from range** measures what it really covers in the song, and you can type your own. For notes it is a range of notes, such as C3 to C5: only those notes pass, so one keyboard part can drive two things (low notes here, high notes there). For pitch it is the notes the full sweep covers; for velocities and levels, the span that is stretched to full scale (a mod wheel you only ever pushed halfway, say). Your MIDI's velocities, controllers and pressure read 0–127, as in your DAW. **Outside** chooses what happens past the range: **Clip** holds a value at the edge (above the top counts as the top), **Leave out** ignores it, so only hard hits fire, say. Notes leave out by default; everything else clips. **Unplug** removes a cable.
- With many sources (every track of a big project), the list folds: each group and each track opens and closes, and a track with a cable starts open. **Find a source…** searches every name ("vox mod" finds the mod wheel on each vocal track), and **In use** shows only what is connected. When you select a part on the right, sources that cannot drive it are dimmed.
- Cables of any kind connect: a drum hit plugged into something that wants a level becomes a glow that fades, a level plugged into something that wants on/off switches at a threshold. The cable's color shows what it carries.
- Changes are saved at once. **Editing visuals for:** shows whose patch you're changing: **Every song** (the usual) or **This song only**, which gives the open song its own patch. **Back to the defaults** puts every cable back the way the visualization comes. **Undo** and **Redo** (or Ctrl+Z and Ctrl+Shift+Z while the editor is open) step through your changes in the editor.
- A visualization you have never patched looks exactly as it always did. A cable from your own MIDI waits quietly in songs that do not have that part.

Patches are kept in `visual-patches.json` in your library folder. Visualizations in **My Visuals** can declare their own parts to patch (see the template, `chordbuddy/web/visualizations/_template.js`).

## Perform: run a whole set with one Start

**Perform** at the top of the window has three pages, each taking the chart's place. The chart itself never changes.

- **Prepare this song** plans how a song plays on stage, as a named arrangement you can save (a song can have several). Select some bars, then **Repeat** them a set number of times or until you release them. Add actions at any bar: mute or fade a track, change the speed, change the visualization, fire one of its parts, send MIDI, or put a note on the stage screen. Each pass of a repeat can be edited on its own, so pass 2 can bring the drums in and change the visuals without touching pass 1. Drag an action to another bar, or type its bar and beat. Tick several in the list to copy or delete them together. **Save** makes a version a show can use.
- **Shows** puts songs in order, each with its arrangement and how it starts (right after the last song, after a gap, or when you press Next song). The same song can go in twice. It adds up the music and the gaps, and counts against a slot length or a finish time if you give it one.
- **Perform view** is what you read during the show, from a distance: where you are, what's coming, the time left, and your controls. Press **Start** once, and the set plays by itself.

During a show, the usual keys wait for the music, so nothing ever happens in the middle of a bar:

- **L** loops the four bars you're in and **R** the section. Press the same key to leave after the pass you're in, or the other one to switch after it.
- **←** and **→** queue a jump to another bar, and it happens at the next bar line. Clicking in the chart does the same. Whatever is queued is shown, with a **Cancel**.
- **Space** pauses at once. The music stops, and the slot clock keeps counting.
- A hold that waits for you shows **Go on**. A song set to start when you say waits for **Next song**.

The Perform view has its own **Mixer**, and you can leave it at any time: the show keeps playing, the chart follows along, and the button at the top says **Show running** to bring you back. Anything you change by hand (a fader, a mute, the visualization) stays until you release it, even if the plan changes it later, unless you choose otherwise under **When you change something by hand**. Each one shows as **LIVE** on the Perform view; click it to go back to the plan. By default, a stem you mute also stops what it moves in the visuals. If you're playing that part yourself, tick **Keep visuals when a stem is muted** on the show.

A loop that lasts until you release it makes the finish time an estimate: it's planned as four plays and grows if you stay longer. Leaving early takes the unused plays back off.

**MIDI:** connect a device from the **Shows** page (the Line 6 Helix has its own action for setlist, preset and snapshot). You can teach it controls with **Learn**: only a control you taught does anything, so a pedal's own chatter when it changes preset is ignored. Nothing is sent while you edit, and Preview sends MIDI only if you tick **Send to hardware**. A sent message means it was sent, not that the device did anything; presets can take a moment to load, so an action can be set to go a little early. **Watch incoming MIDI** lists what's arriving from a device, and says so if its MIDI clock is coming through, to check it's reaching the computer. Chord Buddy listens through Windows' newer MIDI route when it can, so a Helix that other programs can't hear on Windows 11 can still work here. A device marked **This show needs it** stops the show at the next bar line if it's disconnected; any other is noted, and gets where things stand when it comes back, not what it missed.

While a show runs, Chord Buddy keeps the computer and screen from going to sleep by themselves. It can't stop you putting it to sleep or closing the lid, and it changes no power settings.

Shows can be saved to a file and brought in on another computer (**Export to a file**, **Import from a file**, in the show's **⋯** menu). The file carries the arrangements and the visual connections and looks the show uses, but not the recordings, so the songs must already be there. It carries the names of custom visualizations, never their code: add those to **My Visuals** yourself. What's already on that computer is never overwritten.

## Stream the visualizer with OBS

**Visualizer → Stream to OBS…** (at the top of the window) copies an address for an OBS **Browser Source**. OBS draws it off screen, so it keeps going while you click around in Chord Buddy, it is exactly the size you set in the source (for example 1920 × 1080), and it shows only the picture: no buttons, mixer or mouse pointer. It follows the open song, playback and the look you choose in the visualizer. Tick **Use custom frame rate** and choose 60 for smooth motion.

For the sound, add an **Application Audio Capture** source in OBS and pick the browser Chord Buddy is open in (**Start in browser.cmd**). The address stays the same from one launch to the next. Keep it private: while Chord Buddy is running, it can read your songs.

## For developers

Chord Buddy is a small Python 3.11 server (`chordbuddy/`) and a plain JavaScript front end with no build step (`chordbuddy/web/`). The models run in separate worker processes, one job at a time.

- Run with a test library: `runtime\python.exe portable_start.py --browser --library C:\some\test\library`
- JavaScript tests: `node --test tests/*.test.mjs`
- Python tests: `runtime\python.exe -m pytest -q tests`

[docs/DESIGN.md](docs/DESIGN.md) explains how the app is put together, and [docs/MUSICAL-LAYOUT.md](docs/MUSICAL-LAYOUT.md) lists the musical rules the chart and lead sheet follow.

## Credits and licenses

Made by [LydianMelody](https://github.com/LydianMelody) and Claude.

Chord Buddy's own code is released under the MIT License (see `LICENSE`).

Chord and melody transcription uses [SheetSage2](https://huggingface.co/m-a-p/SheetSage2) by the Music AI Project, built on MERT-v2-FullSong. Its weights are licensed **CC BY-NC 4.0** (non-commercial use, with attribution). I have not been able to confirm the terms of the two stem separation models; if you know them, please contact me at lydianmelody@outlook.com. Please treat Chord Buddy as a free, non-commercial tool. Full details, including every library and the design references, are in `THIRD-PARTY-NOTICES.md` and `docs/MODEL-ATTRIBUTION.md`.

Practice speed (slowing a song down without changing its pitch) uses [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) by Geraint Luff of Signalsmith Audio (MIT). Score rendering uses [abcjs](https://github.com/paulrosen/abcjs) (MIT). The fonts are Bricolage Grotesque, Courier Prime and Space Mono (SIL Open Font License).
