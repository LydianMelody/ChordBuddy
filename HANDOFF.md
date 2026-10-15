# Continue Chord Buddy development

## Start here in a new Codex chat

Open this folder as a local project and ask: "Read HANDOFF.md and README.md, inspect the current implementation, and continue Chord Buddy development with me. Preserve my library and original model outputs."

This document carries project context; it does not import the previous chat transcript or account settings. The editable source and tests are included beside it. No Git repository was initialized during the original build.

## Product and user preferences

Chord Buddy is a local Windows music transcription/editor app for working musicians without technical expertise. User has an excellent musical ear, reports good chord accuracy but timing often needs correction, and strongly likes the warm ivory/green/gold visual design. Preserve that design and friendly language. Personal noncommercial use initially. User approves iterative work; avoid unnecessary confirmation for reversible implementation.

Original requirements: MP3 drag/drop; metadata title before filename fallback; editable title; every song in Default plus independently ordered set lists; real SheetSage2 inference; auto GPU where compatible/CPU-only choice; progress/cancel; per-song folders; original audio playback with current chord highlighting; every output tab; independent edits with robust persistent Undo/Redo, no cross-file synchronization.

## Implemented

- Python 3.11 loopback server + pywebview Windows shell; vanilla JS/CSS, abcjs renderer; SQLite library and per-document revision histories.
- Real pinned SheetSage2 worker in separate process, partial output handling, cancellation and local caches. Model revision 7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384; parent MERT-v2-FullSong d8ba1c745e733b3908ce6ad16ebeb17ac7600a42. Weight licenses CC BY-NC 4.0.
- MP3 import, metadata, set lists, output tabs, MIDI note editing, ABC source editing and direct linked score chord correction.
- New default Song chart document: sections seeded from structure.lab, adjacent identical labels combined; section names/times, split/merge; manual lyric lines; select a chord then click a word to anchor above lyrics; independent chord timing/labels; shared boundaries adjust neighbors; add chord splits containing interval.
- Chart persists via existing save/Undo/Redo/restore/export APIs. Lazy creation supports old transcriptions without another inference run. Original files and earlier revisions remain unchanged.
- Slash-bass conversion: raw G#:min7/b7 and legacy G#min7/b7 display G#m7/F#. Raw annotation tabs retain original strings. Unknown spellings preserved.
- Editing a lyric line unplaces its anchored chords; Undo restores both. No automatic lyric recognition or syllables under melody notes yet.
- History requests lock editing briefly and preserve any in-flight draft via version guard. Native close attempts flush pending edits before closing.

## File map

- chordbuddy/library.py: library, set lists, paths, runs, SQLite.
- chordbuddy/documents.py: ingestion, lazy chart creation, document persistence/export/history.
- chordbuddy/chart.py and chords.py: chart validation/seeding and label normalization.
- chordbuddy/midi.py: MIDI read/write preserving controls, tempo and trailing silence.
- chordbuddy/engine.py, worker.py, model_cache.py: isolated model and Windows cache compatibility.
- chordbuddy/server.py, __main__.py: HTTP/security/audio ranges/native launch.
- chordbuddy/web/app.js, editor.js, index.html, style.css: UI and pure helpers.
- portable_start.py/build_portable.py: portable environment and packaging. See PORTABLE.md.

## Verification and constraints

Latest chart build: 62 Python tests pass, two cache tests skip in app-only env; 15 JS tests pass. Separate model-cache tests passed previously in inference env. See docs/VERIFICATION.md for subsequent portable verification.

Browser tested lyric paste, word chord placement, Undo/Redo, reopening, title autosave, section boundary edits and original score remaining independent. IAB preview crashes on native audio Play interaction; live moving highlight was not reverified there. Do not infer that user's native app has the same issue.

Real CPU inference succeeded: generated 12-second fixture took155.53s excluding loading; user's220.91s song took171.78s,511 notes, no ABC error. Those are integration observations, not accuracy benchmarks or linear runtime predictions. Initial laptop Intel Iris Xe had no supported NVIDIA GPU. Portable CPU package must not claim GPU acceleration tested.

