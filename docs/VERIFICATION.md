# Verification — 15 September 2026

## Section and lyric chart update

- Full Python suite: 62 passed, two model-cache tests skipped in the lightweight app environment (model runtime unchanged).
- JavaScript suite: 15 passed; application syntax check passed. Includes protection against new edits being overwritten by a delayed Undo/Redo response.
- Scoped independent review approved the history fix, legacy migration fix, shared boundary edits and inline controls; no remaining important findings.
- Browser verified: normalized slash-bass labels, section grouping, pasted lyric lines, chord placement above a word, Undo/Redo of placement, persistence after reopening, title autosave, local section editing panel, and shared section boundary adjustment.
- Model originals and previous ABC/MIDI edits remain intact; legacy libraries receive a new chart once when opened. A review regression involving unusually long existing chord labels was fixed and tested.
- The test browser again crashed when its native audio Play control was clicked. Moving playback highlighting has not been visually reverified; static initial highlighting and time-boundary helper checks are covered. The user's running desktop app was not restarted, and the Music library was not used for development tests.

## Passed

- App suite: 33 passed. Two cache tests skip in the lightweight app environment and both pass separately in the engine environment.
- JavaScript editor suite: 8 passed; application syntax check passed.
- Real SheetSage2 CPU inference on a generated 12-second musical MP3: lead sheet, MIDI and timed annotations produced, no notation error. Reported inference time 155.53 seconds, excluding model loading.
- Browser checks: metadata import, set-list creation, score rendering, chord correction, MIDI pitch correction, independent Undo/Redo and actual transcription output tabs.
- Native Windows launch: Chord Buddy window process was responsive, with no startup errors logged. Used an isolated test library.

## Limits of verification

- NVIDIA inference was not tested; this machine has Intel Iris Xe and uses the installed CPU engine.
- Final browser automation crashed before the title debounce and moving playback highlight could be rechecked. Title persistence at the API level and chord timing boundaries are verified; those final interactive checks remain outstanding.
- Native window interactions and close/save behavior have automated boundary tests, but have not been manually exercised in the native window.
- All verification used workspace test libraries. The normal launcher selects the requested Music/ChordBuddy folder; that production folder was not populated during testing.
- Component reviews were completed; a final separate whole-app review was interrupted by usage limits.

This is a runnable development build, with no signed installer yet. Practice additions remain in ROADMAP.md.

## Portable Windows package

- Full Python suite: 68 passed, two cache tests skipped in the lightweight app environment. After portable status wording changes, all 15 engine/portable tests passed.
- Bundled Python startup/readiness passed with PATH limited to Windows system directories and no PYTHONHOME/PYTHONPATH. Python, Torch 2.8.0+cpu, Torchaudio, Transformers, app packages and FFmpeg resolved from the bundle.
- Renamed the actual package to a different folder containing spaces. All Python import paths stayed inside that moved bundle; its HTTP app/state endpoint returned success using an isolated test library.
- The relocated package completed a real 12-second MP3 CPU transcription with Hugging Face/Transformers offline mode enabled. Produced score.abc, MIDI and timed annotations; 24 melody notes, no ABC error. The test used bundled tools/model caches with installed Python/FFmpeg excluded from PATH.
- Restored the final ChordBuddy-Portable folder name. Approximately 6.3 GiB before songs. Data is empty; the user's Music library was not copied or modified.
- Not tested on a second physical computer. The packaged native window was not separately exercised; WebView2/.NET remain OS prerequisites, with the documented browser launcher as fallback. CPU only in this bundle; no GPU acceleration claim.

## Compact chart verification — October 12, current local build

This entry records the current compact-chart work; older sections above describe their historical environments and limits.

- Baseline: 221 Python / 84 JavaScript tests. Final integration evidence is under `verification/compact-chart/implementation-20261012`; see report.md for exact latest commands, counts and hashes.
- Synthetic cases verify unequal-duration exact passes, distinct rhythm/labels/holds, gaps, pickups/tails, section fragments, malformed preferences, real-time occurrence mapping, scoped edits, draft ownership, save conflicts, Undo/Redo and saved timing bindings. Full tests run with project-local temporary paths and the existing engine-test artifact-retention switch to avoid Windows cleanup locks.
- Real WebView2 checks exercise explicit keyboard pass choice, Escape/focus return, Original and Stems navigation, preserved Play/Pause/mix, atomic all-pass Undo, open-editor close protection, failed-save recovery and unblurred multi-line drafts. All native UI writes target a fresh copied test library. Analysis/inference entry points fail loudly if called.
- Separate actual saved-chart capture uses an unchanged copy of the pre-existing Space Unicorn test chart (including prior QA edits). Its 84 canonical chord IDs remain represented and saved document/edit/history/timing fingerprints match before/after. This is actual repeat detection against saved data, not a new transcription or listening-quality benchmark.
- App-only screenshots were visually inspected against the three UserExamples: section hierarchy and compact progressions, visible separate lyric lines/anchors, explicit count/variation, and no chord diagrams. Narrow layouts retain 44px controls and vertical scrolling. This is not a complete accessibility certification, full-duration clock retest, second-machine test or public-release clearance.
- Live Data was not opened or written by the test app; no independent concurrent-write audit of that folder was performed. The source fixture and checkpoint metadata preservation checks are recorded. Fresh independent review remains pending.
