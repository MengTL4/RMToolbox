# Poll visible top-level windows; screenshot any whose title matches the game
# or looks like an error dialog. Usage: python tools/winwatch.py <outdir> <rounds>
import ctypes
import ctypes.wintypes as w
import os
import subprocess
import sys
import time

outdir = sys.argv[1]
rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 40
os.makedirs(outdir, exist_ok=True)

EnumWindows = ctypes.windll.user32.EnumWindows
IsWindowVisible = ctypes.windll.user32.IsWindowVisible
GetWindowTextLengthW = ctypes.windll.user32.GetWindowTextLengthW
GetWindowTextW = ctypes.windll.user32.GetWindowTextW
GetClassNameW = ctypes.windll.user32.GetClassNameW


def list_windows():
    found = []

    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def cb(hwnd, lp):
        if IsWindowVisible(hwnd):
            ln = GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(max(ln, 1) + 1)
            GetWindowTextW(hwnd, buf, ln + 1)
            cls = ctypes.create_unicode_buffer(256)
            GetClassNameW(hwnd, cls, 256)
            found.append((hwnd, cls.value, buf.value))
        return True

    EnumWindows(cb, 0)
    return found


seen_titles = set()
for i in range(rounds):
    wins = list_windows()
    interesting = []
    for hwnd, cls, title in wins:
        # #32770 is the Win32 dialog class — RGSS script errors are MessageBoxes
        if cls == "#32770" or "BLACK SOULS" in title or "RGSS" in title or "Error" in title.lower():
            interesting.append((hwnd, cls, title))
    if interesting:
        stamp = time.strftime("%H%M%S")
        for hwnd, cls, title in interesting:
            key = (cls, title)
            tag = f"{stamp}_{abs(hash(key)) % 9999}"
            print(f"[{stamp}] cls={cls} title={title!r}", flush=True)
            # dialog popups: always shoot; game window: only when a dialog coexists or first sighting
            if cls == "#32770" or key not in seen_titles:
                subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "winshot.py"),
                                title, os.path.join(outdir, f"{tag}.png")],
                               capture_output=True)
                seen_titles.add(key)
    time.sleep(4)
print("watch done", flush=True)
