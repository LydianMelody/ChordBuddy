# Model attribution

Chord Buddy transcribes recordings with **SheetSage2** from the Music AI Project:

- Model: [m-a-p/SheetSage2](https://huggingface.co/m-a-p/SheetSage2)
- Pinned revision: `7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384`
- Base model: [m-a-p/MERT-v2-FullSong](https://huggingface.co/m-a-p/MERT-v2-FullSong)
- Weight license: [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

The included model license asks that attribution identify MERT2, the model name, and its source repository. Each new transcription stores this same model identity, revision, base model, license, and citation links in that run's `run-options.json`. This makes it possible to identify the engine used after the app is upgraded or files are exported.

The SheetSage2 model card currently requests the YuE and MERT research citations for research use. The app's **Model & attribution** dialog links to those records and to the authoritative model cards. Chord Buddy uses the model to generate an editable draft from a recording; users remain responsible for reviewing the result and for any rights in the source recording or resulting materials.

## Stem separation models (downloaded on first run)

Chord Buddy does not ship these files. On first run it offers to download them (`chordbuddy/model_downloads.py`); every file is checked against a SHA-256 fingerprint and size, so a wrong or damaged copy is refused whichever location it came from. The list of files, fingerprints and download locations is in that file and can be edited without touching anything else.

| Model | Used for | Source | License status |
|---|---|---|---|
| BS-RoFormer SW (`BS-Rofo-SW-Fixed.ckpt`) | Six stems: bass, drums, other, vocals, guitar, piano | Trained by "jarredou". The original upload is gone; identical copies exist on several Hugging Face repositories | **Unconfirmed.** No license text came with the copies; mirrors disagree (MIT, non-commercial, unknown). |
| Mel-Band RoFormer lead/rhythm guitar (`model_mel_band_roformer_ep_72_sdr_3.2232.ckpt`) | Lead guitar (rhythm is the remainder) | Uploaded by "listra92" (`listra92/MyModels`) | **Unconfirmed.** Tagged OpenRAIL++ with no model card or training details; the uploader has been asked. |
| Model code (`ZFTurbo/Music-Source-Separation-Training`, commit `84b1eac`) | Runs the two models | GitHub | MIT |

Recorded licensing evidence from the earlier investigation is in `stem-separation-tests/models/*/evidence`. Do not publish a release that bundles the weights.