Use temporary test libraries, never mutate user Data or Music library for tests. Backup whole library including library.sqlite3 to retain set lists and Undo history. No synchronization between separate copies, chart/score/MIDI or machines. Practice extras (looping, slowed playback, click-to-seek, auto-scroll) remain deferred per user; see ROADMAP.md.

## Running tests

Development build: .venv/Scripts/python.exe -m pytest -q; node --test tests/ui-core.test.mjs.
Portable build: runtime/python.exe -m pytest -q (pytest copied with app packages); Node is only required for development JS tests, not to run Chord Buddy.

Normal launch uses the user's Music/ChordBuddy. Portable launch uses Data beside the app. Do not run setup_app.py/setup_engine.py inside the portable bundle to "repair" it: those create machine-specific virtual environments. Rebuild deliberately if changing packaged dependencies.

## September 16 musical layout update

Measure-based charts and source-preserving lead-sheet engraving now support entirely manual word/phrase and syllable placement. Read docs/MUSICAL-LAYOUT.md for usage and export limitations. Optional chart.layout and ABC.engraving persist in existing revision history. Read-only music metadata derives from original rhythm annotations. No automatic lyrics. Verified 77 Python tests and 36 JavaScript tests using bundled runtime/FFmpeg and a copied library.

## October 12 Stems/shared-player implementation

The approved spec and nine-task plan are under docs/superpowers. Separation uses independent SQLite tables and immutable run artifacts; a final database transaction publishes a validated manifest. Runs use their final UUID directory name from creation, with database status serving as the staging boundary. No directory rename is needed for publication, avoiding an observed Windows directory lock failure. Failed/cancelled artifacts cannot be streamed.

Backend entry points: separation.py, separation_store.py, separation_audio.py, separation_recipe.py, separation_worker.py, inference_jobs.py and owned_process.py. Windows subprocess trees are assigned to a kill-on-close Job Object before execution. Cancellation waits for termination; transcription and separation share one gate.

Frontend: transport.js owns playback. pcm-session.js owns one 44.1 kHz AudioContext/worklet plus a fetch worker; pcm-mixer-core.js renders eight synchronized PCM tracks (original plus seven stems), bounded to ten seconds of queued audio. All tracks use one integer source cursor. Seek/run generation guards and a reset acknowledgement discard stale work. The graph performs common headroom scaling and short gain/mode ramps. Device conversion is browser-owned. Unavailable PCM playback falls back to the original recording.

Independent review is arranged by the parent task after handoff. See verification/stems/implementation-20261012/review.md, ledger.md and baseline.json. Backup: backups/stems-integration-20261012. User Data was not used for verification. Installed weights have unresolved licensing/provenance; no public-release or private-use clearance is asserted.

### Review fixes: publication, validity and inference recovery

New separation selection now freshly checks the source hash and compares the saved result with the currently validated recipe. Installed recipe inputs are checked for changes and their recipe is rebuilt when needed; large checkpoint hashes are cached between unchanged selections. PCM requests for an already pinned historical run retain the existing artifact cache and are not invalidated merely by a new recipe.

All fallible publication reads happen before the transaction that activates a separation; completed runs cannot be demoted by a late failure. Playback now preserves newer mode/Pause intent across deferred seek/resume operations. Transcription owns the shared gate before creating durable work and releases it only after terminal persistence succeeds. If persistence fails, new inference is blocked with an error asking for restart; startup recovery handles unfinished durable runs. Resolve the reported storage problem before restarting.

Independent review completed and its six findings were resolved. Final verification: 140 Python tests, 62 JavaScript tests, native deferred-control checks and full 379.205-second playback passed. See verification/stems/implementation-20261012/review-fixes.md for exact evidence and remaining limits.


### Unified analysis and rhythm implementation (October 12)

