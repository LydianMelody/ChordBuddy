# Chord Buddy (working copy)

**Start here:** read `mockups/HANDOFF-for-Sonnet.md`. It's the current plan for rebuilding the frontend, based on the approved design in `mockups/05-press-room.html`.

## Ground rules
- Work only in this folder (the `ChordBuddy` folder, renamed from `ChordBuddy-Portable copy` to keep paths short). Never touch the original `ChordBuddy-Portable` folder, if it still exists.
- `Data/` is Melody's real song library. Never reset, reprocess, delete or "clean" it. Test with an isolated library: `runtime\python.exe portable_start.py --browser --library qa\<short-id>\lib`.
- Git is set up (for publishing to GitHub with GitHub Desktop), but never commit, push or change repository settings unless Melody asks. Back up files to your scratchpad before large edits, not into this folder.
- Never leave servers or browsers running. Start them with a known PID, stop them, and verify they're gone (`pkill` doesn't exist on Windows).
- Leave the backend, models and runtime alone unless a frontend feature truly needs a small, tested API addition.

## Chart rules (these still apply)
- Repeats are written inline, right after the last repeated chord: `G C D C (×2)`. Never put them in section headers, blocks or the timeline. Genuine repeated sections, like two Choruses, stay separate.
- Highlighting and the playhead follow the actual pass through every repeat, including uneven timing and changed endings. Edit targets don't drift with playback.
- Hide only leading and trailing unanchored N/null chord placeholders, using the shared presentation rule. Keep interior silence, explicit rests, anchored content and valid pickups. Never delete source chord data or history to hide them.
- Section blocks reflect canonical section boundaries and names. A repeated progression is not a new numbered section, and there are no permanent Pass-button rows.
- Run the owning regression tests, including those for the currently mounted view. Report honestly what was verified by real mouse, audio or native-window use and what only passed synthetic tests.
- One shared scrubber and clock for chart and stems. Pan and zoom never seek. Seeking preserves play/pause intent.
- Lyric timing never reorders words, and lyric text edits must preserve existing timing work. Details are in the handoff.

## About the older docs
`HANDOFF.md`, `README.md`, `docs/**`, `qa/**`, `OLD-verification/**` and `AGENTS.chatgpt-old.md` were written by a previous agent (ChatGPT/Codex). Use them for **how the backend, data and audio pipeline work**. Their **UI decisions and workflow instructions are superseded** by the handoff above, including "work only in the original folder" and the old approval rules.
