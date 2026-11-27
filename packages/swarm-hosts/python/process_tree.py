"""Stop what the client started, not just the client itself.

`Popen.terminate()` reaches the direct child only. A member's CLI spawns its own tool
subprocesses — a shell, a compiler, Blender — and those survive as orphans, so pressing
stop in the window left work visibly running afterwards. Each client is therefore put in
a job object that kills the whole tree, and an explicit tree walk covers the case where a
job could not be created.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import time

IS_WINDOWS = os.name == 'nt'

if IS_WINDOWS:
    _KERNEL = ctypes.WinDLL('kernel32', use_last_error=True)
    _TH32CS_SNAPPROCESS = 0x2
    _PROCESS_TERMINATE = 0x0001
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _STILL_ACTIVE = 259
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [('dwSize', wt.DWORD), ('cntUsage', wt.DWORD), ('th32ProcessID', wt.DWORD),
                    ('th32DefaultHeapID', ctypes.c_void_p), ('th32ModuleID', wt.DWORD),
                    ('cntThreads', wt.DWORD), ('th32ParentProcessID', wt.DWORD),
                    ('pcPriClassBase', wt.LONG), ('dwFlags', wt.DWORD),
                    ('szExeFile', ctypes.c_wchar * 260)]

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [('ReadOperationCount', ctypes.c_ulonglong),
                    ('WriteOperationCount', ctypes.c_ulonglong),
                    ('OtherOperationCount', ctypes.c_ulonglong),
                    ('ReadTransferCount', ctypes.c_ulonglong),
                    ('WriteTransferCount', ctypes.c_ulonglong),
                    ('OtherTransferCount', ctypes.c_ulonglong)]

    class _BASIC_LIMIT(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong),
                    ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', wt.DWORD),
                    ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t),
                    ('ActiveProcessLimit', wt.DWORD),
                    ('Affinity', ctypes.c_size_t),
                    ('PriorityClass', wt.DWORD),
                    ('SchedulingClass', wt.DWORD)]

    class _EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', _BASIC_LIMIT),
                    ('IoInfo', _IO_COUNTERS),
                    ('ProcessMemoryLimit', ctypes.c_size_t),
                    ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t),
                    ('PeakJobMemoryUsed', ctypes.c_size_t)]


def _snapshot():
    """Every live process as (pid, parent pid). One walk per call, no handle leaks."""
    if not IS_WINDOWS:
        return []
    rows = []
    snapshot = _KERNEL.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if snapshot in (None, -1):
        return rows
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        ok = _KERNEL.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            rows.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID)))
            ok = _KERNEL.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        _KERNEL.CloseHandle(snapshot)
    return rows


def alive(pid):
    if not IS_WINDOWS:
        return False
    handle = _KERNEL.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wt.DWORD()
        if not _KERNEL.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == _STILL_ACTIVE
    finally:
        _KERNEL.CloseHandle(handle)


def descendants(pid):
    """All live descendants of pid, children before their parents."""
    rows = _snapshot()
    children = {}
    for child, parent in rows:
        children.setdefault(parent, []).append(child)
    found = []
    pending = [int(pid)]
    while pending:
        current = pending.pop()
        for child in children.get(current, []):
            found.append(child)
            pending.append(child)
    return found


def _kill(pid):
    if not IS_WINDOWS:
        return
    handle = _KERNEL.OpenProcess(_PROCESS_TERMINATE, False, int(pid))
    if not handle:
        return
    try:
        _KERNEL.TerminateProcess(handle, 1)
    finally:
        _KERNEL.CloseHandle(handle)


def terminate_tree(pid, wait=1.5):
    """Kill descendants first so nothing respawns, then the process itself."""
    pid = int(pid)
    if not IS_WINDOWS:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        return
    for child in reversed(descendants(pid)):
        _kill(child)
    _kill(pid)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not alive(pid) and not any(alive(item) for item in descendants(pid)):
            return
        time.sleep(0.05)


class ClientJob:
    """A kill-on-close job: closing the handle takes the client's whole tree with it.

    This also covers the case the window cannot: 蜂群 itself being killed or crashing,
    which used to leave every running member's client alive and still spending quota.
    """

    def __init__(self):
        self.handle = None
        if not IS_WINDOWS:
            return
        try:
            handle = _KERNEL.CreateJobObjectW(None, None)
            if not handle:
                return
            info = _EXTENDED_LIMIT()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not _KERNEL.SetInformationJobObject(handle, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                                   ctypes.byref(info), ctypes.sizeof(info)):
                _KERNEL.CloseHandle(handle)
                return
            self.handle = handle
        except OSError:
            self.handle = None

    def attach(self, proc):
        """Returns True when the process is protected by the job."""
        if not self.handle or proc is None:
            return False
        try:
            return bool(_KERNEL.AssignProcessToJobObject(self.handle, int(proc._handle)))
        except (AttributeError, OSError, TypeError):
            return False

    def close(self, proc=None):
        """Kill the tree, then drop the handle. Both steps are safe to repeat."""
        if self.handle:
            try:
                _KERNEL.TerminateJobObject(self.handle, 1)
            except OSError:
                pass
            try:
                _KERNEL.CloseHandle(self.handle)
            except OSError:
                pass
            self.handle = None
        elif proc is not None and proc.poll() is None:
            terminate_tree(proc.pid)
