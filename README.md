# Chord Buddy

A free practice app for Windows. Give it a song (an MP3) and it works out the chords, the melody and the song's sections, then gives you three ways to play along:

- **Chord chart:** the song's chords bar by bar, with the lyrics under them, repeats folded (`G C D C ×2`) and the current chord lit as the music plays.
- **Lead sheet:** the melody on a staff with chord symbols and lyrics, ready to print or save as a PDF.
- **Piano roll:** every note of the vocal melody, the instruments and the chords, in their own colours.

It can also split the recording into seven stems (bass, drums, vocals, piano, lead guitar, rhythm guitar and the rest), so you can turn parts up, down or off while you practise.

Everything runs on your own computer. Your music is never uploaded anywhere.

## What you can do

- **Practise:** loop any stretch, slow the music down without changing the pitch, follow along on the chart, the lead sheet or the piano roll, and mute or solo stems in the mixer.
- **Correct the chart:** retype chords and words, split and join sections, fold or unfold repeats, time the words to the beat, and fix bar lines for short or long bars. Every change can be undone, even after closing the app.
- **Edit the lead sheet:** fix chord symbols, type lyrics (they are shared with the chart), choose where lines break, or open it in MuseScore or another notation program as a MusicXML file.
- **Export:** PDF of the chart or the lead sheet, MIDI (one multichannel file or one file per track), a mix of the stems as an MP3, or a zip of everything the model produced.
- **Make it yours:** three colour themes, each with a light and dark look.

## Install

You need Windows 10 or 11 (64-bit) and a few GB of free space. An NVIDIA graphics card makes the analysis much faster, but it is not required.

1. Download or clone this repository into a folder with a short path, such as `C:\ChordBuddy`.
2. Double-click **InstallWindowsDependencies.cmd**. It sets up everything Chord Buddy needs inside that folder only: its own Python, PyTorch, the audio tools, the stem models and the chord and melody model ([SheetSage2](https://huggingface.co/m-a-p/SheetSage2), with [MERT-v2-FullSong](https://huggingface.co/m-a-p/MERT-v2-FullSong), at fixed versions). It picks the NVIDIA version of PyTorch automatically when it finds an NVIDIA card. It is safe to run again.

The models are public, so you don't need a Hugging Face account. To download them later instead (they are a few GB), run `InstallWindowsDependencies.cmd --skip-models`. Chord Buddy then shows a **Download** button for each model when it first needs it.

## Use it

1. Double-click **Start Chord Buddy.cmd**. (If the window does not open, **Start in browser.cmd** opens Chord Buddy in your web browser instead.)
2. Drop an MP3 into the window, or choose **Import MP3**.
3. Check the title and artist (they are read from the file's tags), choose whether to split the stems, and choose what to process with: **Automatic**, **NVIDIA GPU only** or **CPU only**. Then choose **Analyze**.
4. When the analysis is done, switch between **Chart**, **Lead sheet** and **MIDI** at the top of the page, and use the player at the bottom.

Your songs and everything you change are saved in the **Data** folder next to the app. Back it up like any other folder.

Handy keys: **Space** plays and pauses, **Esc** puts a tool down, letters pick tools (hover over a tool to see its key), and in the piano roll **Ctrl + wheel** zooms time and **Ctrl + Shift + wheel** zooms pitch. **Ctrl + wheel** over the chart or the lead sheet makes the page bigger or smaller.

## For developers

Chord Buddy is a small Python 3.11 server (`chordbuddy/`) and a plain JavaScript front end with no build step (`chordbuddy/web/`). The models run in separate worker processes, one job at a time.

- Run with a test library: `runtime\python.exe portable_start.py --browser --library C:\some\test\library`
- JavaScript tests: `node --test tests/*.test.mjs`
- Python tests: `runtime\python.exe -m pytest -q tests`

[docs/DESIGN.md](docs/DESIGN.md) explains how the app is put together, and [docs/MUSICAL-LAYOUT.md](docs/MUSICAL-LAYOUT.md) lists the musical rules the chart and lead sheet follow.

## Credits and licenses

Made by [LydianMelody](https://github.com/LydianMelody) and Claude.

Chord Buddy's own code is released under the MIT License (see `LICENSE`).

Chord and melody transcription uses [SheetSage2](https://huggingface.co/m-a-p/SheetSage2) by the Music AI Project, built on MERT-v2-FullSong. Its weights are licensed **CC BY-NC 4.0** (non-commercial use, with attribution). I have not been able to confirm the terms of the two stem separation models; if you know them, please contact me at lydianmelody@outlook.com. Please treat Chord Buddy as a free, non-commercial tool. Full details, including every library and the design references, are in `THIRD-PARTY-NOTICES.md` and `docs/MODEL-ATTRIBUTION.md`.

Score rendering uses [abcjs](https://github.com/paulrosen/abcjs) (MIT). The fonts are Bricolage Grotesque, Courier Prime and Space Mono (SIL Open Font License).
