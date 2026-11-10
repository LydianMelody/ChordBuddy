# How Chord Buddy works

This is an overview for anyone reading or changing the code. The musical rules for the chart and the lead sheet are in [MUSICAL-LAYOUT.md](MUSICAL-LAYOUT.md); the models and their licenses are in [MODEL-ATTRIBUTION.md](MODEL-ATTRIBUTION.md).

## The pieces

- **Server:** Python 3.11 (`chordbuddy/`). It serves the page, stores the library and runs the analysis.
- **Front end:** plain JavaScript modules, HTML and CSS (`chordbuddy/web/`), with no build step. `app.js` wires the views together.
- **Window:** `Start Chord Buddy.cmd` opens the page in a native window (pywebview, using Microsoft WebView2). `Start in browser.cmd` opens the same page in your web browser instead.
- **Runtime:** everything runs from the app's own folder: its own Python (`runtime/`), FFmpeg (`tools/`) and models (`.models/`). `InstallWindowsDependencies.cmd` sets these up and installs nothing outside the folder.

The server only listens on `127.0.0.1`. Each session gets a random token, passed to the page in the URL fragment (`#token=…`) and sent with every request as `X-ChordBuddy-Token`, or as `?token=…` for audio and downloads. Requests with the wrong `Host` or `Origin` are refused, and there is no CORS.

## The library

Songs and everything you change live in the `Data` folder next to the app (or the folder given with `--library`). A SQLite database holds the song list, set lists, preferences, every document revision, and saved arrangements and shows; each song has its own folder for the imported MP3, the analysis results, the stems and your own MIDI files (`my-midi`). Visual connections are in `visual-patches.json`.

- The imported recording and the models' original output are never overwritten.
- Every edit is saved as a revision, so Undo and Redo survive closing the app.
- Each analysis is kept. **Previous transcriptions** (in Settings) opens an earlier one with its own edits and history.
- Deleted songs go to the trash first and can be restored.
- **Whole song · zip** (`song_transfer.py`, `song_extras.py`) carries everything about one song: rows, files, your MIDI, its visual connections, look and arrangements. Importing only adds, and a damaged extra is left out without losing the song.

## Analysis

Analysis runs in stages: **source** (decode the MP3), **separation** (stems, optional), **transcription** (chords, melody, beats and sections), **chart** (build the chord chart). **Drum-based rhythm correction** is a separate step you start yourself: it uses the drum stem to suggest better beat positions, and you review the suggestion before it is applied.

- Each stage's result is stored with a fingerprint of what produced it: the audio, the code, the model files and the device. A stage only runs again when its fingerprint changes, or when it is asked to.
- **Analyze again** always reruns transcription, and separation if you tick it. If the song has edits you choose **Keep my edits** (your edited chart and lead sheet stay in front) or **Start over** (the fresh ones are shown; your edited versions stay under Previous transcriptions).
- A failed or cancelled analysis never replaces a working one.

The models run in separate worker processes, one model job at a time, so the window never freezes and the memory they use (including graphics card memory) is released as soon as the job ends. Stem separation runs inside a Windows job object, so it stops if the app closes. **Automatic** uses an NVIDIA graphics card when one is available and falls back to the processor; **NVIDIA GPU only** and **CPU only** are explicit. The choice is made when a song is added.

The models are not part of the download. The installer fetches them, or the app shows a **Download** panel when one is missing:

- the chord and melody model (SheetSage2 with MERT-v2-FullSong) goes in `.models/hf/hub` (`chordbuddy/transcription_models.py`);
- the two stem models go in `.models/separation`, and every file is checked against a SHA-256 fingerprint (`chordbuddy/model_downloads.py`).

## Documents and views

