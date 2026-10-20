# How Chord Buddy works

This is an overview for anyone reading or changing the code. The musical rules for the chart and the lead sheet are in [MUSICAL-LAYOUT.md](MUSICAL-LAYOUT.md); the models and their licenses are in [MODEL-ATTRIBUTION.md](MODEL-ATTRIBUTION.md).

## The pieces

- **Server:** Python 3.11 (`chordbuddy/`). It serves the page, stores the library and runs the analysis.
- **Front end:** plain JavaScript modules, HTML and CSS (`chordbuddy/web/`), with no build step. `app.js` wires the views together.
- **Window:** `Start Chord Buddy.cmd` opens the page in a native window (pywebview, using Microsoft WebView2). `Start in browser.cmd` opens the same page in your web browser instead.
- **Runtime:** everything runs from the app's own folder: its own Python (`runtime/`), FFmpeg (`tools/`) and models (`.models/`). `InstallWindowsDependencies.cmd` sets these up and installs nothing outside the folder.

The server only listens on `127.0.0.1`. Each session gets a random token, passed to the page in the URL fragment (`#token=…`) and sent with every request as `X-ChordBuddy-Token`, or as `?token=…` for audio and downloads. Requests with the wrong `Host` or `Origin` are refused, and there is no CORS.

## The library

Songs and everything you change live in the `Data` folder next to the app (or the folder given with `--library`). A SQLite database holds the song list, set lists, preferences and every document revision; each song has its own folder for the imported MP3, the analysis results and the stems.

- The imported recording and the models' original output are never overwritten.
- Every edit is saved as a revision, so Undo and Redo survive closing the app.
- Each analysis is kept. **Previous transcriptions** (in the ⋯ menu) opens an earlier one with its own edits and history.
- Deleted songs go to the trash first and can be restored.

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

## The API

`chordbuddy/server.py` handles every request; the route names describe what they do. The main groups are:

- **library:** `/api/state`, `/api/import`, `/api/song`, `/api/song-metadata`, `/api/setlist…`, `/api/song/trash`, `/restore` and `/purge`, `/api/prefs`, `/api/settings`;
- **analysis:** `/api/songs/<id>/analyze`, `/api/separate`, `/api/cancel`, `/api/activate-run`;
- **documents:** `/api/song/<id>`, `/api/document/<id>` (with `/undo`, `/redo` and `/restore`), `/api/confirm-chord`;
- **playback:** `/api/audio/…`, `/api/separation-audio/…`, `/api/waveform/…`, `/api/playback/…`;
- **exports:** `/api/export-midi/…`, `/api/export-outputs/…`, `/api/mix-export/…`, and opening a file in another program with `/api/midi/external` and `/api/lead-sheet/external`;
- **models:** `/api/models…` (stem models) and `/api/chord-model…` (the chord model).

Errors come back as JSON `{error}` with a 4xx or 5xx status. The page learns about running jobs by polling `/api/state`. Document saves carry a revision number, so an edit made from stale data is refused instead of overwriting newer work.

## Testing

- JavaScript: `node --test tests/*.test.mjs`
- Python: `runtime\python.exe -m pytest -q tests`
- Try changes against a separate library, never your real one: `runtime\python.exe portable_start.py --browser --library C:\some\test\library`
