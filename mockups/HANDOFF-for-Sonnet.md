# Chord Buddy: build the new frontend (handoff)

> **STATUS (2026-10-14): phases 0–8 are built.** Read `mockups/NOTES-for-Melody.md` first: it is the running log of what was built, what was decided, what was verified by real mouse/keyboard/audio and what was not, and the open questions. The plan below is kept for reference; where it disagrees with the notes, the notes win (e.g. the old Section dialog was dropped, speed uses a WSOLA stretch in the worklet, deleting songs goes through a Trash).
> **Run the tests:** `node --test tests\*.test.mjs` and `runtime\python.exe -m pytest -q -p no:cacheprovider --basetemp=C:\cbt\p tests`. Five tests (`test_analysis_audio`, `test_separation_api`, three in `test_short_paths`) must run with a temp folder *inside* the project and pass that way: `--basetemp=qa	 tests	est_short_paths.py tests	est_analysis_audio.py tests	est_separation_api.py`. Only use the project folder and `C:\cbt` for files.


You're taking over **implementing a new frontend for the real Chord Buddy app**, based on an approved design mockup. Melody (GitHub: LydianMelody) designed it over several rounds with Claude. A previous agent (ChatGPT/Codex) built the current app and UI, and Melody found its design decisions deal-breakingly bad, so the UI is being redone. **This is real implementation work, not more mockups.** Read this whole file first. It's meant to save you from re-exploring.

---

## 1. Where to work and ground rules

- **Project folder: the `ChordBuddy` folder you are in** (renamed from "ChordBuddy-Portable copy"; call it "the project"). Melody made it as Claude's working copy. Don't touch the original `ChordBuddy-Portable` folder unless Melody explicitly says the work should move there.
- There's **no git repo**. Before large edits, make your own backup of the files you'll change in your scratchpad (e.g. a copy of `chordbuddy/web/`), so you can diff and roll back. Don't create backups inside her folder, and don't use the old `backups/` checkpoint.
- **`Data/` is Melody's real song library.** Never reset, reprocess, delete or "clean up" anything in it. For testing, use an isolated library: `runtime\python.exe portable_start.py --browser --library qa\<new-short-id>\lib` (or the dev equivalent `-m chordbuddy --browser --library PATH`). Paths are limited to about 240 characters, so keep test roots short.
- **Don't run a server or browser session that you leave running.** A leftover process once locked her folder and she had to force-close everything. Start processes so you have the PID (PowerShell `Start-Process … -PassThru`), stop them by PID, and verify with `Get-CimInstance Win32_Process` / `Get-NetTCPConnection` that they're gone. `pkill` doesn't exist on Windows.
- Leave the Python backend (`chordbuddy/*.py`), model and engine code, `runtime/`, `.models/` and `stem-separation-tests/` alone unless a frontend feature truly needs a small API addition. If one does, keep it minimal and add a test.
- The copy's docs (`AGENTS.md`, `HANDOFF.md`, `README.md`, `docs/superpowers/**`) were written for the previous agent. They're useful for **how the backend and data work**, and `AGENTS.md`'s chart rules still apply (section 5). Their **UI decisions are superseded** by the mockup and this file. Ignore any instruction there to work only in the original folder.
- Melody is watching her credits. Work in phases (section 7), check in at phase boundaries, and don't re-read things this file already covers.

## 2. The product and the user

