"""Windows suspended launch + kill-on-close job containment; no child escape window."""
import ctypes
from ctypes import wintypes as w
import os
import subprocess
class BASIC(ctypes.Structure):
    _fields_=[('PerProcessUserTimeLimit',ctypes.c_longlong),('PerJobUserTimeLimit',ctypes.c_longlong),('LimitFlags',w.DWORD),('MinimumWorkingSetSize',ctypes.c_size_t),('MaximumWorkingSetSize',ctypes.c_size_t),('ActiveProcessLimit',w.DWORD),('Affinity',ctypes.c_size_t),('PriorityClass',w.DWORD),('SchedulingClass',w.DWORD)]
class IO(ctypes.Structure):
    _fields_=[(name,ctypes.c_ulonglong) for name in ('ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount')]
class EXTENDED(ctypes.Structure):
    _fields_=[('BasicLimitInformation',BASIC),('IoInfo',IO),('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),('PeakProcessMemoryUsed',ctypes.c_size_t),('PeakJobMemoryUsed',ctypes.c_size_t)]

class OwnedProcess:
    def __init__(self,argv,*,cwd,env):
        self.job=None;self.process=None
        if os.name!='nt':raise RuntimeError('Contained separation currently requires Windows')
        k=ctypes.WinDLL('kernel32',use_last_error=True);self.k=k
        k.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR];k.CreateJobObjectW.restype=w.HANDLE
        k.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD];k.SetInformationJobObject.restype=w.BOOL
        k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE];k.AssignProcessToJobObject.restype=w.BOOL
        k.TerminateJobObject.argtypes=[w.HANDLE,w.UINT];k.TerminateJobObject.restype=w.BOOL
        k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL
        self.job=k.CreateJobObjectW(None,None)
        if not self.job:raise ctypes.WinError(ctypes.get_last_error())
        try:
            limits=EXTENDED();limits.BasicLimitInformation.LimitFlags=0x2000
            if not k.SetInformationJobObject(self.job,9,ctypes.byref(limits),ctypes.sizeof(limits)):raise ctypes.WinError(ctypes.get_last_error())
            self.process=subprocess.Popen(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW|4)
            if not k.AssignProcessToJobObject(self.job,w.HANDLE(int(self.process._handle))):raise ctypes.WinError(ctypes.get_last_error())
            # Popen closes the primary-thread handle. Resume via the owned process handle.
            resume=ctypes.WinDLL('ntdll').NtResumeProcess;resume.argtypes=[w.HANDLE];resume.restype=ctypes.c_long
            if resume(w.HANDLE(int(self.process._handle)))!=0:raise RuntimeError('Could not resume contained worker')
        except BaseException:
            if self.process:self.process.kill();self.process.wait()
            self.close();raise
    @property
    def stdout(self):return self.process.stdout
    def wait(self,timeout=None):return self.process.wait(timeout)
    def poll(self):return self.process.poll()
    def cancel(self):
        if self.job and not self.k.TerminateJobObject(self.job,1) and self.process.poll() is None:raise ctypes.WinError(ctypes.get_last_error())
    def close(self):
        if self.job:
            self.k.CloseHandle(self.job);self.job=None
        if self.process:
            self.process.wait()
            if self.process.stdout:self.process.stdout.close()
    def __enter__(self):return self
    def __exit__(self,*args):self.close()

