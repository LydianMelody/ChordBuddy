"""Translate model chord labels into musician-facing symbols, without guessing."""
import re

QUALITIES = {'maj':'', 'min':'m', 'dim':'dim', 'aug':'aug', '7':'7',
             'maj7':'maj7', 'min7':'m7', 'dim7':'dim7', 'hdim7':'m7b5',
             'sus4':'sus4', 'sus2':'sus2', 'maj6':'6', 'min6':'m6',
             'sus4(b7)':'7sus4', 'minmaj7':'m(maj7)'}
NATURAL = {'C':0,'D':2,'E':4,'F':5,'G':7,'A':9,'B':11}
LETTERS = 'CDEFGAB'
PITCH = r'[A-G](?:#{1,2}|b{1,2})?'


def chord_label(value):
    """Accept raw labels and legacy display labels; preserve unknown spellings."""
    match = re.fullmatch(rf'({PITCH}):?([^/]*)(?:/(.+))?', value)
    if not match:
        return value
    root, quality, bass = match.groups()
    if quality in QUALITIES:
        quality = QUALITIES[quality]
    elif quality not in QUALITIES.values():
        return value
    if bass and not re.fullmatch(PITCH, bass):
        degree = re.fullmatch(r'(#{0,2}|b{0,2})([1-9]|1[0-3])', bass)
        if not degree:
            return value
        accidental, number = degree.groups()
        number = int(number)
        root_pc = NATURAL[root[0]] + root.count('#') - root.count('b')
        interval = (0,2,4,5,7,9,11)[(number-1)%7]
        pitch_class = (root_pc + interval + accidental.count('#') - accidental.count('b')) % 12
        letter = LETTERS[(LETTERS.index(root[0])+number-1)%7]
        difference = (pitch_class-NATURAL[letter]+6)%12-6
        if abs(difference)>2:
            return value
        bass = letter + ('#'*difference if difference>0 else 'b'*(-difference))
    return root + quality + ('/'+bass if bass else '')
