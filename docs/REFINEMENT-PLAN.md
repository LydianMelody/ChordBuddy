# Song editing refinement plan — 2026-09-17

User-directed workflow: lower-cost implementation agents; primary agent plans, reviews, integrates through delegated fixes, verifies, installs. Work on isolated source copy; do not alter user song data during tests. No automatic lyric placement.

1. Reversible confidence presentation: preserve the original model result; derive visible rhythm from saved tolerance when a document loads or settings save. Lowering removal threshold restores available original beats without inference. Rebuild derived notation where appropriate without overwriting manual notation/lyrics. Explain any missing-original limitation.
2. Per-song constant tempo: store an explicit steady-tempo override, offer editable BPM with a derived starting value, suppress rhythm uncertainty flags under the override. Maintain phase/downbeat/meter identity and manual lyric anchors; do not treat constant tempo as a constant time signature or as certainty about chords.
3. Playback: derive the active measure and beat from recording time on every update, independently of chord changes. Highlight the chord displayed in the active measure, including a carried chord.
4. Confidence styling: configurable minimum/maximum opacity for uncertain chord labels; full opacity for confirmed chords. Remove purple and diamonds. Carry-over parentheses are not uncertainty; simplify to repeated ordinary chord labels with carry-over information in tooltips.
5. Chord confirmation: clicking a chord offers confirm or edit-and-confirm. Save user intent durably in song metadata tied to recording-time coverage and apply to chart and score. Confirmed chords no longer show model uncertainty. Edits remain inspectable and recoverable.
6. Reprocessing: always show Keep my changes and Replace with fresh output for existing runs, regardless of current document dirty flags. Keep confirmations/timing metadata and existing user-edited documents; fresh outputs receive explicit chord overrides without lyric remapping. Replace only upon successful completion. Prior versions remain recoverable.
7. Remove the chart slogan; display no-chord as blank or rest, never N.
8. Lyrics: click a bar/beat/note to type locally; show text as typed; move explicitly by drag or move action; preserve focus and caret across saving; allow selection of another note. Remove sequential melody-note dropdown. Pasted lyrics stay unplaced until the user explicitly places them.

Implementation ownership: backend agent (Python/data/API), chart agent (chart components/CSS), lead-sheet agent (score components/CSS), integration agent (app wiring/settings/confidence/common UI). Primary reviews diffs and tests each subsystem and the integrated UI. Tests use a copied library and fixtures; no full-song model inference needed for presentation changes.

Verification: persistence and reprocess regression tests; reversible rhythm filtering; constant-tempo phase/meter and manual anchors; no confidence for confirmed chords; DOM/browser tests for inline lyrics and repeated chord playback; full existing Python/JS tests. Back up installed source, hash-verify copies, preserve Data/runtime/models.

Progress: delegated implementation reviewed and integrated. Backend and browser regression suites pass; installed to the portable Dropbox copy with timestamped source backups. Full-song inference was intentionally not rerun for this presentation-only change.
