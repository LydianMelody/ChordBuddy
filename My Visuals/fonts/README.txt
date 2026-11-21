FONTS
=====

Put font files here for visualizations to use (.woff2, .woff, .ttf or .otf, up to 8 MB each). Chord Buddy never changes or deletes
anything in this folder, and a visualization can only name a file in this exact folder, by its file name.

How it stays safe
- A visualization cannot point at any other folder or at the internet; it only names a file that is sitting here.
- Chord Buddy checks that each file really is a font before using it, and keeps it private to the visualization that asked for it.
- Only add fonts you trust and that you are allowed to use. Fonts under the SIL Open Font License are free to use and share.

Which files do my visualizations expect?
- Rose Window: DotGothic16-Regular.ttf (optional). A pixel font that also covers Japanese; Rose Window uses it for lyrics its own
  letters cannot draw. Without it, Rose Window draws those lyrics in the system font. DotGothic16 is on Google Fonts
  (fonts.google.com/specimen/DotGothic16); download it, then copy the .ttf file in here with exactly that name.
- Each visualization lists the font files it expects in its first lines.

Changed a font here? Saving or replacing a file is picked up the next time the visualization loads (edit and save the visualization,
or reopen the visualizer).