Current work: `docs/superpowers/specs/2026-10-11-unified-analysis-rhythm-design.md` and `docs/superpowers/plans/2026-10-11-unified-analysis-rhythm.md`. Backup: `backups/rhythm-integration-20261012`; ledger and evidence: `verification/rhythm/implementation-20261012`. No Git was initialized. The parent task arranges a fresh independent review of this feature; the earlier six-finding review above applies to the previous stems work only.

New backend responsibilities: analysis_contract/store/audio define provenance and cache validation; analysis.py owns durable parent jobs and serialized stages; timing_store provides immutable versions plus chart-history bindings; rhythm.py/worker generate deterministic CPU evidence; rhythm_apply validates policy-specific previews; chart_cleanup checks strict EOF provenance. Existing separate/transcribe APIs remain compatible and share the same inference gate. New APIs use `/api/songs/{id}/analyze`, `/api/analysis/{id}/cancel`, and `/api/documents/{id}/rhythm/*`, `/timing`, `/cleanup/*`.

Chart history includes timing-only changes when retaining edits during reanalysis. Bindings are companion rows keyed by document/history position; legacy edit-zero JSON is not rewritten. Legacy retained charts with unproven historical timing refuse correction rather than inherit another run's settings. Chord metadata operations inherit the current timing binding. User source audio, raw model outputs, ABC/MIDI and the player's clock are not retimed.

Correction uses installed NumPy/SciPy, a 1024-sample window and 220-sample hop, broader phase search, small global tempo alternatives, and local five-bar passages. Defaults require 0.8 onset coverage and 0.12 candidate margin, with ambiguous half-pulse phase and unsupported meter correspondence rejected. These thresholds are engineering settings exercised by synthetic fixtures, not calibrated accuracy probabilities or evidence of general superiority. Changes in detector code/settings invalidate only proposals. Space Unicorn is a 105-second pipeline/native fixture; original reference stems were not supplied.

The live database could be read as bytes but direct SQLite mode=ro opening failed. A journal-free copy, hash-matched before/after copying and passing integrity_check, supplied the Enjoy the Silence fixture. Only isolated copies were opened with writable Library. The exact 42.916667-ms tail was removed on that copy, with exact Undo/Redo and unchanged source hash. Windows file-lock teardown failures existed at baseline; the verification checker opts into retaining engine fixture directories, without suppressing test assertions or changing production behavior.

See the final review package for current counts, native timing observations, residual limits and all rulings. No public distribution/license clearance is asserted.

### Independent rhythm review follow-up

The independent review found eight reproducible preservation/correctness defects. Their dispositions, extended regression evidence, source inventory and native checks are recorded in `verification/rhythm/implementation-20261012/review-fixes.md`; the original reviewer artifacts remain unchanged. Current code freezes active legacy timing, snapshots previews coherently, selects source-matched caches, and publishes transcription state in one rollback-safe transaction. Unsupported drum bars remain unchanged and formatting uses recording-time correspondence. Rename/Merge require durable flush; rhythm admission follows application shutdown locking.

The muted/minimized slowdown was reproduced without stream starvation: the AudioContext itself lost about 43 seconds over a 148-second wall run. A zero-output automatic-pull worklet keeps the interactive context on its device clock during silence; browser scheduling flags tested alone did not fix it. Full evidence and the power/lifecycle tradeoff are in the follow-up report.

The earlier SQLite read-only failure is explained by sandbox denial of creating absent WAL/SHM sidecars. Fresh isolated WAL copies failed with SQLITE_CANTOPEN under restricted execution, succeeded with normal permissions, then succeeded restricted once sidecars existed. DELETE-journal and immutable snapshots passed. Normal plain-path copied-library access passed. Live Data was never initialized/migrated by these diagnostics; production-root writable startup is still not claimed. See `sqlite-diagnosis.md` beside the follow-up report.

### October 12 simplified playback readiness

The approved policy gates both player UI and Transport actions until /api/playback/<song> validates a complete durable analysis bundle (source, separation, transcription, chart), fresh source hash, referenced artifact hashes and current separation recipe. Completion status alone cannot unlock playback. PlaybackReadiness caches artifact validation by manifest digest and file metadata using the existing validator; source identity is checked fresh. Previous completed bundles remain eligible after invalidation/retry failure; invalidation requests recomputation and does not delete prior evidence.

