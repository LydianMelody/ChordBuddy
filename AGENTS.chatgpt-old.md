# Chord Buddy regression rules

Before changing chart rendering, read docs/superpowers/specs/2026-10-13-practice-correction-design.md and preserve these user requirements:

- A repeated progression is not a new numbered song section. Transport section blocks reflect canonical section boundaries and names, including genuine repeated Chorus sections.
- Repeat notation must be inline immediately after the last repeated chord: G C D C (x2). Never put repeat counts in section headers/blocks or a timeline ruler. Do not bring back permanent Pass-button rows.
- Reading chord highlighting and its playhead must work through every repeat, with nonuniform timing and changed endings. Edit targets/drafts must not drift with playback or seek accidentally.
- Leading/trailing unanchored N/null placeholders must not reappear when a chart renderer is replaced. Use the shared presentation rule; preserve interior silence, explicit rests, anchored content and valid pickups. Never delete source chord data or saved history to hide the issue.
- One shared playback scrubber/clock across Chart and Stems. Do not add separate seek strips or pass-marker rows. Viewport pan/zoom never seeks; seeking preserves play/pause intent.
- Run the owning regression tests, including the currently mounted view. Real mouse/audio/native-close acceptance is distinct from synthetic/unit tests and must be reported honestly.

Current scope remains project-local. Do not reset/reprocess live Data or add checkpoints/audio copies for debugging. Respect the user's current explicit approval boundaries for local reads and deletions; an old fixture-cleanup approval is not permission for a new run.
