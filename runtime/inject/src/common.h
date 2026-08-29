// RMCH inject — shared helpers: named-pipe frame protocol + JSON escaping.
//
// Protocol on \\.\pipe\rmch-attach-<pid> (the DLL always computes the name
// from its OWN process id, so no parameter passing into the target is needed):
//
//   DLL -> core : {"t":"ready","dll":"...","arch":"x86"|"x64"}
//   core -> DLL : one raw frame = bootstrap source text (UTF-8)
//   DLL -> core : {"t":"result","ok":bool,"detail":"..."}
//
// Frames are length-prefixed: u32 little-endian length + payload bytes.
//
// Pure C style on purpose: no libstdc++ dependency at all (the MSYS2 GCC 16 /
// binutils 2.46 combo cannot statically link libstdc++, and tiny injection
// binaries want zero runtime deps anyway). Linked with -nostdlib++.
#ifndef RMCH_INJECT_COMMON_H
#define RMCH_INJECT_COMMON_H

#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

// Minimal debug log: one line per call to %TEMP%\rmch-<tag>-<pid>.log.
// Always on — it only fires during the (short) attach window and is the only
// window we have into a remote process we did not launch.
inline void dbgLog(const char* tag, const char* fmt, ...) {
  char path[MAX_PATH];
  DWORD n = GetTempPathA(MAX_PATH, path);
  if (n == 0 || n >= MAX_PATH - 64) return;
  _snprintf(path + n, MAX_PATH - n, "rmch-%s-%lu.log", tag, (unsigned long)GetCurrentProcessId());
  path[MAX_PATH - 1] = 0;
  FILE* f = fopen(path, "ab");
  if (!f) return;
  fprintf(f, "[%08lu t%lu] ", (unsigned long)GetTickCount(), (unsigned long)GetCurrentThreadId());
  va_list ap;
  va_start(ap, fmt);
  vfprintf(f, fmt, ap);
  va_end(ap);
  fputc('\n', f);
  fclose(f);
}

// Caller-provided growable buffer (heap-backed), to replace std::string.
struct Buf {
  char* data;
  DWORD len;
  DWORD cap;
};

inline void bufInit(Buf* b) { b->data = NULL; b->len = 0; b->cap = 0; }

inline void bufFree(Buf* b) {
  if (b->data) HeapFree(GetProcessHeap(), 0, b->data);
  bufInit(b);
}

inline bool bufReserve(Buf* b, DWORD cap) {
  if (b->cap >= cap) return true;
  DWORD ncap = b->cap ? b->cap : 4096;
  while (ncap < cap) ncap *= 2;
  char* nd = (char*)(b->data ? HeapReAlloc(GetProcessHeap(), 0, b->data, ncap)
                             : HeapAlloc(GetProcessHeap(), 0, ncap));
  if (!nd) return false;
  b->data = nd;
  b->cap = ncap;
  return true;
}

inline bool bufAppend(Buf* b, const char* s, DWORD len) {
  if (!bufReserve(b, b->len + len + 1)) return false;
  memcpy(b->data + b->len, s, len);
  b->len += len;
  b->data[b->len] = 0;
  return true;
}

inline bool bufAppendStr(Buf* b, const char* s) { return bufAppend(b, s, (DWORD)strlen(s)); }

inline void pipeNameForPid(DWORD pid, char out[64]) {
  _snprintf(out, 64, "\\\\.\\pipe\\rmch-attach-%lu", (unsigned long)pid);
  out[63] = 0;
}

// Connect to the core's pipe server for this process, retrying while the
// server may still be starting. Returns INVALID_HANDLE_VALUE on timeout.
inline HANDLE pipeConnect(DWORD timeoutMs) {
  char name[64];
  pipeNameForPid(GetCurrentProcessId(), name);
  DWORD waited = 0;
  for (;;) {
    HANDLE h = CreateFileA(name, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                           OPEN_EXISTING, 0, NULL);
    if (h != INVALID_HANDLE_VALUE) return h;
    DWORD err = GetLastError();
    if (err == ERROR_PIPE_BUSY) {
      if (WaitNamedPipeA(name, 500)) continue;
    }
    if (waited >= timeoutMs) return INVALID_HANDLE_VALUE;
    Sleep(200);
    waited += 200;
  }
}

inline bool pipeWriteAll(HANDLE h, const void* data, DWORD len) {
  const char* p = (const char*)data;
  DWORD left = len;
  while (left > 0) {
    DWORD wrote = 0;
    if (!WriteFile(h, p, left, &wrote, NULL)) return false;
    p += wrote;
    left -= wrote;
  }
  return true;
}

