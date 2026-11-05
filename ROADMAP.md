# Chord Buddy roadmap

## Core release — current work

MP3 import and metadata titles; Default and ordered set lists; real SheetSage2 inference; automatic GPU / CPU Only; inference progress; automatic song folders; original audio playback with current-chord highlighting; output tabs; independent editing, export and persistent Undo/Redo.

## Practice tools — built (Press Room frontend, 2026-10)

- Click any chord, word, bar or section to jump there (Navigate mode).
- Loop a selected passage: drag on the waveform; snaps to bars (beats when zoomed in); seamless inside the audio engine.
- Slow or speed up playback (50–125%) without changing pitch: Signalsmith Stretch (MIT, WebAssembly) in the audio worklet, applied to the mixed output, with Chord Buddy's own simpler WSOLA stretcher as the fallback.
- Automatic chart scrolling while playing (Navigate mode); Follow toggle on the navigation bar.
- Per-stem mixer with presets and real level meters; Trash for deleting songs; locked state until a song is analyzed.

## Visuals — built (on `main`)

- Visualizer on a second monitor or full screen, with built-in looks and your own in **My Visuals**; a look can be pinned to a song, and looks can restyle their controls (skins).
- Advanced Visuals Editor: rewire which sounds and signals move which parts, per visualization, for every song or one song.
- Your own MIDI for the visualizer: drop a file, line it up with the song's beats, and use it as an extra or in place of a melody. Round trip with Reaper.
- Stream to OBS as a Browser Source, with the desktop app's sound through a small window OBS can capture (on `perform`).

## Performance system — built, on the local `perform` branch (not merged, not pushed)

Prepare, Shows and Perform: named arrangements with each repeat pass editable, a set that runs from one Start, bar-quantized jumps and loops, live changes that outlast the plan, timed visuals, MIDI in and out, keep-awake. Also on this branch: song zips that carry a song's MIDI, visuals and arrangements; show files; Check for updates.

Before calling it ready for a real show:

- A full run with real sound. Listen for clicks at loop wraps and Next song, and for a gap when a speed change starts mid-song.
- A real footswitch press end to end. Its clock already reaches the app; a press has not been seen yet.
- The desktop window, minimized playback, a keyboard-only pass, real-mouse use, and a two-hour stress run. So far everything has run in a browser with scripted clicks.
- A small visual preview on a visual action in Prepare (the name shows for now).

## Still open

- Real-mouse testing of the Advanced Visuals Editor and your own MIDI.
- Your own MIDI: the manager's summary can list parts that are gone after a re-export.
- Your own songs: bring in your own stems and Synthesizer V notes. Research matching the master's loudness and dynamics first.
- Move MIDI input to Windows MIDI Services (`Windows.Devices.Midi2`) once it leaves preview and can be used from Python. WinRT MIDI 1.0 works today; Microsoft lists it among its older APIs, with no removal date.
- `build_portable.py` expects a `Start Portable.cmd` that isn't in the project, so it can't run on this checkout. `InstallWindowsDependencies.cmd` is the way to install.
- Dragging section boundaries on the navigation bar (the old Section dialog was dropped).
- Listening tests of the time-stretch on drums.
- Compress the stored stems. They are uncompressed WAV today, about 0.8 GB per song. Lossless FLAC (roughly half the size, exact seeking, no encoder delay) is the likely choice: lossy MP3 would add artifacts that the time-stretch makes easier to hear, and its start-of-file offset would have to be corrected for the shared clock. MP3 stays an export format only.

## Later possibilities

- Automatic lyric recognition and optional word timing.
- Syllable placement under melody notes for traditional vocal notation.
- Broader graphical notation and engraving controls.
- Optional synchronization between edited score and MIDI.
- Additional GPU backends after validation.
- Standalone installer with bundled Python and first-run model setup.
- Model author clarification before commercial use or distribution beyond the noncommercial terms.
