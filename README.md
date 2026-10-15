# Chord Buddy

A Windows desktop workspace for turning recordings into editable lead sheets and MIDI with SheetSage2. This is the first working development build for personal use.

## Set up on a new Windows computer

Double-click **InstallWindowsDependencies.cmd**. It installs everything Chord Buddy needs into this folder only (its own Python, PyTorch, the window and audio libraries, ffmpeg, and the stem separation models, each download checked against a fingerprint), then you start the app as below. It is safe to run again, and it needs a few GB of free space and an internet connection the first time. Add `--device cpu` to skip the NVIDIA GPU build of PyTorch, `--skip-models` to download the stem models later from the app's first-run panel, or `--hf-login` to save a Hugging Face token and fetch the SheetSage2 transcription model (it is gated: your Hugging Face account needs access to `m-a-p/SheetSage2` and `m-a-p/MERT-v2-FullSong`). Keep the folder path short (under about 100 characters).

## Open the app

Double-click **Start Chord Buddy.cmd** in this folder. The application and CPU transcription environments are already installed on this computer, and the pinned model weights are downloaded.

1. Drop an MP3 into the window, or select **Import MP3**.
2. Review the song title. Title metadata takes precedence; otherwise the file name is used. You can change the title.
3. Every song goes into **Default**. Create additional set lists with **+**, add songs using the set-list selector, and reorder with the drag handle or arrows.
4. Select **Transcribe song**. Automatic uses a compatible NVIDIA GPU when the CUDA engine is installed, otherwise CPU. **CPU only** overrides GPU use.
5. Each output appears in a tab. Play the original recording using the player below; the current chord is highlighted.

## Editing

### Song chart: sections, lyrics and chords

After restarting Chord Buddy, open an already transcribed song: **Song chart** is the first tab. It is built from the existing transcription, so no new model run is needed. Adjacent model sections with the same name are combined. You can correct section names and timing, split a section, or merge it with the next one.

Open a section's editing controls to type or paste your own lyrics, keeping one lyric line per line of text. Select a chord and click a word in that section to place the chord above it. Chord placement is independent of playback timing. Sections without lyrics remain useful as chord charts. Chord timing and labels have their own editing controls.

Changing a lyric line returns its placed chords to the section's unplaced chords, so they never silently move onto the wrong words. Place them again when the line is finished, or Undo to restore the earlier text and placement.

The chart has its own persistent Undo/Redo and JSON download. It starts from the available chord labels, then stays independent of the score, MIDI and original annotation files. Retranscribing creates a new run and a new chart; earlier run files and edit history remain stored. Lyrics are entered manually, not recognized from the recording.

Slash chords use named bass notes in the chart: for example, the raw model label `G#:min7/b7` appears as `G#m7/F#`. Raw annotation tabs retain the model's original spelling.

### Score and MIDI

- **Lead sheet:** select a linked chord on the rendered score and enter a correction such as `Gm` or `Cmaj7`. **Edit ABC notation** exposes the underlying score for broader notation changes. The old wall of chord tiles has been replaced by the Song chart tab.
- **MIDI:** select a note on the timeline and change pitch, start, end, or velocity. Use **Add note** and **Delete** as needed. Pitch values are MIDI numbers; note names appear on the timeline.
- **Undo / Redo** apply to the selected file and survive reopening. **Restore original** is itself undoable.
- Changes save automatically. **Download** exports the selected file, and **Folder** opens the song's folder.
- Each output remains independent. A lead-sheet correction does not change the MIDI. Large structural ABC edits can remove reliable timing links; those chord chips remain visible but cannot be edited by label until alignment is restored.

## Your Music folder

