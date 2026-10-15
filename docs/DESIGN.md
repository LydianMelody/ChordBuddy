# Chord Buddy — approved core design

Windows desktop application for personal use. The user approved implementation on 2026-09-15. Practice extras are explicitly deferred to ROADMAP.md.

## Core experience

Drop an MP3, review the title (nonblank metadata first, filename stem otherwise), optionally choose a set list, then Transcribe. Every song belongs to Default. Additional set lists store independent song order. Original audio and transcription outputs live under `%USERPROFILE%\Music\ChordBuddy\<safe title> — <id>`. Repeated transcriptions create separate runs. The app never overwrites the original imported audio or original inference output.

The main window contains set lists and songs on the left, import/title controls above the workspace, tabs for the lead sheet and each MIDI output, and persistent original-audio playback below. The currently playing chord is highlighted using timed events, including after a chord-label correction. No synchronization of changes between independent output files. Each document has persistent Undo/Redo, autosave, and Restore Original. Score edits expose chord correction and editable ABC notation; MIDI edits expose note pitch/start/duration/velocity via a visual timeline and selected-note fields.

## Architecture

Python 3.11 app, pywebview native desktop window, local static HTML/CSS/JavaScript UI. Loopback-only HTTP service, random per-process access token, validated Host and Origin, no CORS. Browser mode exists for testing and fallback. SQLite stores library/set-list ordering and document revisions transactionally. Song folders store source audio and versioned real model outputs. Small dependency footprint for library/editing; SheetSage2 runs in a separate subprocess using an isolated inference environment so failures do not freeze the interface. Automatic selects CUDA when available, otherwise CPU; CPU Only is explicit. First-run setup and model download have clear status. Pinned model revision; no fake transcription fallback.

## API contract

All API requests use `X-ChordBuddy-Token`, taken from URL fragment `#token=...`; media/download URLs use `?token=...`.

- GET /api/state -> {songs:[{id,title,artist,filename,duration,status,error,active_run}],setlists:[{id,name,song_ids}],settings:{device},engine:{ready,message},job:null|{song_id,stage,message,window,windows,tokens,status},root}
- POST /api/import?filename=<name>&setlist=<id> raw audio bytes -> song; title metadata extracted server-side. Audio size capped at 250MB.
- POST /api/song {id,title} -> song
- POST /api/setlist {name} -> setlist
- POST /api/setlist/order {id,song_ids} -> setlist (exact permutation)
- POST /api/setlist/add {id,song_id} -> setlist
- POST /api/settings {device:'auto'|'cpu'} -> settings
- POST /api/transcribe {song_id} -> job (409 if busy)
- POST /api/cancel {} -> job
- GET /api/song/<id> -> {song,documents:[{id,name,kind,revision,can_undo,can_redo,undo_label,redo_label}],chords:[{id,start,end,label}],runs:[{id,created,status}]}
- GET /api/document/<id> -> {id,name,kind,content,revision,can_undo,can_redo,undo_label,redo_label}; kind abc content {abc,chords:[{id,start,end,label,abc_index}]}; midi content {notes:[{id,pitch,start,end,velocity,track}],tracks:[{name,program,is_drum}],duration}; text content {text}.
- POST /api/document/<id> {content,label,revision} -> updated document; revision is an optimistic concurrency token. All document changes transactional, validation before writing.
- POST /api/document/<id>/undo or /redo or /restore {revision} -> document
- GET /api/audio/<song_id> -> range-capable original audio
- GET /api/export/<document_id> -> current edited document as ABC/MIDI/text attachment
- POST /api/open-folder {song_id} -> {ok:true}

The app receives status by polling state while jobs run. Errors return JSON {error}, with relevant 4xx/5xx status. The document ABC/chord associations preserve original timing; changing chord quality updates only the selected ABC token and its associated display label, not MIDI/events files. Exporting a modified document writes its current version beneath the run's edited directory as well as returning it.

## Verification

Use temporary roots for all tests. Cover metadata fallback, collisions, persistence, set-list permutations, revision conflicts, Undo/Redo after reopen, divergent history, restore undo, traversal, malformed notes, MIDI round-trip, range playback, API authorization, real worker progress/partial results. UI smoke test import/edit/reorder/reopen and core playback highlighting against an explicitly labeled test fixture. Real model inference only counts as verified when actual weights load and a real audio fixture is processed.
