"""Start Replace a Stem beside Chord Buddy: the same folder, the same library (Data), its own window. See stem_tool/__init__.py."""
import sys
import traceback
from pathlib import Path


def main():
    project = Path(__file__).resolve().parent
    sys.path.insert(0, str(project))
    args = sys.argv[1:]
    library = Path(args[args.index('--library') + 1]) if '--library' in args else project / 'Data'
    from stem_tool.window import run
    return run(library, project)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        # started without a console (pythonw), so an error would otherwise vanish
        try:
            from tkinter import messagebox
            messagebox.showerror('Replace a Stem', 'Replace a Stem could not start.\n\n' + traceback.format_exc()[-1500:])
        finally:
            raise SystemExit(1)
