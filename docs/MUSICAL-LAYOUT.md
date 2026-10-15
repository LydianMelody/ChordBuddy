# Musical layout update

Close and reopen Chord Buddy after installing this update.

## Chord charts

Charts now use the model's actual measures and beats. Sections start new systems, with four bars per line by default. Choose 2, 3, 4 or 8 bars and use the ↵ button on a bar for a custom system break. Narrow windows scroll whole systems rather than splitting measures.

Open **Place lyrics** under a section. Pick a line's start bar, end bar and starting beat, then click **Place line**. To refine it, select a word and click a beat or chord, or drag a word to a beat. The words following it stay together until you place another phrase. You can also select a chord and click a word, or drag the chord onto the word. No lyric timing is inferred.

Use **Unplace line** to start over. Editing a lyric line clears its placements; Undo restores the earlier text and placement. Section edits retain valid placements and unplace lines whose ranges no longer fit. Correcting a detected barline is separate from inserting a page break; corrections that invalidate a lyric placement ask you to unplace that line first.

## Lead sheets

The score defaults to vocal melody with chords, section headings and whole-bar systems. Toggle **Instrumental staff** to include accompaniment. Choose bars per system or a manual break.

Open the lyric controls, paste text and optionally separate syllables with hyphens. Select a word or syllable, then click its melody note, or choose a melody note and click **Place on selected note**. Click an already placed syllable to move it, or × to clear it. There is no automatic lyric placement. Melody source edits clear syllable placements that could refer to different notes; title and chord-label edits retain them.

## Preservation and verification

Chart, lead-sheet and MIDI edits remain independent, with persistent saves and Undo/Redo. Original model outputs, library and previous history are preserved. No dependencies were added. Measure timing must exist in the model output; the app does not invent bars when rhythm data is absent.

Layout and lead-sheet syllables are saved in the app's document history. Chart JSON includes chart layout; ABC Download retains source notation and does not include the separate display engraving settings or manually placed syllables.

Verified: 77 Python tests and 36 JavaScript tests; actual-song browser checks for manual word/phrase and note placement, system breaks, Undo/Redo, reopen persistence, independent documents, and wide/narrow systems. Verification used a copied library.
