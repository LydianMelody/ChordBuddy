"""A recording that fades out stops in the middle of the music: the last chord, key and section are cut off by the end of the file,
sometimes only a few milliseconds after they start. The tempo has not changed, so on the lead sheet they carry on at least to the next
beat of the steady beat grid (the model already continues that grid past the end of the audio and pads the final bar). Without this,
a chord that begins just before the fade ends is too short for the lead sheet's subbeat grid and the whole lead sheet is refused.

Only the copy handed to the lead sheet changes: the chord chart, MIDI and every saved .lab file keep exactly what the model heard.
"""
from contextlib import contextmanager
import importlib


def carry_through_fade(beats, rows):
    """`rows`: [[start, end, value], ...] in time order. The final one lasts at least until the first beat after its start."""
    if not rows:
        return rows
    start, end, value = rows[-1][:3]
    later = [float(b[0]) for b in beats if float(b[0]) > float(start) + 1e-6]
    if not later or end >= later[0]:
        return rows
    return [list(r) for r in rows[:-1]] + [[start, later[0], value]]


@contextmanager
def install_fade_ending(model, *, exports=None):
    """Worker-local, like confidence.install_capture: the pinned exporter's lead-sheet call is wrapped and always restored."""
    if exports is None:
        package = model.__class__.__module__.rsplit('.', 1)[0]
        exports = importlib.import_module(package + '.exports_sheetsage2')
    original = exports.generate_abc_from_data

    def generate(midi, beats, chords, keys, structures, *args, **kwargs):
        return original(midi, beats, carry_through_fade(beats, chords), carry_through_fade(beats, keys),
                        carry_through_fade(beats, structures), *args, **kwargs)

    exports.generate_abc_from_data = generate
    try:
        yield
    finally:
        exports.generate_abc_from_data = original
