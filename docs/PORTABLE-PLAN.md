# Portable Windows package

User wants to carry Chord Buddy to another Windows PC on an external drive and continue development. Package a separate folder; preserve working source and Music library.

- Bundle Python 3.11 base runtime with relative module paths, separate installed app/CPU engine packages, FFmpeg and existing pinned model snapshots. No copied virtual environments, account tokens, pip caches or personal chats.
- Portable launcher selects Data beside the app, project-local temp/model caches and offline model access; normal development launcher retains Music default. Provide browser fallback when WebView2 is unavailable.
- Include current source, tests and a durable development handoff; document manual library copying after closing the app.
- Verify imports, readiness and offline model loading using bundled Python with system Python/FFmpeg removed from PATH, then relocation to a different folder. Another physical PC is unavailable, so do not claim clean-machine verification.
