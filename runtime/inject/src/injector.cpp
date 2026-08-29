// rmch-inject.exe — injects a hook DLL into a running game process.
//
// Usage:
//   rmch-inject.exe --crt --pid <pid> --dll <path>   CreateRemoteThread+LoadLibraryW
//   rmch-inject.exe --wh  --pid <pid> --dll <path>   SetWindowsHookEx(WH_GETMESSAGE)
//                                                  on the target's main window thread;
//                                                  prints "armed", waits for "done" on
//                                                  stdin (or EOF/timeout), then unhooks.
//
// Exit codes: 0 ok · 2 open process failed · 3 bitness mismatch ·
//             4 remote alloc/write failed · 5 remote thread failed/timeout ·
//             6 no window thread found (wh) · 7 hook/dll load failed (wh) ·
//             8 wait timed out (wh) · 1 bad args.
//
// The injector arch must match the target arch: the x86 build injects into
// 32-bit targets, the x64 build into 64-bit targets.

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool g_whMode = false;
static DWORD g_pid = 0;
static WCHAR g_dll[MAX_PATH];

static bool parseArgs(int argc, char** argv) {
  g_dll[0] = 0;
  for (int i = 1; i < argc; i++) {
    const char* a = argv[i];
    if (strcmp(a, "--wh") == 0) g_whMode = true;
    else if (strcmp(a, "--crt") == 0) g_whMode = false;
    else if (strcmp(a, "--pid") == 0 && i + 1 < argc) g_pid = (DWORD)strtoul(argv[++i], NULL, 10);
    else if (strcmp(a, "--dll") == 0 && i + 1 < argc) {
      const char* p = argv[++i];
      size_t n = strlen(p);
      if (n >= MAX_PATH) return false;
      for (size_t k = 0; k <= n; k++) g_dll[k] = (WCHAR)(unsigned char)p[k]; // ASCII widen
    }
  }
  return g_pid != 0 && g_dll[0] != 0;
}

static bool isTargetWow64(HANDLE hProc, bool* wow64) {
  typedef BOOL(WINAPI* IsWow64Process_t)(HANDLE, PBOOL);
  IsWow64Process_t fn =
      (IsWow64Process_t)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process");
  if (!fn) { *wow64 = false; return true; } // 32-bit OS
  BOOL w = FALSE;
  if (!fn(hProc, &w)) return false;
  *wow64 = (w != FALSE);
  return true;
}

// Returns 0 when arch matches, else 3.
static int checkBitness(HANDLE hProc) {
  bool targetWow64 = false;
  if (!isTargetWow64(hProc, &targetWow64)) return 0; // can't tell — proceed anyway
#ifdef _WIN64
  const bool injectorX86 = false;
#else
  const bool injectorX86 = true;
#endif
  if (injectorX86 != targetWow64) {
    fprintf(stderr, "bitness mismatch: injector=%s target=%s\n",
            injectorX86 ? "x86" : "x64", targetWow64 ? "x86" : "x64");
    return 3;
  }
  return 0;
}

static int injectCrt() {
  HANDLE hProc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION |
                                 PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_QUERY_INFORMATION,
                             FALSE, g_pid);
  if (!hProc) {
    fprintf(stderr, "OpenProcess failed: %lu\n", GetLastError());
    return 2;
  }
  int rc = checkBitness(hProc);
  if (rc) { CloseHandle(hProc); return rc; }

  SIZE_T bytes = (wcslen(g_dll) + 1) * sizeof(WCHAR);
  LPVOID remote = VirtualAllocEx(hProc, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!remote) {
    fprintf(stderr, "VirtualAllocEx failed: %lu\n", GetLastError());
    CloseHandle(hProc);
    return 4;
  }
  if (!WriteProcessMemory(hProc, remote, g_dll, bytes, NULL)) {
    fprintf(stderr, "WriteProcessMemory failed: %lu\n", GetLastError());
    VirtualFreeEx(hProc, remote, 0, MEM_RELEASE);
    CloseHandle(hProc);
    return 4;
  }
  LPTHREAD_START_ROUTINE loadLib =
      (LPTHREAD_START_ROUTINE)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
  HANDLE hThread = CreateRemoteThread(hProc, NULL, 0, loadLib, remote, 0, NULL);
  if (!hThread) {
    fprintf(stderr, "CreateRemoteThread failed: %lu\n", GetLastError());
    VirtualFreeEx(hProc, remote, 0, MEM_RELEASE);
    CloseHandle(hProc);
    return 5;
  }
  DWORD wait = WaitForSingleObject(hThread, 20000);
  DWORD exitCode = 0;
  GetExitCodeThread(hThread, &exitCode); // = HMODULE of the loaded DLL (truncated on x64)
  CloseHandle(hThread);
  VirtualFreeEx(hProc, remote, 0, MEM_RELEASE);
  CloseHandle(hProc);
  if (wait != WAIT_OBJECT_0) {
    fprintf(stderr, "remote thread wait failed/timeout: %lu\n", wait);
    return 5;
  }
  if (exitCode == 0) {
    fprintf(stderr, "LoadLibraryW returned NULL in target\n");
    return 5;
  }
  printf("ok\n");
  return 0;
}

