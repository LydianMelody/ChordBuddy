# GPU runtime

The portable runtime now includes official PyTorch 2.8.0+cu128 and matching torchaudio wheels. The previous CPU-only packages are preserved under backups/gpu-runtime-20260916-213253. CUDA 12.8 supports the RTX 5090; no separate CUDA toolkit installation is needed for these wheels.

Settings → Processing device offers Automatic, NVIDIA GPU only, and CPU only. Automatic chooses an available CUDA GPU or falls back to CPU. GPU only reports an error if CUDA is unavailable. The existing CPU fallback remains usable on other computers with this runtime.

Validation on this machine: NVIDIA RTX 5090, driver 616.56; real CUDA matrix multiplication; real SheetSage2 inference on a generated clip with CUDA, bfloat16 autocasting, and approximately 3370 MiB peak GPU memory. For the 12-second synthetic clip, model processing took approximately 2 seconds on CUDA versus 55 seconds in the earlier CPU check. This is a small synthetic comparison, not a full-song speed guarantee. Startup and model loading add time.

The GPU synthetic checks produced musical outputs but exposed an upstream strict notation-grid error at a clip endpoint. Those checks do not establish successful ABC export for every song. Partial output handling continues to preserve musical outputs and the previous active transcription.

Restart Chord Buddy after installation. Reprocessing is required to test the new runtime on an existing song. No song data was changed during installation.
