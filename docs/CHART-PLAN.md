# Section and lyric chart update

User approved the design discussed in chat: sections from model output; editable names and timing; optional manually entered lyric lines; chords anchored above words independently of audio timing; persistent Undo/Redo; conventional slash-bass display. No automatic lyric transcription or cross-file synchronization.

Architecture: add a versioned chart document through the existing document APIs. Seed it lazily for older transcriptions without rerunning the model. Preserve all original outputs and existing edit histories. Chart is the default tab; ABC keeps its score and direct chord editing, without the wall of tiles.

Contract: chart content has version=1, duration, sections[{id,name,start,end,lyrics}], chords[{id,label,start,end,section_id,line,offset}]. Null line/offset means unplaced; otherwise line is a zero-based lyric line and offset a character anchor. All times are seconds. Original song duration is authoritative. Sections are ordered and nonoverlapping.

- [x] Normalize chord qualities and relative bass notes; test original and legacy labels, preserve unknown labels.
- [x] Add validated chart seeding, persistence, export and lazy upgrade; test originals and histories remain intact.
- [x] Build section/lyric UI, chord placement and timing controls, safe draft handling and playback highlighting; helper tests.
- [x] Run integrated tests and isolated UI checks, review changes, update launch guidance.

Verification uses isolated workspace libraries. The user's running Music library is not modified by development tests. Restarting the app loads the update; opening a transcribed song adds its chart automatically.

