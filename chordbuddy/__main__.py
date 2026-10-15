"""Desktop launcher; --headless and --library support isolated verification."""
import argparse
import json
import os
from pathlib import Path
import threading
import webbrowser

from .server import make_server


class NativeCloseGuard:
    """Veto native closing until every pending browser edit has been saved."""
    def __init__(self,window):
        self.window=window
        self.loaded=False
        self.flushing=False
        self.approved=False
        self.lock=threading.Lock()

    def on_loaded(self,*args):
        self.loaded=True

    def _show_error(self,message):
        script=("typeof window.chordBuddyShowCloseError === 'function' && "
                "window.chordBuddyShowCloseError("+json.dumps(message)+")")
        try:
            self.window.evaluate_js(script)
        except Exception:
            # The close remains vetoed if the page is temporarily unavailable.
            pass

    def on_closing(self,*args):
        if not self.loaded:
            return True
        with self.lock:
            if self.approved:
                self.approved=False
                return True
            if self.flushing:
                return False
            self.flushing=True
        # WinForms executes closing on the UI thread. EdgeChromium's JS
        # evaluator waits for that thread, so veto first and evaluate elsewhere.
        threading.Thread(target=self._check_and_flush,daemon=True).start()
        return False

    def _pending(self):
        return self.window.evaluate_js("typeof window.chordBuddyHasPendingEdits === 'function' && window.chordBuddyHasPendingEdits()")

    def _check_and_flush(self):
        try:
            pending=self._pending()
        except Exception:
            with self.lock:
                self.flushing=False
            self._show_error('Could not check whether your edits finished saving. Keep this window open and try closing again.')
            return
        if not pending:
            self._approve_close()
            return
        script=("(async function(){try{return await window.chordBuddyFlush();}"
                "catch(error){return {ok:false,pending:[{error:String(error)}]};}})()")
        try:
            # pywebview resolves this Promise on its callback thread.
            self.window.evaluate_js(script,callback=self._flushed)
        except Exception as exc:
            with self.lock:
                self.flushing=False
            self._show_error(f'Your edits could not finish saving: {exc}. Keep this window open and retry before closing.')

    def _approve_close(self):
        with self.lock:
            self.flushing=False
            self.approved=True
        self.window.destroy()

    def _flushed(self,result):
        threading.Thread(target=self._finish_flush,args=(result,),daemon=True).start()

    def _finish_flush(self,result):
        if isinstance(result,dict) and result.get('ok') is True:
            # Check again on a background thread before approving native close.
            self._check_and_flush()
            return
        with self.lock:
            self.flushing=False
        errors=[]
        if isinstance(result,dict) and isinstance(result.get('pending'),list):
            errors=[str(item.get('error')) for item in result['pending'] if isinstance(item,dict) and item.get('error')]
        detail='; '.join(dict.fromkeys(errors)) or 'A save is still pending or did not finish.'
        self._show_error('Your edits could not finish saving. '+detail+' Keep this window open and retry the failed save before closing.')


def main():
    parser=argparse.ArgumentParser(description='Chord Buddy music transcription workspace')
    parser.add_argument('--library',type=Path,default=Path(os.environ.get('USERPROFILE',str(Path.home())))/'Music'/'ChordBuddy')
    parser.add_argument('--port',type=int,default=0)
    parser.add_argument('--browser',action='store_true')
    parser.add_argument('--headless',action='store_true')
    parser.add_argument('--session-file',type=Path,help='Write local test URL to this file')
    args=parser.parse_args()
    server=make_server(args.library,args.port)
    url=f'http://127.0.0.1:{server.server_port}/#token={server.app.token}'
    if args.session_file:
        args.session_file.write_text(url,encoding='utf-8')
    if args.headless:
        print('Chord Buddy is running on local port',server.server_port,flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.app.engine.cancel()
        finally:
            server.server_close()
        return
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        if args.browser:
            webbrowser.open(url)
            thread.join()
        else:
            import webview
            window=webview.create_window('Chord Buddy',url,width=1320,height=880,min_size=(960,650),background_color='#f6f3eb')
            close_guard=NativeCloseGuard(window)
            window.events.loaded += close_guard.on_loaded
            window.events.closing += close_guard.on_closing
            webview.settings['ALLOW_DOWNLOADS']=True   # exports (mix, charts) are saved through the window's Save dialog
            webview.start(gui='edgechromium' if os.name=='nt' else None,private_mode=True)
    except KeyboardInterrupt:
        pass
    finally:
        server.app.engine.cancel()
        server.shutdown()
        server.server_close()


if __name__=='__main__':
    main()