PlaybackGate rejects stale selection/request responses and blocks synchronously before Analyze admission. Ready selects Stems initially, enables the mixer without an adoption button, and never autoplays. PCM is prepared lazily on Play or explicit source selection; there is no new live replacement protocol. Reanalysis disposes the PCM session, pauses and preserves position/mix/mode, then restores readiness in the paused state. Original remains a comparison source after readiness. Legacy analyses without full provenance require Analyze. No raw artifact access restriction or model change is introduced.

Verification: 213 Python tests, 80 JavaScript tests, and a muted native WebView2 check on a fresh copy of the existing Space Unicorn test library passed. Native verification covered saved readiness, no adoption button, tab continuity, cache-only Analyze with inference entry points forbidden, paused restoration, prior result after failure, and initial unavailable controls/actions. First native attempt exposed only a missing set-list membership in the newly seeded test fixture; evidence is retained. No live Data initialization/migration or new inference was run. Details: verification/playback-ready-20261012/report.md. Backup: backups/playback-ready-20261012.

### Independent review P2 disposition (playback readiness)

The review reproduced a regression after successful PCM priming: selecting Original following a stem-stream error changed the label but left the failed PCM session active. The correction routes this error state through the existing Original fallback, disposes PCM, clears obsolete pending handoff state, and preserves position, master/mix and current Play/Pause intent. Healthy inactive Original selection stays lightweight and analysis readiness remains mandatory.

Two post-prime recovery tests first failed, then passed for both playing and paused intent. Full regression after the fix: 213 Python tests (26.13 s), 82 JavaScript tests, no failures/skips. Native error-path evidence and exact limits are recorded in verification/playback-ready-20261012/review-fix.md. Review snapshot backup: backups/playback-ready-review-fix-20261012. No new independent review was requested.

### October 12 user-reported Access Denied recovery

Live read-only job/log inspection found Enjoy retry `ccaabaa4d0c5433eb78343b855af3df3` / transcription `edb22fc9c27e` failed at confidence.py's second confidence.json atomic replacement after both model windows and notation export. Earlier active transcription `d04561515f63` and validated separation `a1d91a80f48844b9aef5b3e4366a4d2f` remained. Gate strictness had unnecessarily required a new unified job for this existing song. No SQLite failure occurred in that worker trace; the process denying the file replacement is unidentified.

Confidence writes now skip identical bytes, retry transient Windows replacement denials briefly, preserve old metadata/exported outputs on exhaustion, and retain the original notation exception if failure-metadata writing also fails. The normal unfiltered path no longer needlessly replaces the unchanged sidecar. Playback readiness now also accepts an existing completed run with readable saved chart and freshly source/recipe/artifact-validated stems. Known contrary transcription provenance still rejects; this read-only compatibility path does not certify legacy rhythm evidence. UI distinguishes a failed latest analysis from losing the saved chart and explains preserved results.

Also reproduced the earlier Space partial-analysis savepoint error: SeparationStore initialization used executescript within nested cleanup transactions, implicitly committing their savepoint. Schema statements now use execute inside the existing transaction; nested rollback test passes. No schema shape or live migration was introduced.

Evidence: verification/access-denied-20261012/report.md. 221 Python / 84 JS tests pass; native verification on a copy of the actual Enjoy state plays its existing stems without Analyze and preserves document/history/timing hashes. No inference or live Data writes. Close/reopen the normal app to load updated backend; Enjoy does not need Analyze for playback. Backup: backups/access-denied-20261012.

### October 12 compact chart implementation — awaiting fresh review

Approved design/plan: docs/superpowers/specs/2026-10-12-compact-chart-design.md and docs/superpowers/plans/2026-10-12-compact-chart.md. Reading-first view is integrated with pure occurrence mapping, strict harmonic/rhythmic folding, visible lyric anchors, explicit pass selection, shared-transport Jump here, revision/draft protection and atomic one/all-pass edits. Per-pass edits preserve original repeat phrase boundaries through validated layout preferences. Partial/unknown/ambiguous material expands conservatively; there is no quantization, inference or canonical compression.