The normal launcher saves to `%USERPROFILE%\Music\ChordBuddy\`.

Each song gets its own folder with a short unique identifier. It contains a copy of the original MP3 and a `runs` folder. Retranscribing creates a new run. Original outputs remain intact; autosaved editable files go in each run's `edited` subfolder. `library.sqlite3` stores song/set-list information and edit history. Back up the whole ChordBuddy folder to retain Undo history as well as audio and outputs. Renaming a song updates its library title; its existing folder stays stable.

## Current verification and limits

- Real pinned SheetSage2 inference was tested on this computer's CPU with a generated 12-second musical recording. It produced a lead sheet, MIDI outputs, and timed annotations; inference reported 155.53 seconds, excluding model loading. This is an integration check, not an accuracy benchmark for full songs.
- This computer has Intel Iris Xe graphics. The installed engine is CPU-only. NVIDIA acceleration is implemented but has not been tested here.
- Chord correction, MIDI note correction, independent Undo/Redo, MP3 metadata import, file export, and persistent history are covered by automated tests. Browser smoke checks exercised import, score display, corrections, and Undo/Redo.
- Graphical chord and MIDI editing are available. Broader score editing currently uses ABC text; this is not yet a full engraving editor.
- Practice tools (looping, slow playback, click-to-jump, auto-scroll) are deferred in [ROADMAP.md](ROADMAP.md).
- This is source plus local environments, not a signed standalone installer. Python 3.11, FFmpeg, and Microsoft WebView2 are required. The tested machine already has them.

## Setup on another machine

Install Python 3.11, FFmpeg (on PATH), and Microsoft WebView2. Run `py -3.11 setup_app.py`, then `py -3.11 setup_engine.py --device cpu --download`. On a compatible NVIDIA machine, use `--device cuda` to install CUDA 12.6 wheels. Setup downloads several gigabytes and stores its caches under this project, without changing system Python. Model files are public at the pinned revision; authentication is only needed if upstream access rules change.

For development, run `.venv\Scripts\python.exe -m chordbuddy --browser` to use a browser window. `--library PATH` selects an isolated test library. Python tests use pytest in the app environment; `node --test tests/ui-core.test.mjs` runs UI helper tests. Cache compatibility tests run in the inference environment using `python -m unittest discover -s tests -p test_model_cache.py`.

## Credits and model license

SheetSage2: <https://huggingface.co/m-a-p/SheetSage2>, revision `7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384`. It loads its pinned MERT-v2-FullSong parent. Both model weight licenses are **CC BY-NC 4.0**; this build is for personal noncommercial experimentation. Check with the model authors before use connected to commercial work or a commercial product.

Score rendering uses abcjs 6.5.2 (MIT), with its license in `chordbuddy/web/vendor/abcjs-LICENSE.md`. Other dependencies keep their upstream licenses. Model code is loaded from the pinned official repository; no generated/fake output fallback is used.

## Stems and shared playback (Ada integration, October 12)

The top-level Chord Chart and Stems tabs share one pinned player. Import/select a song, choose Analyze song from either Chord Chart or Stems. The installed fixed chain produces Bass, Drums, Other, Vocals, Piano, Lead guitar and Rhythm guitar. Rhythm guitar is the residual Guitar minus Lead; it is not a separately validated rhythm performance. Lead/backing vocal separation is not implemented.

Use Original/Stems in the player to compare at the same position. Each stem has volume, mute and solo controls; multiple solos are allowed and mute wins. Master volume affects either listening source. Mix settings and playback survive switching tabs during the song session. Looping, time stretch and pitch changes remain deferred.

Separation and transcription share one inference slot. Cancel targets the current job; an unsuccessful rerun preserves the last successful separation. Source hashes, recipe hashes and artifact validation determine whether saved stems are usable. Interrupted work is marked interrupted on startup. Large float WAV artifacts remain in the library; storage cleanup and compressed export are not included.

This integration uses only the already-installed BS-RoFormer SW and lead-guitar specialist chain under stem-separation-tests/models, with no downloader or model picker. The model environments are machine-specific; this is not a redistributable portable release. Weight provenance and license clearance remain unresolved. Free distribution and private use are not automatically authorized by a public download or by these tests. Do not distribute the weights or represent this integration as cleared for release.

Verification evidence and exact limits are recorded in verification/stems/implementation-20261012/review.md. Earlier hardware/test statements above describe the original laptop build, not this Ada integration.

### Review fixes: publication, validity and inference recovery

New separation selection now freshly checks the source hash and compares the saved result with the currently validated recipe. Installed recipe inputs are checked for changes and their recipe is rebuilt when needed; large checkpoint hashes are cached between unchanged selections. PCM requests for an already pinned historical run retain the existing artifact cache and are not invalidated merely by a new recipe.

All fallible publication reads happen before the transaction that activates a separation; completed runs cannot be demoted by a late failure. Playback now preserves newer mode/Pause intent across deferred seek/resume operations. Transcription owns the shared gate before creating durable work and releases it only after terminal persistence succeeds. If persistence fails, new inference is blocked with an error asking for restart; startup recovery handles unfinished durable runs. Resolve the reported storage problem before restarting.

Independent review completed and its six findings were resolved. Final verification: 140 Python tests, 62 JavaScript tests, native deferred-control checks and full 379.205-second playback passed. See verification/stems/implementation-20261012/review-fixes.md for exact evidence and remaining limits.


## Unified analysis and optional rhythm correction

Analyze song prepares a chart and the fixed practice stems. Analyze again checks independent source, separation, transcription and chart caches; it runs only missing or invalid stages. Reanalyze stage explicitly recomputes separation or transcription. Existing edited charts remain available with their own timing and history. Older transcriptions without source-bound manifests stay readable but may need one new analysis before drum correction is available.

Drum-based rhythm correction is a separate action for a selected Song chart. It computes a proposal, then changes to Review rhythm proposal. Review the timing shifts and unresolved passages before applying. Analyze never applies correction automatically. Drum onsets provide evidence, not a guaranteed beat/downbeat reference: weak or competing evidence stays unresolved. The deterministic global/local search retains known meter and does not snap chords, retime notes, change playback speed or rewrite ABC/MIDI.

When manual rhythm overrides exist, the choices are Clear all user changes, Apply corrected timing to user changes, and Cancel. **Clear affects rhythm overrides only.** Chord names and recording times, lyrics, section names/boundaries, notes and other edits remain. Preserve keeps compatible tempo/barline intent; incompatible constraints or anchor mappings block the whole edit. Correction and chart timing settings participate in chart Undo/Redo together. A stale preview must be refreshed after intervening edits.

Each section exposes Rename section, Merge with previous and Merge with next. Merges keep the earlier name/identity and all contents. A gap requires explicit acceptance. Check empty end artifact offers an undoable cleanup only when an unchanged, empty generated tail is proven to come from container-versus-decoded EOF mismatch; legitimate short sections remain.

All inference and correction jobs share one admission slot. Cancel waits for owned work to stop; completed stage caches remain reusable. Terminal persistence failure blocks further work until storage is repaired and the app restarted. No automatic model retry, checkpoint download or public-release clearance is added by this feature. GPU transcription uses the same 4-GiB allocation ceiling and 5-GiB free-memory admission requirement as separation.

### Independent review corrections

Timing previews now capture content and revision together. Existing legacy timing is frozen before a run is retained; an unproven older history position is labelled unresolved. Chord confirmation validates each chart's bound grid, and ordinary chart edits remain available when the source MP3 is temporarily unavailable. Timing correction still requires fresh source validation. Formatting maps through recording-time bar anchors; ambiguous mappings block application. Both global and local drum proposals leave unsupported bars unresolved.

Cached analysis selects the matching source's transcription and stems while retaining edited charts. Transcription artifacts, stage publication and active selection commit together, with rollback on failure or cancellation. Rename and Merge wait for pending edits to save before creating their separate history action.

The stem session includes a silent, zero-output clock worklet to keep minimized muted playback on the device clock. It emits no sound and performs no recording. This keeps real-time audio callbacks active for the session, including silence, until the session is disposed; it can use more power than the browser's silent timer path. See `verification/rhythm/implementation-20261012/review-fixes.md` for the controlled comparison, final verification and remaining limits.

### Playback waits for analysis

Playback and the seven mixer rows remain disabled until saved results validate. A complete source-bound Analyze bundle qualifies, as does an existing completed transcription with its saved chart and freshly validated published stems. Older charts do not need new inference merely to unlock their already-valid audio. Otherwise choose Analyze song. Stems is selected automatically the first time a song becomes ready, with no adoption button and no autoplay. Original remains available for comparison.

Analyze again pauses playback and keeps the position, mix and listening-source choice. Playback remains disabled while analysis runs. On completion it becomes available but stays paused. Failed, canceled or partial retries restore access to the previous complete result only if it still validates; first-time failures remain disabled. This compatibility path does not create new provenance or enable source-sensitive rhythm correction; known conflicting source evidence still blocks readiness. Existing artifacts and edited charts are retained.

## Compact practice chart (October 12)

The Song chart opens in a reading view: section progressions, existing lyrics and exact repeat counts. `×4` means four total recorded passes, not a playback loop. Folding requires matching harmony and beat-relative rhythm; different endings, pickups, uncertain gaps and partial tails remain written out. Real saved timestamps and all original chord events are retained.

Use **Jump here** to move the shared player. A folded phrase asks which recorded pass to use. Paused stays paused; playing continues, preserving the current Original/Stems choice and mix, subject to the existing stream-error fallback. Navigation remains disabled when analysis readiness is unavailable. Clicking chord text edits it; it does not seek.

A repeated chord edit defaults to one explicitly chosen occurrence. **All matching passes** is a separate scope with a target list and one Undo step. Timing edits remain occurrence-specific in **Expand timing**. **Write out** saves an expanded layout preference; **Reset compact layout** returns to automatic grouping. Viewing/temporarily expanding a section does not change music or history. The save path retains drafts on failure and blocks dependent actions until they save.

Existing words and manual anchors remain visible. Edit words changes the selected lyric line; changed words clear that line's placements, as before, and Undo restores them. Matching-pass lyric edits are available only when existing anchors establish the correspondence; ambiguous or unplaced text is edited as ordinary section text. No automatic lyrics or invented word timing is added. **Edit section** and **Expand timing** retain the detailed tools.

The current UI previews and their synthetic-versus-saved-chart labels are in `docs/UI Previews`. Verification and known limits are recorded in `verification/compact-chart/implementation-20261012/report.md`. Independent review is pending. Model choices, licensing limitations and fixed-stem behavior are unchanged.

## Latest successful practice stems

After a replacement analysis fully succeeds and its saved playback validates, Chord Buddy permanently removes superseded generated stem audio for that song. It keeps the current Bass, Drums, Other, Vocals, Piano, Lead guitar and Rhythm guitar set. An incomplete or failed replacement keeps the previous usable stems.

The original source MP3, decoded Original WAVs, charts, edit history, manifests and logs are retained. Cleanup removes only the seven obsolete stem WAVs and their guitar intermediate; it does not remove whole song/run folders. A locked or changed file stops cleanup and reports a warning. Interrupted cleanup can resume after a later successful validated analysis. This policy does not authorize permanent removal of QA copies, backups, models or runtime files.

## Bounded portable paths (October 12)

New imports use `Data/<12-character song ID>/source.mp3`; titles remain in SQLite. Existing folders are read in place. Transcription IDs stay 12 characters, and separation/analysis IDs stay 32. New folders are claimed exclusively with bounded collision retries.

Import and analysis check the deepest generated paths against a 240 UTF-16-unit budget, using resolved library/installation roots and temporary, cache, and export suffixes. If a path is too long, the error gives the minimum shortening needed before any new song/job work begins. Close the app and move the whole portable folder to a shorter location; no migration or reset is performed automatically. New worker caches use short `c/<letter>` child directories. The original separation recipe identity is preserved, so this cache layout change does not invalidate saved playback.

Fresh evidence and precise native/Windows-test limits: `qa/sp/REPORT.md`. QA libraries and profiles use short project-local paths and generated sub-second audio, with no copied user recordings or model inference.

## License

Chord Buddy's own code is released under the MIT License (`LICENSE`). The models and software it downloads have their own licenses; several are non-commercial or still unconfirmed, so please treat Chord Buddy as a free, non-commercial tool. See `THIRD-PARTY-NOTICES.md` and `docs/MODEL-ATTRIBUTION.md`.