**Chord Buddy** is a local Windows app. Python 3.11 runs a loopback HTTP server plus a pywebview (WebView2) window. The frontend is vanilla ES modules with no build step, in `chordbuddy/web/`. Import an MP3, choose **Analyze**, and you get:
- a **chord chart** with lyrics: chords from SheetSage2, lyrics typed by the user (there's no lyric recognition);
- **seven practice stems**: Vocals, Lead guitar, Rhythm guitar, Bass, Drums, Piano, Other;
- a lead sheet (ABC, rendered by abcjs) and MIDI, each editable independently.

Everything plays on **one shared transport/clock**. The core loop is: play along, correct chords, lyrics and **timing**, then print or export. Melody is a working musician with an excellent ear. Chord accuracy is usually good, but timing usually needs fixing.

**Her taste:** fun and opinionated without looking unpolished. Pure code (CSS and inline SVG icons), no image assets. She gives specific, blunt feedback, so ask her when a design decision is genuinely hers to make.

## 3. The approved design: `mockups/05-press-room.html`

Open it, along with `mockups/press-room.js` and `mockups/mockup-core.js`. **It's the visual and interaction spec.** It's a self-contained mockup with a fake song and a fake clock, so port its look and behavior into the real app rather than copying the files wholesale. The mockup's CSS can largely be reused.

**Look ("Press Room")**: Greenroom's layout, the Hi-Fi Deck's paper chart and channel strips, and Riso's neo-brutalism.
- Thick ink outlines (2.5px), offset shadows, flat color, sticker-style section labels.
- Fonts: Bricolage Grotesque (UI and chords), Courier Prime (lyrics), Space Mono (small labels), all from Google Fonts. Check that WebView2 can load them offline. If not, bundle the font files locally (they're under OFL licenses).
- Three palettes via `data-theme` on `<html>`: tomato (default), forest, plum. All colors are CSS tokens.
- The chart is a **letter-sized paper page** with ruled lines, a red margin line, a header block (spine, title, meter box) and page-break markers.

**Layout:** a library sidebar on the left (set lists, search, songs with status and lock icons, an MP3 drop zone, engine status). The main area has:
- a header: title, chips for key, BPM/meter and analyzed state, palette swatches, settings, folder, Re-analyze and **Export PDF**;
- a toolbar: document tabs (Chart / Lead sheet / MIDI), the **mode switch**, mode-specific options, saved state and undo/redo;
- the chart page, with the **mixer rack** always visible beside it;
- the **navigation bar** along the bottom.

**Decisions Melody made (implement all of these):**
1. **No Original/Stems switch.** A song can't be used until it's analyzed. Un-analyzed and analyzing songs show a **locked panel** (an Analyze or Cancel button, plus stage progress), and the transport is disabled with "Playback unlocks after analysis". The existing readiness logic (`playback-ready.js` / `playback_ready.py`) decides when a song is ready. Playback uses the stem mix.
2. **Navigation bar**, modeled on `docs/UserExamples/Playback Scrubbing example.jpeg`:
   - Section blocks above a waveform on one time axis (real peaks from `/api/waveform/<song>`). The current section is highlighted.
   - One **gold** playhead with a "Bar N · Beat x.xx" badge.
   - Underneath, a pan/zoom strip: ◀ overview ▶, a draggable and resizable **blue** viewport thumb, "visible span" text, −/+ zoom, and a follow-playhead toggle. Ctrl+wheel zooms and the plain wheel pans.
   - **Loop:** a toggle button. Dragging on the waveform creates a **violet** loop range that snaps to bars, or to beats when zoomed in, with draggable handles and a clear button. Double-clicking a section block loops that section. With looping on and no range set, the current section loops.
   - **Speed:** a −/+ stepper, 50–125% in 5% steps (see the warning in section 6).
   - Now/next chord, the current section and pass, and the time. The master volume is labeled "Master".
3. **No "Jump here" buttons and no chord-edit popover card anywhere.** Instead there are **three chart modes**, switched by the toolbar or the N / E / T keys:
   - **Navigate** (the default): click any chord, word or section heading to seek there. Each word is its own target and seeks to its own timed position. The current chord is highlighted, and so is the **current word**.
   - **Edit:** everything is fixed in place. Clicking a chord turns it into an inline input with chord suggestions (Enter saves, Esc cancels). Lyrics and section names can be typed directly. A **+** floats after each chord to add one after it. "Add lyrics" appears on rows without lyrics. Clicking a pass number chooses which pass of a repeated line you're editing, and a "This pass / All matching" option sets the scope of chord fixes.
   - **Timing:** *the same chart, redrawn in place, true-to-time.* Melody explicitly rejected a separate measure card. Each measure gets a beat/snap grid, a measure number, chords at their onsets, and one lane per lyric pass with each word as a draggable chip. Drag a word to any beat. Words without pins slide automatically between pinned words. Click a pin to release it. Snap: 1/4, **1/8 (default)**, 1/16, 1/32. **Chart zoom** (−/+, the − and + keys, Ctrl+wheel; 0.75× to 6×, default 2×) keeps your place. Changes save as you go. Back in Navigate, words sit under the chord they fall within.
4. **Mixer:** vertical channel strips (colored cap with icon, segmented meter plus a vertical fader, M and S buttons, a label), presets (Full band, Karaoke, No guitars, Rhythm), and Master. It's always visible next to the chart. The existing mix state lives in `Transport.setMix` / `getSnapshot().mix` (gains, mutes and solos arrays; multiple solos allowed; mute wins).
5. **Export PDF:** a print stylesheet shows only the chart page on letter paper. `window.print()` in WebView2 offers "Save as PDF". A direct save-to-file could later use WebView2's PrintToPdf via pywebview if Melody wants it. It's free either way.

## 4. Melody's latest requirements (beyond the mockup, and must be built)

**A. Timing never reorders words.**
> "No reordering words please. They should slide around as needed between already-pinned words."

A dragged word is clamped between its nearest fixed neighbors (pinned or chord-anchored) on the same line. The unpinned words between them slide **live during the drag**. It can cross barlines within that range, but it can't pass another word or jump to another line. The backend `placeWord` (`chart-layout.js`) already rejects reordering, so clamp in the UI instead of letting the drop fail.

**B. Text edits must never destroy timing work: a one-dimensional "puppet warp".**
> "We can't lose the work users made already just because they forgot to type 'the' or need to fix a typo. Think of Photoshop's 'puppet warp' but on one dimension instead of two. A measure can also be visually larger than others to fit more words if need be. The vertical | bars | show the timing and that should be enough for a musician not to be confused."

- **When lyric text changes,** remap the existing anchors with a word-level diff (LCS/Myers) over the old and new lines. Treat a delete next to an insert as the **same word** when they're similar (a typo fix), e.g. normalized edit distance ≤ 0.4. Matched words keep their anchors, inserted words start unanchored, and deleted words vanish. Today `lyric-chunks.js` (`boundaryOffsetMap`, `remapLineAnchors`, `lyricPlacementLosses`) handles this more crudely. Improve or replace it, and keep its tests passing or update them deliberately.
- **Unanchored word positions:** pins behave like puppet pins. Between two anchors, unanchored words keep their **relative** spacing, linearly remapped when an anchor moves. New words are interpolated between their neighbors. Even spacing is only the fallback.
- **Measures can be wider than others** to fit their words, in both the Timing and Navigate views. Only the barlines show the timing, so unequal widths are fine. In Timing, give each measure its own pixel width and use it everywhere (chords, chips, grid, hit-testing). Stacking words onto extra rows is a last resort.
- Undo must restore text and timing together, in one step. Chart history already exists through the document revision APIs.

## 5. The real app: what you need to know

**Run and test**
- Launch for testing with an isolated library: `runtime\python.exe portable_start.py --browser --library qa\<id>\lib`. Normal launch is `Start Chord Buddy.cmd` (native window) or `Start in browser.cmd`. `chordbuddy/__main__.py` also supports `--headless` and `--port` for automated checks.
- JS tests: `node --test tests\*.test.mjs` (Node is installed). Python: `runtime\python.exe -m pytest -q tests`. `HANDOFF.md` mentions a wrapper with short temp paths if the plain command hits path-length issues.
- Run the baseline **before** changing anything, so you know which tests already fail.
- Many existing tests encode the **old** UI contract (Pass buttons, Jump here, Original/Stems, the compact editor). When the new design deliberately changes a contract, rewrite those tests to the new behavior. Don't delete coverage of data integrity (saving, undo, anchors, repeats).

**Frontend files (`chordbuddy/web/`)**
- `index.html`, `style.css`, `chart-layout.css`, `lead-sheet.css`, `settings.css`: the shell and styles, which you'll replace.
- `app.js` (about 48 KB): the global model, `api()` (token header), library and set lists, import/drag-drop, analysis jobs, document tabs, save/undo/redo/restore/export, and the ABC and MIDI editors. It's dense one-line style. Keep its data logic, rebuild its DOM.
- Chart: `practice-view.js` (the current chart renderer, about 35 KB), `practice-state.js`, `practice-edit.js` (`planChartChordEdit`, `planSectionEdit`), `practice-save.js`, `practice-spacing.js`, `practice-timeline.js` (the current scrubber), `compact-chart.js` / `compact-view.js` / `compact-actions.js` (repeat folding), `chart-presentation.js` (edge N/null suppression; keep it), `chart-layout.js`, `musical-grid.js` (`addressAtSeconds`, `secondsAtMusicalPosition`, `buildPlacementTargets`, `SNAP_QUARTERS`), `lyric-chunks.js`, `lyric-plan.js`, `lyric-editor.js`.
- Playback: `transport.js` (`class Transport`: `subscribe`, `getSnapshot`, play/pause/seek, `setMix`, readiness), plus `pcm-session.js`, `pcm-worklet.js`, `pcm-mixer-core.js`, `pcm-stream.js`, `pcm-fetch-worker.js` (AudioWorklet stem mixing), `player-view.js`, `stems-view.js`, `playback-ready.js`, `song-session.js`.
- Other: `analysis-view.js`, `rhythm-view.js` (drum-based rhythm-correction proposal; keep it reachable, e.g. under Edit or Settings), `confidence-view.js`, `settings-view.js`, `lead-sheet.js`, `editor.js`, `export-retry.js`, and `vendor/abcjs`.
- Treat the pure helper modules (grid, layout, lyric chunks, compact chart, edit planners, transport, PCM) as **reusable logic**, and the view modules as **replaceable**.

**Server API (`chordbuddy/server.py`)** uses a token from the URL fragment, sent as the `X-ChordBuddy-Token` header (`?token=` for media). Routes: `GET /api/state`, `/api/song/<id>`, `/api/document/<id>` (+ `/undo` `/redo` `/restore`, POST with `revision`), `/api/export/<doc>`, `/api/audio/<song>`, `/api/playback/…`, `/api/separation-audio/…`, `/api/waveform/<song>`, `/api/separation/…`. POST: `/api/import`, `/api/song`, `/api/song-metadata`, `/api/setlist`, `/api/setlist/add`, `/api/setlist/order`, `/api/settings`, `/api/transcribe` (Analyze), `/api/separate`, `/api/cancel`, `/api/separation/cancel`, `/api/activate-run`, `/api/confirm-chord`, `/api/start-chord-at-measure`, `/api/open-folder`. Read the handler for exact payloads before calling one. `docs/DESIGN.md` has the original API contract, though some of it is out of date.

**Chart document (`kind: "chart"`, validated by `chordbuddy/chart.py::validate_chart`)**
```
{version:1, duration,
 sections:[{id, name, start, end, lyrics}],        // lyrics = lines joined with "\n"
 chords:[{id, label, start, end, section_id, line?, offset?, confirmed?, override_id?}],
 layout?:{bars_per_line, breaks:[measureId], bar_overrides:[{id,start}],
          lines:[{section_id, line, start_measure, end_measure,
                  words:[{offset, measure_id, beat}]}]}}  // per-word anchors: char offset → measure + beat
```
- Times are seconds. Measures and beats come from the run's music metadata, made into the effective grid by `effectiveMeasures(music, layout)`. A **word anchor is a character offset** in a lyric line pinned to a measure plus a (fractional) beat. Unanchored words get their position at display time, and that's where the puppet-warp interpolation belongs.
- Saving goes through the document POST with optimistic `revision`. History and undo are server-side per document.

## 6. Watch-outs

- **Speed without pitch change isn't implemented.** The roadmap lists it as deferred, and the mockup's stepper only faked it. Plain `playbackRate` on the PCM stream would shift the pitch, and musicians need the pitch preserved. Options: a time-stretch (WSOLA/phase-vocoder) stage in the AudioWorklet; SoundTouch's JS port (check its license, as it's LGPL-family); or server-side pre-rendered stretched stems. **Ask Melody before choosing.** Until then, build the UI and keep it honest: disabled with "coming soon", or pitch-shifting with a warning only if she agrees.
- **Loop playback is new.** Add it to `Transport`: when the clock reaches the range end, it seeks to the range start. Keep it seamless, preserve play intent, and remember that pan and zoom never seek.
- Fonts and assets must work offline in WebView2. Keep things vanilla: no frameworks and no build step.
- Real mouse, audio and native-window behavior can't be proven by DOM tests alone. Say clearly what you verified by hand and what you didn't.

## 7. Suggested phases (check in with Melody after each)

0. Read the mockup and the key modules. Run the test baseline. Launch with a test library (import any MP3 she provides; fixtures live in `tests/fixtures`).
1. **Shell and theme:** the new `index.html`/CSS, sidebar, header, tabs and palettes, with existing behavior wired in. Lead sheet and MIDI keep working.
2. **Locked state:** remove Original/Stems; gate on readiness.
3. **Mixer rack** in place of the Stems tab, wired to `Transport.setMix`.
4. **Navigation bar:** waveform, section blocks, playhead and badge, zoom/pan/follow, loop ranges (plus the Transport loop), and the speed UI (see section 6).
5. **Chart: Navigate and Edit modes** on the real chart document. Keep repeat folding, inline `(×N)`, correct pass highlighting and N/null edge suppression.
6. **Timing mode** in place: drag-anywhere with clamping (4A), chart zoom, anchors saved through `placeWord`-style updates.
7. **Puppet warp** (4B): diff-based anchor remapping, proportional interpolation, variable-width measures.
8. **Export PDF** and polish, final test run, and an honest report.

## 8. Chart rules that still apply (from `AGENTS.md`)
- Repeats are written inline, right after the last repeated chord: `G C D C (×2)`. Never put them in headers, blocks or timeline rulers. Genuine repeated sections (two Choruses) stay separate, with their canonical names.
- Highlighting and the playhead follow the actual pass through every repeat, including uneven timing and changed endings. Edit targets don't drift with playback.
- Hide leading and trailing unanchored N/null placeholders using the shared presentation rule. Never delete source chord data or history to hide them.
- One shared scrubber and clock. No separate seek strips or per-pass marker rows. Pan and zoom never seek. Seeking preserves play/pause intent.

## 9. Open questions for Melody (ask, don't guess)
- How should speed work (section 6)?
- Should dragging on the waveform turn looping on right away (as the mockup does), or only select a range?
- Which palette should be the default? Should the mixer be collapsible?
- Can a chord-anchored first word be dragged off its chord in Timing? The mockup allows it, turning it into a pin.
