# Chord Buddy roadmap

## Core release — current work

MP3 import and metadata titles; Default and ordered set lists; real SheetSage2 inference; automatic GPU / CPU Only; inference progress; automatic song folders; original audio playback with current-chord highlighting; output tabs; independent editing, export and persistent Undo/Redo.

## Practice tools — built (Press Room frontend, 2026-10)

- Click any chord, word, bar or section to jump there (Navigate mode).
- Loop a selected passage: drag on the waveform; snaps to bars (beats when zoomed in); seamless inside the audio engine.
- Slow or speed up playback (50–125%) without changing pitch: a WSOLA time-stretch in the audio worklet, applied to the mixed output.
- Automatic chart scrolling while playing (Navigate mode); Follow toggle on the navigation bar.
- Per-stem mixer with presets and real level meters; Trash for deleting songs; locked state until a song is analyzed.

## Still open

- Dragging section boundaries on the navigation bar (the old Section dialog was dropped).
- Listening tests and tuning of the time-stretch on drums.
- Restyling the Lead sheet and MIDI screens in the Press Room look.

## Later possibilities

- Automatic lyric recognition and optional word timing.
- Syllable placement under melody notes for traditional vocal notation.
- Broader graphical notation and engraving controls.
- Optional synchronization between edited score and MIDI.
- Additional GPU backends after validation.
- Standalone installer with bundled Python and first-run model setup.
- Model author clarification before commercial use or distribution beyond the noncommercial terms.
