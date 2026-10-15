# Take Chord Buddy home

## What to copy

Use the built **ChordBuddy-Portable** folder, not the original development folder. Copy the entire folder to your external drive, including hidden .models files. The package includes Python, CPU inference dependencies, model weights and FFmpeg. It needs a 64-bit Intel/AMD Windows PC and a writable location. It does not require Codex to run.

On the home PC, open **Start Chord Buddy.cmd** (or **Start Portable.cmd**) inside that folder. Keeping the folder on the external drive works; copying it to a local SSD may load the model faster. You may rename or move the whole folder. Keep all its contents together.

The native window uses Microsoft WebView2 and Windows' .NET Framework. If the native window cannot open, try **Start in browser.cmd**, which uses your installed browser and keeps a small console open. Close the browser tab and press Ctrl+C in that console when finished. No system settings or runtimes are installed automatically.

The bundle uses CPU inference. Automatic will still use CPU with this packaged runtime. A compatible NVIDIA GPU needs a separately prepared CUDA package; this build has not been tested on the home PC.

## Bring your existing songs and Undo history

1. Close Chord Buddy and wait for any transcription or save to finish.
2. Open `%USERPROFILE%\Music\ChordBuddy` in File Explorer on this PC.
3. Copy **everything inside it**, including `library.sqlite3` and every song folder, into **ChordBuddy-Portable\Data**. Do this before adding songs to the portable library. If Data already contains a library, keep it separately; don't merge or overwrite two libraries.
4. Copy the whole portable folder onto your external drive.

Copying individual MIDI or ABC files does not carry set lists or Undo history. Data is the portable version's library and all new songs are saved there. The original Music library remains a separate copy; changes do not synchronize. Close the app before copying the library or unplugging the drive.

## Continue development at home

In Codex on the home PC, add this folder as a local project, start a chat, and say:

> Read HANDOFF.md and README.md, inspect the current implementation, and continue Chord Buddy development with me. Preserve my library and original model outputs.

The source, tests, design decisions and known limitations travel with this folder. Copying the folder does not copy this local Codex chat. Remote access to the original PC is another option if supported and configured, but this package does not depend on it.

## Package notes

Model access is set offline by the portable launcher. The bundle excludes account tokens, Codex credentials, pip download caches and personal chat history. No new downloads are needed for the pinned model. Standard Windows/browser components may still use their own OS storage; portable means the app runtime, model and music library travel together, not that Windows leaves zero traces.

Retain the bundled licenses. Models are for noncommercial use under their upstream terms; see README.md. This is a development build, not a signed installer. See docs/VERIFICATION.md for exactly what was tested.