// --- WH_GETMESSAGE mode -----------------------------------------------------

struct FindThreadCtx {
  DWORD pid;
  DWORD tid;   // chosen thread id
  int score;   // 0 none · 1 any window · 2 visible · 3 visible+titled
};

static BOOL CALLBACK enumWindowsCb(HWND hwnd, LPARAM lp) {
  FindThreadCtx* ctx = (FindThreadCtx*)lp;
  DWORD pid = 0;
  DWORD tid = GetWindowThreadProcessId(hwnd, &pid);
  if (pid != ctx->pid || tid == 0) return TRUE;
  int score = 1;
  if (IsWindowVisible(hwnd)) score = 2;
  if (score == 2 && GetWindowTextLengthW(hwnd) > 0) score = 3;
  if (score > ctx->score) {
    ctx->score = score;
    ctx->tid = tid;
  }
  return ctx->score < 3; // stop once we have a visible titled window
}

static int injectWh() {
  FindThreadCtx ctx;
  ctx.pid = g_pid;
  ctx.tid = 0;
  ctx.score = 0;
  EnumWindows(enumWindowsCb, (LPARAM)&ctx);
  if (!ctx.tid) {
    fprintf(stderr, "no window thread found for pid %lu\n", (unsigned long)g_pid);
    return 6;
  }

  HMODULE hMod = LoadLibraryW(g_dll); // local load: DllMain must stay inert
  if (!hMod) {
    fprintf(stderr, "local LoadLibraryW failed: %lu\n", GetLastError());
    return 7;
  }
  HOOKPROC proc = (HOOKPROC)GetProcAddress(hMod, "RmchHookProc");
  if (!proc) {
    fprintf(stderr, "RmchHookProc export missing\n");
    FreeLibrary(hMod);
    return 7;
  }

  HHOOK hHook = SetWindowsHookExW(WH_GETMESSAGE, proc, hMod, ctx.tid);
  if (!hHook) {
    fprintf(stderr, "SetWindowsHookExW failed: %lu\n", GetLastError());
    FreeLibrary(hMod);
    return 7;
  }
  // Wake the thread's message queue so the hook fires immediately.
  PostThreadMessageW(ctx.tid, WM_NULL, 0, 0);

  printf("armed\n");
  fflush(stdout);

  // Wait for the core to tell us the eval is done (or give up eventually).
  HANDLE hStdin = GetStdHandle(STD_INPUT_HANDLE);
  DWORD waited = 0;
  bool done = false;
  while (waited < 180000) {
    DWORD avail = 0;
    if (!PeekNamedPipe(hStdin, NULL, 0, NULL, &avail, NULL)) {
      DWORD err = GetLastError();
      if (err == ERROR_INVALID_HANDLE) {
        // stdin is not a pipe (launched manually) — plain timed wait.
        Sleep(500);
        waited += 500;
        continue;
      }
      break; // broken pipe / closed: core went away
    }
    if (avail > 0) {
      char buf[64];
      DWORD got = 0;
      if (ReadFile(hStdin, buf, sizeof(buf) - 1, &got, NULL) && got > 0) {
        buf[got] = 0;
        if (strstr(buf, "done")) { done = true; break; }
      }
    }
    Sleep(200);
    waited += 200;
  }
  UnhookWindowsHookEx(hHook);
  FreeLibrary(hMod); // only affects THIS process; the target keeps its own mapping
  if (!done && waited >= 180000) {
    fprintf(stderr, "timed out waiting for done\n");
    return 8;
  }
  printf("unhooked\n");
  return 0;
}

int main(int argc, char** argv) {
  if (!parseArgs(argc, argv)) {
    fprintf(stderr, "usage: rmch-inject.exe [--crt|--wh] --pid <pid> --dll <path>\n");
    return 1;
  }
  return g_whMode ? injectWh() : injectCrt();
}
