# One-off screenshot helper: capture a window by title substring via
# PrintWindow(PW_RENDERFULLCONTENT), which renders even occluded NW.js windows.
# Usage: python tools/winshot.py <title-substring> <out.png>
import ctypes
import ctypes.wintypes as w
import struct
import sys
import zlib
from ctypes import windll

PW_RENDERFULLCONTENT = 0x00000002


def find_window(title_part):
    found = []

    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def cb(hwnd, lp):
        if windll.user32.IsWindowVisible(hwnd):
            ln = windll.user32.GetWindowTextLengthW(hwnd)
            if ln:
                buf = ctypes.create_unicode_buffer(ln + 1)
                windll.user32.GetWindowTextW(hwnd, buf, ln + 1)
                if title_part in buf.value:
                    found.append(hwnd)
        return True

    windll.user32.EnumWindows(cb, 0)
    return found[0] if found else None


def png(width, height, rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    scan = b"".join(b"\x00" + row for row in rows)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scan, 6))
            + chunk(b"IEND", b""))


def main():
    title, out = sys.argv[1], sys.argv[2]
    hwnd = find_window(title)
    if not hwnd:
        print("window not found:", title)
        sys.exit(1)
    rect = w.RECT()
    windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
    wd, ht = rect.right - rect.left, rect.bottom - rect.top
    hdc_win = windll.user32.GetWindowDC(hwnd)
    hdc_mem = windll.gdi32.CreateCompatibleDC(hdc_win)
    hbm = windll.gdi32.CreateCompatibleBitmap(hdc_win, wd, ht)
    windll.gdi32.SelectObject(hdc_mem, hbm)
    if not windll.user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT):
        print("PrintWindow failed")
        sys.exit(1)

    class BIH(ctypes.Structure):
        _fields_ = [("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG),
                    ("biPlanes", w.WORD), ("biBitCount", w.WORD), ("biCompression", w.DWORD),
                    ("biSizeImage", w.DWORD), ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG),
                    ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD)]

    bih = BIH()
    bih.biSize = 40
    bih.biWidth = wd
    bih.biHeight = -ht
    bih.biPlanes = 1
    bih.biBitCount = 32
    buf = (ctypes.c_char * (wd * ht * 4))()
    windll.gdi32.GetDIBits(hdc_mem, hbm, 0, ht, buf, ctypes.byref(bih), 0)
    windll.gdi32.DeleteObject(hbm)
    windll.gdi32.DeleteDC(hdc_mem)
    windll.user32.ReleaseDC(hwnd, hdc_win)
    raw = buf.raw
    rows = []
    for y in range(ht):
        row = raw[y * wd * 4:(y + 1) * wd * 4]
        rows.append(bytes(c for i in range(0, len(row), 4) for c in (row[i + 2], row[i + 1], row[i])))
    with open(out, "wb") as fh:
        fh.write(png(wd, ht, rows))
    print("saved", out, wd, "x", ht)


if __name__ == "__main__":
    main()
