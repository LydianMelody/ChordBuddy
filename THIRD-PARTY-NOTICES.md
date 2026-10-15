# Third-party notices

Chord Buddy's own code is MIT licensed (see `LICENSE`). It uses the following. **Nothing marked "downloaded" is included in this repository**: the installer and the app fetch it onto the user's own computer.

> Status: a working draft. Licenses marked *(check)* were written from general knowledge, not looked up for this project; confirm them before a public release. This is not legal advice.

## Included in this repository
| Component | Where | License |
|---|---|---|
| abcjs (music notation display) | `chordbuddy/web/vendor/` | MIT (`abcjs-LICENSE.md` next to it) |
| Bricolage Grotesque, Courier Prime, Space Mono (fonts) | `chordbuddy/web/fonts/` | SIL Open Font License 1.1 (`LICENSES.txt` next to them) |

## Downloaded by the installer or the app (not included)
| Component | Purpose | License / status |
|---|---|---|
| Python 3.11 (embeddable build) | runs the app | Python Software Foundation License *(check)* |
| PyTorch, torchaudio | runs the models | BSD-3-Clause style *(check)* |
| transformers, huggingface-hub, safetensors, numpy, scipy and related libraries | transcription engine | Apache-2.0 / BSD style *(check each)* |
| pywebview (and pythonnet) | the app window | BSD-3-Clause / MIT *(check)* |
| mido | MIDI files | MIT *(check)* |
| **mutagen** | reads MP3 tags | **GPL-2.0-or-later.** Chord Buddy imports it at run time and does not include it. Combining with MIT code is allowed, but consider this when choosing how to distribute a bundled build. *(check)* |
| ffmpeg 6.0 "essentials" build from gyan.dev | converts audio, exports MP3 | **GPL v3.** Downloaded to the user's computer and run as a separate program; not redistributed by Chord Buddy. |
| SheetSage2 and MERT-v2-FullSong (Music AI Project) | chord and melody transcription | SheetSage2 weights: CC BY-NC 4.0 (non-commercial; attribution required). Access is gated on Hugging Face. Details in `docs/MODEL-ATTRIBUTION.md`. |
| BS-RoFormer SW six-stem model | stem separation | **License unconfirmed.** Original uploader's account is gone; copies on Hugging Face disagree. See `docs/MODEL-ATTRIBUTION.md`. |
| Mel-Band RoFormer lead/rhythm guitar model (by "listra92") | lead guitar separation | **License unconfirmed.** Tagged OpenRAIL++ with no model card; the uploader has been contacted. |
| RoFormer model code (`ZFTurbo/Music-Source-Separation-Training`, pinned commit) | runs the two stem models | MIT |

Because of the non-commercial and unconfirmed model licenses, Chord Buddy is intended as a free, non-commercial tool.