New modules: web/compact-chart.js, compact-actions.js, compact-view.js, compact_layout.py. Existing chart validation/timing remapping handle optional version-1 compact preferences (including an informational `notice` after timing invalidation). chart-view exports draft collection/acknowledgment; app flush includes unblurred line/slot drafts and refuses to silently close an unfinished modal editor. Existing transport and document endpoints/store are reused; no database schema or model changes.

Scoped source backup: backups/compact-chart-implementation-20261012. The complete prechange checkpoint backups/checkpoint-20261012T111153Z-pre-compact-chart remains untouched. Evidence/diff/baseline: verification/compact-chart/implementation-20261012. Current full results are recorded in report.md; earlier Windows temp-cleanup failures are retained, and the existing CHORDBUDDY_RETAIN_TEST_ARTIFACTS option was used without engine changes. Native tests use copied Space Unicorn artifacts and a separately saved synthetic timing fixture, with inference forbidden. Real-chart capture additionally preserves all 84 canonical chord IDs and saved document/history fingerprints. Never infer that the synthetic showcase is a transcription-quality benchmark.

Next: parent arranges a fresh independent reviewer. No review-completed claim, live Data test, production restart, migration, restore or public release has occurred for this change. Review report.md/changes.patch and keep reproduction libraries isolated.

### User-approved permanent generated-stem retention

User authorized permanent deletion of obsolete generated stems while keeping source audio. The enabled stem_retention.py policy replaces the earlier disabled recycle protocol. It requires an explicit song, valid published replacement and playback readiness pointing to that replacement, with fresh source/asset checks and per-song -> verification -> library locking. Only manifest-bound exact seven stem WAVs plus guitar.wav are unlinked. Source MP3, decoded original.wav, metadata/history and caches remain. Exact plans are atomically persisted with fsync before deletion; purging/purged statuses and journal reconciliation handle process interruption. No schema change. No automatic startup sweep: reconciliation occurs during a later successful completion hook. No production Recycle Bin adapter is involved.

Fresh independent review accepted; normal default-enabled focused/adjacent tests: 40 passed. See verification/export-reliability/implementation-20261012/permanent-retention-final.md. Earlier normal whole-suite Windows temporary-folder teardown limitation is unchanged; no new whole-suite claim. No live retention invocation or QA cleanup was done for this feature. Live library previously had one set/song; sole-set path performs no writes. QA deletion remains recoverable-only and paused awaiting closed-window confirmation; denied CIM query must not be bypassed. Tiny Recycle Bin probe evidence remains separate.

### Latest continuation: approved bounded short-path implementation complete

The current short-path implementation and fresh evidence supersede stale "proposed/not implemented" path-layout summaries. See `qa/sp/REPORT.md` and `qa/sp/review.md`. New song folders are ID-only; existing folders and Data are not migrated/reset. Keep the existing single checkpoint; no new backup was created. Use short `qa/<id>/lib` (or equally short fixture roots) and profiles for further tests. The wrapper `runtime/python.exe -B qa/sp/pytest_run.py tests -q --basetemp=qa/<fresh-id> -p no:cacheprovider` provides short per-test IDs and project-local temp. Always choose a fresh basetemp to avoid pytest recursively cleaning earlier evidence.

Fresh independent review accepted the final fixes; separation_recipe.py is byte-identical to its prechange baseline, maintaining saved recipe identity. Source preparation's adapter hash changed; an explicit future Analyze may refresh its prepared source cache, without invalidating saved playback on opening. Normal full Python run had four Windows temporary-directory cleanup failures after behavior checks; the explicitly retained-fixture full run passed 283 tests. JavaScript146 passed, native final passed with actual FFmpeg and Librosa cache writes, no inference. Neither the idle task nor a production app was restarted. Data/source/checkpoint-manifest preservation checks are in the report.
