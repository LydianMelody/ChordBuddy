import os
import sys
import pytest
from chordbuddy.owned_process import OwnedProcess
@pytest.mark.skipif(os.name!='nt',reason='Windows containment')
def test_owned_process_output_and_cancel(tmp_path):
    with OwnedProcess([sys.executable,'-B','-c','print("owned",flush=True)'],cwd=tmp_path,env=os.environ.copy()) as proc:
        assert proc.stdout.readline().strip()=='owned'
        assert proc.wait()==0
    with OwnedProcess([sys.executable,'-B','-c','import time;time.sleep(30)'],cwd=tmp_path,env=os.environ.copy()) as proc:
        proc.cancel()
        assert proc.wait(timeout=5)!=0


@pytest.mark.skipif(os.name!='nt',reason='Windows containment')
def test_cancel_terminates_owned_grandchild(tmp_path):
    import ctypes
    from ctypes import wintypes as w
    code='import subprocess,sys,time;p=subprocess.Popen([sys.executable,"-B","-c","import time;time.sleep(30)"]);print(p.pid,flush=True);time.sleep(30)'
    with OwnedProcess([sys.executable,'-B','-c',code],cwd=tmp_path,env=os.environ.copy()) as proc:
        pid=int(proc.stdout.readline())
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];kernel.OpenProcess.restype=w.HANDLE
        kernel.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];kernel.WaitForSingleObject.restype=w.DWORD
        kernel.CloseHandle.argtypes=[w.HANDLE]
        handle=kernel.OpenProcess(0x100000,False,pid)
        assert handle
        try:
            proc.cancel();proc.wait(timeout=5)
            assert kernel.WaitForSingleObject(handle,5000)==0
        finally:kernel.CloseHandle(handle)
