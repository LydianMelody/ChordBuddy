# Musical layout rules

These are the rules the chord chart and the lead sheet follow. Any change to the chart, the lead sheet or playback should keep them true; the tests in `tests/` check most of them.

## Bars and sections

- Bars come from the beats and downbeats the model found in the recording, so tempo changes and short or long bars are kept. You can correct a bar line or the song's timing yourself; Chord Buddy does not invent bars where the recording gives it no rhythm.
- Section blocks (Intro, Verse, Chorus…) show the song's real sections, with their names. A repeated chord progression inside a section is not a new section.
- Sections that genuinely happen more than once, like two Choruses, stay as separate sections.

## Repeats

- Repeats are written inline, right after the last repeated chord: `G C D C (×2)`. They never appear in section headers, section blocks or the timeline.
- A chord held over several bars folds the same way as one played again: four bars of B are `B (×4)`, not `B | (B) (×3)`.
- If one pass ends differently, the chart shows the different ending.
- While the music plays, the highlight and the playhead follow the actual pass through every repeat, including passes with uneven timing and changed endings.
- Editing a folded chord edits the chord you clicked; the place you are editing does not move with playback.

## Silence

- Silence before the first chord and after the last one is hidden.
- A break in the middle of the song (the model's "N", no chord) is shown as an empty space in the bar. Written rests and pickups before the first full bar are kept.
- Hiding is only a matter of display: no chord data or history is deleted to hide it.

## Lyrics

- The chart and the lead sheet share the same lyrics.
- Words are timed to the beat, and timing never changes the order of the words.
- Changing the text of a lyric line keeps the timing work already done on it.

## Playback

- There is one clock and one scrubber for the chart, the lead sheet, the piano roll and the stems.
- Panning and zooming never move the playback position. Seeking keeps playing if the music was playing, and stays paused if it was paused.
