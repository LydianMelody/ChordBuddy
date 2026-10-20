# Model attribution

Chord Buddy transcribes recordings with **SheetSage2** from the Music AI Project:

- Model: [m-a-p/SheetSage2](https://huggingface.co/m-a-p/SheetSage2)
- Pinned revision: `7cb7b16233d2f5ccb4d3295c2b501fdc31bc0384`
- Base model: [m-a-p/MERT-v2-FullSong](https://huggingface.co/m-a-p/MERT-v2-FullSong)
- Weight license: [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

The included model license asks that attribution identify MERT2, the model name, and its source repository. Chord Buddy always uses these exact revisions. Each analysis records a fingerprint of the model files it used, so if the model ever changes, the next analysis of a song transcribes it again instead of mixing results from two versions.

The SheetSage2 model card currently requests the YuE and MERT research citations for research use. The app's **Model & attribution** dialog links to those records and to the authoritative model cards. Chord Buddy uses the model to generate an editable draft from a recording; users remain responsible for reviewing the result and for any rights in the source recording or resulting materials.

## Stem separation models (downloaded on first run)

Chord Buddy does not ship these files. On first run it offers to download them (`chordbuddy/model_downloads.py`); every file is checked against a SHA-256 fingerprint and size, so a wrong or damaged copy is refused whichever location it came from. The list of files, fingerprints and download locations is in that file and can be edited without touching anything else.

| Model | Used for | Source | License status |
|---|---|---|---|
| BS-RoFormer SW (`BS-Rofo-SW-Fixed.ckpt`) | Six stems: bass, drums, other, vocals, guitar, piano | Trained by "jarredou". The original upload is gone; identical copies exist on several Hugging Face repositories | Tagged MIT or non-commercial by different copies, but unconfirmed. The original upload is no longer available, so I could not ask the trainer. If you have more information, contact me at lydianmelody@outlook.com. |
| Mel-Band RoFormer lead/rhythm guitar (`model_mel_band_roformer_ep_72_sdr_3.2232.ckpt`) | Lead guitar (rhythm is the remainder) | Uploaded by "listra92" (`listra92/MyModels`) | Tagged OpenRAIL++ but unconfirmed. I unsuccessfully tried to contact the uploader. If you have more information, contact me at lydianmelody@outlook.com. |
| Model code (`ZFTurbo/Music-Source-Separation-Training`, commit `84b1eac`) | Runs the two models | GitHub | MIT |

Chord Buddy does not include or redistribute these weights; each person downloads them from the public copies listed in `chordbuddy/model_downloads.py`.

I want to use these models the way their makers intended. If you made one of them, or know its terms, please email me at lydianmelody@outlook.com or [open an issue on GitHub](https://github.com/LydianMelody/ChordBuddy/issues). I will follow whatever they require, including removing the model from Chord Buddy.