inline bool pipeReadAll(HANDLE h, void* data, DWORD len) {
  char* p = (char*)data;
  DWORD left = len;
  while (left > 0) {
    DWORD got = 0;
    if (!ReadFile(h, p, left, &got, NULL)) return false;
    if (got == 0) return false;
    p += got;
    left -= got;
  }
  return true;
}

inline bool pipeWriteFrame(HANDLE h, const void* data, DWORD len) {
  unsigned char hdr[4];
  hdr[0] = (unsigned char)(len & 0xFF);
  hdr[1] = (unsigned char)((len >> 8) & 0xFF);
  hdr[2] = (unsigned char)((len >> 16) & 0xFF);
  hdr[3] = (unsigned char)((len >> 24) & 0xFF);
  return pipeWriteAll(h, hdr, 4) && (len == 0 || pipeWriteAll(h, data, len));
}

// Reads one frame into a Buf (heap-grows, NUL-terminated). Returns false on
// disconnect/protocol error/oversize.
inline bool pipeReadFrame(HANDLE h, Buf* out, DWORD cap) {
  unsigned char hdr[4];
  if (!pipeReadAll(h, hdr, 4)) return false;
  DWORD len = (DWORD)hdr[0] | ((DWORD)hdr[1] << 8) | ((DWORD)hdr[2] << 16) | ((DWORD)hdr[3] << 24);
  if (len > cap) return false;
  if (!bufReserve(out, len + 1)) return false;
  out->len = len;
  if (len > 0 && !pipeReadAll(h, out->data, len)) return false;
  out->data[len] = 0;
  return true;
}

// Appends s to out as a JSON string literal (with surrounding quotes).
inline bool jsonAppendEscaped(Buf* out, const char* s) {
  if (!bufAppend(out, "\"", 1)) return false;
  for (const char* p = s; *p; p++) {
    unsigned char c = (unsigned char)*p;
    switch (c) {
      case '"': if (!bufAppendStr(out, "\\\"")) return false; break;
      case '\\': if (!bufAppendStr(out, "\\\\")) return false; break;
      case '\n': if (!bufAppendStr(out, "\\n")) return false; break;
      case '\r': if (!bufAppendStr(out, "\\r")) return false; break;
      case '\t': if (!bufAppendStr(out, "\\t")) return false; break;
      default:
        if (c < 0x20) {
          char hex[8];
          _snprintf(hex, sizeof(hex), "\\u%04x", c);
          if (!bufAppendStr(out, hex)) return false;
        } else {
          if (!bufAppend(out, (const char*)p, 1)) return false;
        }
    }
  }
  return bufAppend(out, "\"", 1);
}

inline const char* archName() {
#ifdef _WIN64
  return "x64";
#else
  return "x86";
#endif
}

inline void pipeSendJson(HANDLE h, const char* json, DWORD len) {
  pipeWriteFrame(h, json, len);
}

// {"t":"ready","dll":"<dllName>","arch":"<arch>"}
inline void pipeSendReady(HANDLE h, const char* dllName) {
  Buf j;
  bufInit(&j);
  bufAppendStr(&j, "{\"t\":\"ready\",\"dll\":");
  jsonAppendEscaped(&j, dllName);
  bufAppendStr(&j, ",\"arch\":");
  jsonAppendEscaped(&j, archName());
  bufAppendStr(&j, "}");
  if (j.data) pipeSendJson(h, j.data, j.len);
  bufFree(&j);
}

// {"t":"result","ok":bool,"detail":"..."} — detail is printf-style.
inline void pipeSendResult(HANDLE h, bool ok, const char* detailFmt, ...) {
  char detail[512];
  va_list ap;
  va_start(ap, detailFmt);
  _vsnprintf(detail, sizeof(detail), detailFmt, ap);
  va_end(ap);
  detail[sizeof(detail) - 1] = 0;

  Buf j;
  bufInit(&j);
  bufAppendStr(&j, "{\"t\":\"result\",\"ok\":");
  bufAppendStr(&j, ok ? "true" : "false");
  bufAppendStr(&j, ",\"detail\":");
  jsonAppendEscaped(&j, detail);
  bufAppendStr(&j, "}");
  if (j.data) pipeSendJson(h, j.data, j.len);
  bufFree(&j);
}

#endif // RMCH_INJECT_COMMON_H
