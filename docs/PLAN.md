# Chord Buddy Implementation Plan

> Execute with superpowers:subagent-driven-development. User has approved starting; continue without intermediate approval gates.

**Goal:** Deliver a runnable Windows Chord Buddy core application.

**Architecture:** Native pywebview shell plus loopback HTTP service and local UI; SQLite library; isolated SheetSage2 subprocess.

**Tech Stack:** Python 3.11, SQLite, mutagen, mido, pywebview, vanilla JavaScript, abcjs.

**Spec:** DESIGN.md

## Global constraints

- Every song belongs to Default. Set lists have independent order.
- No fabricated inference results. Partial real outputs remain available.
- Preserve originals, persistent per-document Undo/Redo, atomic edits, independent files.
- Tests use temporary workspace roots. Default production library is the user's requested Music path.
- Roadmap extras stay out of this build.

## Task 1: Library and independent documents

Files: chordbuddy/library.py, chordbuddy/documents.py, tests/test_library.py, tests/test_documents.py.
Interface: Library(root) owns SQLite, import_audio(name,bytes,setlist_id), state(), song(id), set-list operations; DocumentStore owns load/save/undo/redo/restore and ingestion of real outputs. Root implementer owns these and API integration.

- [x] Add failing tests for import fallback, duplicate title isolation, set-list ordering, revisions and persistent Undo.
- [x] Implement transaction-safe library and document operations.
- [x] Verify MIDI and ABC output round-trip; no cross-document synchronization.

## Task 2: User interface

Files: chordbuddy/web/index.html, style.css, app.js, editor.js, tests/ui-core.test.mjs.
Consumes exact API in DESIGN.md. Pure editor helpers must be testable under Node without a browser.

- [x] Write failing tests for chord-token replacement preserving other tokens, note validation, and active chord at time boundaries.
- [x] Build polished import/library/set-list/workspace UI, genuine empty state, progress and error states.
- [x] Implement ABC/chord editor, MIDI timeline with field editing, independent Undo/Redo, export, original audio and chord highlighting.
- [x] Test helpers and verify integration against running service.

## Task 3: Real model worker and setup

Files: chordbuddy/engine.py, chordbuddy/worker.py, setup_engine.py, requirements-engine.txt, tests/test_engine.py.
Consumes song source path and isolated run directory. Produces files from official model API plus newline-delimited JSON progress messages. Engine handles readiness, one job at a time, cancellation, partial results and ingestion callback.

- [x] Test progress handling and result discovery against real-shaped fixtures; no production synthetic inference.
- [x] Pin official revision and dependencies, workspace-local caches, isolated subprocess and explicit device.
- [x] Install dependencies and attempt real inference when access permits; record any exact setup or runtime limitation.

## Task 4: Desktop integration and verification

Files: chordbuddy/server.py, chordbuddy/__main__.py, Start Chord Buddy.cmd, setup_app.py, README.md, ROADMAP.md.

- [x] Write failing API tests for authentication, origins, document revision conflicts, ranges and file boundaries.
- [x] Implement HTTP adapters and native shell; keep heavy inference out of UI process.
- [x] Run Python/JS tests and browser smoke checks; fix material findings from component reviews.
- [x] Ship launch instructions and accurate verification status.

