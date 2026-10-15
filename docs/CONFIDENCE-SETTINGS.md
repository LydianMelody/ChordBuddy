# Confidence settings and reprocessing

Open Settings to choose beat warning, beat removal, and chord warning percentages. Zero disables a threshold. Removal must not exceed the beat warning threshold. Warning changes apply immediately to scored transcriptions; removal applies on the next transcription or reprocessing. Beat removal defaults to disabled.

Amber beat numbers indicate low model confidence in rhythm position. Purple chords with a diamond indicate low chord confidence. Existing bar-count flags remain separate. Scores are the model's grammar-constrained token probabilities, not calibrated chances that a transcription is musically correct. Older transcriptions have no scores until reprocessed. Manually relabeled or retimed chords do not inherit unrelated scores.

Reprocess song offers Keep my edits or Replace with fresh output when edited documents exist. Keep preserves edited documents alongside the fresh output, with their original timing and undo history. It does not automatically merge lyrics or remap placements. Replace activates the fresh documents; previous transcriptions and their edits remain recoverable using Previous transcriptions. Failed, cancelled, and partial new runs do not replace a successful active transcription.

When beat filtering is enabled, the unfiltered model export is preserved in the run's unfiltered folder. Filtering removes rhythm markers only; it does not remove chord or melody events.

Verified with 100 Python tests, 38 JavaScript tests, a short real model inference, and copied-library browser checks for validation, confidence indicators, keep/replace choices, and previous-run restoration. Browser reprocessing used a fixture worker; real capture was separately verified on generated audio. No user library data was changed during verification or installation.
