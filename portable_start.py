"""Launch the relocatable Windows bundle with its library and tools beside it."""
import os
from pathlib import Path
import sys
import traceback


def configure(project):
    from chordbuddy.engine import local_environment
    project=Path(project).resolve()
    if not (project/'portable.json').is_file():
        raise RuntimeError('This launcher belongs in the built ChordBuddy-Portable folder.')
    os.environ.pop('HF_TOKEN',None)
    os.environ.pop('HUGGING_FACE_HUB_TOKEN',None)
    os.environ.update(local_environment(project))
    os.environ['PATH']=str(project/'tools')+os.pathsep+os.environ.get('PATH','')
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    return project/'Data'


def main():
    project=Path(__file__).resolve().parent
    library=configure(project)
    args=sys.argv[1:]
    if '--check' in args:
        import json
        from chordbuddy.engine import Engine
        import mutagen, mido, webview, torch, torchaudio, transformers
        result=Engine(project,lambda *args:None).readiness()
        print(json.dumps({'engine':result,'python':sys.executable,'torch':torch.__version__,'library':str(library)}))
        return 0 if result['ready'] else 1
    if '--library' not in args:
        args=['--library',str(library)]+args
    sys.argv=[sys.argv[0]]+args
    from chordbuddy.__main__ import main as launch
    launch()
    return 0


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except Exception:
        log=Path(__file__).resolve().parent/'portable-error.log'
        log.write_text(traceback.format_exc(),encoding='utf-8')
        message='Chord Buddy could not start. See portable-error.log in this folder. If WebView2 is unavailable, try Start in browser.cmd.'
        if sys.stderr:
            print(message,file=sys.stderr)
        elif os.name=='nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,message,'Chord Buddy',0x10)
        raise SystemExit(1)