Each analysis produces a **chart** (Chord Buddy's own JSON), a **lead sheet** (ABC notation, drawn with abcjs) and **MIDI** (vocal melody, instruments and chords). The views are **Chart**, **Lead sheet** and **MIDI**, plus the stem mixer. Lyrics are shared between the chart and the lead sheet. Everything plays from one shared clock, and one scrubber drives the chart, the lead sheet, the piano roll and the stems.

On the lead sheet, chord symbols the model was less sure of are drawn fainter. A chord you type yourself is confirmed and drawn at full strength. Confidence scores are the model's own prediction certainty, not a guarantee that a chord is right.

## Visuals

Visualizations are JavaScript modules in `chordbuddy/web/visualizations/`, or `My Visuals` beside the app. Each draws from a frame of musical data built by `visual-scene.js`. The player publishes the song and its clock over a BroadcastChannel (`visual-bridge.js`), and to OBS through the server (`visual_relay.py`), so any number of windows follow one player. `visual-patch.js` turns sounds and signals into each visualization's inputs; the Advanced Visuals Editor (`visual-patchbay.js`) edits those connections. A file you drop for the visualizer (`midi-import.js`, `user_midi.py`) never changes the chart or the model's data.

The page plays the sound, not Python. OBS's Application Audio Capture listens to whichever program owns the window you pick, and asking Windows for `python.exe`'s audio returns silence even though WebView2 is its child. So the desktop app can open `obs-sound.html`, the one new window `allow_sound_window` in `__main__.py` leaves to WebView2. WebView2's main process owns that window, and capturing it hears the sound the same way capturing a browser does. The window closes itself when the main window or the server is gone (`obs-sound.js`); otherwise it would keep WebView2 running.

## Performance

The Prepare, Shows and Perform pages run a set from one Start. Practice playback (`transport.js`, `pcm-mixer-core.js`) doesn't use any of this until a show takes the transport over, and gets its mix and speed back afterward.

- **Model:** `performance-model.js` is what's saved: an arrangement's cues by bar and beat, its repeats and each pass's own program. `performance_store.py` keeps them as revisions that never change, so a show can pin the exact one it was checked with.
- **Compiler:** `performance-compiler.js` turns an arrangement and the song's bars into a path: one segment per play, in exact frames. `performance-duration.js` works out every clock from that path. `performance-actions.js` is the list of everything an arrangement can do; imported files can only name these, and never run code.
- **Runner:** `performance-runner.js` decides what plays next. Loops, exits, switches and jumps are all edits to the path, and each happens at a bar line. It's pure, so tests drive it with the real mixer and check the output sample by sample (`tests/performance-sim.mjs`, including a randomized soak).
- **Engine:** `pcm-path.js` plays up to an exact frame and then the target, with no stop, in its own `stem-path` processor (`pcm-worklet.js`, `pcm-path-session.js`). One AudioContext lasts the whole show, with two players, so the next song starts on an exact sample. Mix changes are applied on their exact output frame, ahead of any time stretch.
- **Show:** `performance-controller.js` moves between songs, and `performance-app.js` connects it to the app. `performance-prepare.js` and `performance-view.js` are the pages.
- **Outside:** `performance-visuals.js` sends timed cues to every visualizer. `midi_service.py` schedules MIDI out on a thread with its own clock, and `performance-midi.js` talks to it. Input comes through WinRT MIDI, because WinMM delivers nothing from a Line 6 Helix on some Windows 11 systems, with WinMM as the fallback. Only a control you taught does anything. `power_service.py` keeps the computer awake during a show.

## The API

`chordbuddy/server.py` handles every request; the route names describe what they do. The main groups are:

- **library:** `/api/state`, `/api/import`, `/api/song`, `/api/song-metadata`, `/api/setlist…`, `/api/song/trash`, `/restore` and `/purge`, `/api/prefs`, `/api/settings`;
- **analysis:** `/api/songs/<id>/analyze`, `/api/separate`, `/api/cancel`, `/api/activate-run`;
- **documents:** `/api/song/<id>`, `/api/document/<id>` (with `/undo`, `/redo` and `/restore`), `/api/confirm-chord`;
- **playback:** `/api/audio/…`, `/api/separation-audio/…`, `/api/waveform/…`, `/api/playback/…`;
- **exports:** `/api/export-midi/…`, `/api/export-outputs/…`, `/api/mix-export/…`, and opening a file in another program with `/api/midi/external` and `/api/lead-sheet/external`;
- **models:** `/api/models…` (stem models) and `/api/chord-model…` (the chord model);
- **visuals:** `/api/visual-patches…`, `/api/visual-relay/…`, `/api/user-midi/…`;
- **performance:** `/api/performance…` and `/api/performances/<song>`, `/api/show…` and `/api/shows` (with `/export` and `/import`), `/api/midi/…`, `/api/power…`;
- **updates:** `/api/update-check` runs only when someone chooses Check for updates. It reads the `VERSION` file on the project's `main` branch, and sends nothing about the library.

Errors come back as JSON `{error}` with a 4xx or 5xx status. The page learns about running jobs by polling `/api/state`. Document saves carry a revision number, so an edit made from stale data is refused instead of overwriting newer work.

## Testing

- JavaScript: `node --test tests/*.test.mjs`
- Python: `runtime\python.exe -m pytest -q tests`
- 16 Python tests currently fail on a long temporary path (`PathBudgetError`), in the analysis, separation and short-path tests, whatever else changes. Compare against that list.
- Try changes against a separate library, never your real one: `runtime\python.exe portable_start.py --browser --library C:\some\test\library`
