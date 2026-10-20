# Third-party notices

Chord Buddy's own code is MIT licensed (see `LICENSE`). It uses the following. **Nothing marked "downloaded" is included in this repository**: the installer and the app fetch it onto the user's own computer.

> Status: the library licenses below were checked on 2026-10-19 against the license metadata of the exact versions the installer sets up. The model licenses are described as far as they are known; for two of them I have not been able to confirm the terms (see below). This is not legal advice.

## Included in this repository
| Component | Where | License |
|---|---|---|
| abcjs (music notation display) | `chordbuddy/web/vendor/` | MIT (`abcjs-LICENSE.md` next to it) |
| Bricolage Grotesque, Courier Prime, Space Mono (fonts) | `chordbuddy/web/fonts/` | SIL Open Font License 1.1 (`LICENSES.txt` next to them) |

## Downloaded by the installer or the app (not included)
| Component | Purpose | License / status |
|---|---|---|
| Python 3.11 (embeddable build) | runs the app | Python Software Foundation License |
| PyTorch, torchaudio | runs the models | BSD-3-Clause (PyTorch), BSD (torchaudio) |
| transformers, huggingface-hub, safetensors, tokenizers, requests, numpy, scipy, PyYAML, tqdm | transcription engine | Apache-2.0 (transformers, huggingface-hub, safetensors, tokenizers, requests); BSD-3-Clause (numpy, scipy); MIT (PyYAML); MPL-2.0 and MIT (tqdm) |
| pywebview (and pythonnet) | the app window | BSD-3-Clause (pywebview), MIT (pythonnet) |
| mido | MIDI files | MIT |
| **mutagen** | reads MP3 tags | **GPL-2.0-or-later.** Chord Buddy imports it at run time and does not include it. Combining with MIT code is allowed, but consider this when choosing how to distribute a bundled build. *(check)* |
| ffmpeg 6.0 "essentials" build from gyan.dev | converts audio, exports MP3 | **GPL v3.** Downloaded to the user's computer and run as a separate program; not redistributed by Chord Buddy. |
| SheetSage2 and MERT-v2-FullSong (Music AI Project) | chord and melody transcription | SheetSage2 weights: CC BY-NC 4.0 (non-commercial; attribution required). Public on Hugging Face; no account needed. Details in `docs/MODEL-ATTRIBUTION.md`. |
| BS-RoFormer SW six-stem model | stem separation | Tagged MIT or non-commercial by different copies, but unconfirmed. The original upload is no longer available, so I could not ask the trainer. If you have more information, contact me at lydianmelody@outlook.com. See `docs/MODEL-ATTRIBUTION.md`. |
| Mel-Band RoFormer lead/rhythm guitar model (by "listra92") | lead guitar separation | Tagged OpenRAIL++ but unconfirmed. I unsuccessfully tried to contact the uploader. If you have more information, contact me at lydianmelody@outlook.com. |
| RoFormer model code (`ZFTurbo/Music-Source-Separation-Training`, pinned commit) | runs the two stem models | MIT |

Because SheetSage2 is non-commercial and the stem model terms are not confirmed, Chord Buddy is intended as a free, non-commercial tool.

I want to use these models the way their makers intended. If you made one of them, or know its terms, please email me at lydianmelody@outlook.com or [open an issue on GitHub](https://github.com/LydianMelody/ChordBuddy/issues). I will follow whatever they require, including removing the model from Chord Buddy.

## Formats and designs this project learned from (nothing from them is included)
| Name | How it is used | License / status |
|---|---|---|
| **MusicXML** (W3C Music Notation Community Group) | The "Open in another editor" button writes a lead sheet as a MusicXML 3.1 file. The writer, `chordbuddy/web/musicxml.js`, is Chord Buddy's own code written from the published format; no MusicXML library or sample file is included. | The format is an open standard and free to implement. |
| **MuseScore 4** (musescore.org) | Design inspiration only: a tool palette down the left, selecting a note and moving it with the arrow keys, a text note-name readout. **No code, icons, artwork or text were copied.** Every icon and picture in Chord Buddy is drawn from scratch (`tool-icons.js`, `lead-tool-info.js`). MuseScore itself is a separate program that opens the exported file; Chord Buddy does not include, call or bundle it. | MuseScore is GPL-3.0. Because nothing from it is included, it places no terms on Chord Buddy. |
