// rmch-inject.exe — injects a hook DLL into a running game process, or
// launches a game with the hook already in place before its code runs.
//
// Usage:
//   rmch-inject.exe --crt --pid <pid> --dll <path>   CreateRemoteThread+LoadLibraryW
//   rmch-inject.exe --wh  --pid <pid> --dll <path>   SetWindowsHookEx(WH_GETMESSAGE)
//                                                  on the target's main window thread;
//                                                  prints "armed", waits for "done" on
//                                                  stdin (or EOF/timeout), then unhooks.
//   rmch-inject.exe --oep --exe <path> --dll <path> [--env K=V ...] [-- <args>]
//                                                  入口点注入 (Early Bird): create the
//                                                  game suspended, queue LoadLibraryW
//                                                  as an APC on its initial thread,
//                                                  resume. The DLL loads before any
//                                                  game code runs. Prints "ok pid <n>".
//
// Exit codes: 0 ok · 2 open/create process failed · 3 bitness mismatch ·
//             4 remote alloc/write failed · 5 remote thread/context failed ·
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
static bool g_oepMode = false;
static DWORD g_pid = 0;
static WCHAR g_dll[MAX_PATH];
static WCHAR g_exe[MAX_PATH];
static bool g_inheritStdio = false;
// --env K=V pairs (wide, "K=V" each), appended over the inherited environment.
static WCHAR g_env[64][512];
static int g_envCount = 0;
// Everything after "--": the game's own command-line tail (ANSI as received).
static char g_args[1024];

static bool widenArg(const char* p, WCHAR* out, int cap) {
  // argv arrives in the ANSI codepage (MinGW CRT startup); widen with the
  // real conversion so non-ASCII project paths (Chinese, etc.) survive.
  int wn = MultiByteToWideChar(CP_ACP, 0, p, -1, NULL, 0);
  if (wn <= 0 || wn > cap) return false;
  MultiByteToWideChar(CP_ACP, 0, p, -1, out, wn);
  return true;
}

static bool parseArgs(int argc, char** argv) {
  g_dll[0] = 0;
  g_exe[0] = 0;
  g_args[0] = 0;
  for (int i = 1; i < argc; i++) {
    const char* a = argv[i];
    if (strcmp(a, "--wh") == 0) { g_whMode = true; g_oepMode = false; }
    else if (strcmp(a, "--crt") == 0) { g_whMode = false; g_oepMode = false; }
    else if (strcmp(a, "--oep") == 0) { g_oepMode = true; g_whMode = false; }
    else if (strcmp(a, "--inherit-stdio") == 0) g_inheritStdio = true;
    else if (strcmp(a, "--pid") == 0 && i + 1 < argc) g_pid = (DWORD)strtoul(argv[++i], NULL, 10);
    else if (strcmp(a, "--dll") == 0 && i + 1 < argc) {
      if (!widenArg(argv[++i], g_dll, MAX_PATH)) return false;
    } else if (strcmp(a, "--exe") == 0 && i + 1 < argc) {
      if (!widenArg(argv[++i], g_exe, MAX_PATH)) return false;
    } else if (strcmp(a, "--env") == 0 && i + 1 < argc) {
      if (g_envCount >= 64) return false;
      if (!widenArg(argv[++i], g_env[g_envCount], 512)) return false;
      g_envCount++;
    } else if (strcmp(a, "--") == 0) {
      // The game's own arguments, joined with spaces (games take none in
      // practice — protected shells refuse them all).
      g_args[0] = 0;
      for (int j = i + 1; j < argc; j++) {
        if (g_args[0]) strncat(g_args, " ", sizeof(g_args) - strlen(g_args) - 1);
        strncat(g_args, argv[j], sizeof(g_args) - strlen(g_args) - 1);
      }
      break;
    }
  }
  if (g_dll[0] == 0) return false;
  if (g_oepMode) return g_exe[0] != 0;
  return g_pid != 0;
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

// --- OEP mode (入口点注入) ---------------------------------------------------
//
// Early Bird: create the game suspended, write the DLL path into the target,
// and queue LoadLibraryW as an APC on the suspended initial thread. The thread
// turns alertable during the loader's own initialization, so the hook DLL's
// DllMain completes before the exe's entry point runs — no entry patch, no
// code cave, and nothing patched or parked in the game's memory afterwards
// (only the one committed page holding the path string).
//
// LoadLibraryW's address is read from OUR OWN kernel32 mapping: system DLLs
// share their base across all processes for the boot's lifetime, so the
// address is valid in the fresh target (the same assumption --crt makes).

static int exeMachine(const WCHAR* file, WORD* machine) {
  HANDLE h = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL,
                         OPEN_EXISTING, 0, NULL);
  if (h == INVALID_HANDLE_VALUE) return 2;
  unsigned char head[1024];
  DWORD got = 0;
  int rc = 2;
  if (ReadFile(h, head, sizeof(head), &got, NULL) && got >= sizeof(head) &&
      head[0] == 'M' && head[1] == 'Z') {
    DWORD pe = *(DWORD*)(head + 0x3c);
    if (pe + 6 <= sizeof(head) && memcmp(head + pe, "PE\0\0", 4) == 0) {
      *machine = *(WORD*)(head + pe + 4);
      rc = 0;
    }
  }
  CloseHandle(h);
  return rc;
}

// The environment block for the game: the inherited one with our --env keys
// appended. GetEnvironmentVariable reads the FIRST occurrence in the block,
// so overridden keys are removed from the inherited copy before appending.
// Double-NUL terminated Unicode strings.
static WCHAR* buildEnvironmentBlock() {
  LPWCH inherited = GetEnvironmentStringsW();
  if (!inherited) return NULL;
  size_t cap = 65536;
  WCHAR* block = (WCHAR*)HeapAlloc(GetProcessHeap(), 0, cap * sizeof(WCHAR));
  if (!block) { FreeEnvironmentStringsW(inherited); return NULL; }
  size_t len = 0;
  for (LPWCH p = inherited; *p;) {
    size_t entryLen = wcslen(p) + 1;
    bool overridden = false;
    for (int i = 0; i < g_envCount; i++) {
      const WCHAR* eq = wcschr(g_env[i], L'=');
      if (!eq) continue;
      size_t keyLen = (size_t)(eq - g_env[i]);
      if (_wcsnicmp(p, g_env[i], keyLen) == 0 && p[keyLen] == L'=') {
        overridden = true;
        break;
      }
    }
    if (!overridden && len + entryLen < cap - 2) {
      memcpy(block + len, p, entryLen * sizeof(WCHAR));
      len += entryLen;
    }
    p += entryLen;
  }
  FreeEnvironmentStringsW(inherited);
  for (int i = 0; i < g_envCount; i++) {
    size_t entryLen = wcslen(g_env[i]) + 1;
    if (len + entryLen >= cap - 2) break;
    memcpy(block + len, g_env[i], entryLen * sizeof(WCHAR));
    len += entryLen;
  }
  block[len] = 0;
  block[len + 1] = 0;
  return block;
}

static int injectOep() {
  WORD machine = 0;
  int mrc = exeMachine(g_exe, &machine);
  if (mrc) {
    fprintf(stderr, "exe unreadable or not a PE: %d\n", mrc);
    return 2;
  }
#ifdef _WIN64
  const WORD want = 0x8664;
  const char* selfArch = "x64";
#else
  const WORD want = 0x014c;
  const char* selfArch = "x86";
#endif
  if (machine != want) {
    fprintf(stderr, "bitness mismatch: injector=%s target machine=0x%x\n",
            selfArch, machine);
    return 3;
  }

  WCHAR* envBlock = buildEnvironmentBlock();
  WCHAR cmdline[MAX_PATH + 64];
  // CreateProcess wants a mutable command line; argv[0] is the exe path.
  _snwprintf(cmdline, MAX_PATH + 64, L"\"%s\" ", g_exe);
  if (g_args[0]) {
    WCHAR wide[1024];
    if (widenArg(g_args, wide, 1024)) {
      wcsncat(cmdline, wide, MAX_PATH + 64 - wcslen(cmdline) - 1);
    }
  }

  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  if (g_inheritStdio) {
    // Self-test mode: the target's stdout arrives through our own stdout pipe.
    si.dwFlags |= STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  }
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  DWORD createFlags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  WCHAR cwd[MAX_PATH];
  wcscpy(cwd, g_exe);
  WCHAR* slash = wcsrchr(cwd, L'\\');
  if (slash) *slash = 0; else cwd[0] = 0;

  if (!CreateProcessW(g_exe, cmdline, NULL, NULL, g_inheritStdio ? TRUE : FALSE,
                      createFlags, envBlock, cwd[0] ? cwd : NULL, &si, &pi)) {
    fprintf(stderr, "CreateProcess failed: %lu\n", GetLastError());
    if (envBlock) HeapFree(GetProcessHeap(), 0, envBlock);
    return 2;
  }
  if (envBlock) HeapFree(GetProcessHeap(), 0, envBlock);

  int rc = 5;
  HANDLE hProc = pi.hProcess;
  HANDLE hThread = pi.hThread;
  do {
    // 入口点注入 via Early Bird: the DLL path is written into the target, then
    // LoadLibraryW is queued as an APC on the suspended initial thread. The
    // thread turns alertable during the loader's own init (before the exe's
    // entry point runs), so the hook DLL's DllMain completes before any game
    // code — no cave, no entry patch, no stack games. The on-disk file is
    // never touched and the game's memory keeps no trace of a patch.
    SIZE_T pathBytes = (wcslen(g_dll) + 1) * sizeof(WCHAR);
    LPVOID remote = VirtualAllocEx(hProc, NULL, pathBytes,
                                   MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
      fprintf(stderr, "VirtualAllocEx failed: %lu\n", GetLastError());
      rc = 4;
      break;
    }
    if (!WriteProcessMemory(hProc, remote, g_dll, pathBytes, NULL)) {
      fprintf(stderr, "WriteProcessMemory failed: %lu\n", GetLastError());
      rc = 4;
      break;
    }
    PAPCFUNC loadLib =
        (PAPCFUNC)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    // The APC parameter is the path pointer (LoadLibraryW's first arg rides in
    // rcx either way on x64; on x86 the APC call passes one ULONG_PTR).
    if (!QueueUserAPC(loadLib, hThread, (ULONG_PTR)remote)) {
      fprintf(stderr, "QueueUserAPC failed: %lu\n", GetLastError());
      rc = 5;
      break;
    }
    if (ResumeThread(hThread) == (DWORD)-1) {
      fprintf(stderr, "ResumeThread failed: %lu\n", GetLastError());
      break;
    }
    printf("ok pid %lu\n", (unsigned long)pi.dwProcessId);
    fflush(stdout);
    rc = 0;
  } while (0);

  if (rc != 0) {
    TerminateProcess(hProc, 1); // never leave a half-launched game behind
  }
  CloseHandle(hThread);
  CloseHandle(hProc);
  return rc;
}

int main(int argc, char** argv) {
  if (!parseArgs(argc, argv)) {
    fprintf(stderr, "usage: rmch-inject.exe [--crt|--wh] --pid <pid> --dll <path>\n"
                    "       rmch-inject.exe --oep --exe <path> --dll <path> [--env K=V ...] [-- <args>]\n");
    return 1;
  }
  if (g_oepMode) return injectOep();
  return g_whMode ? injectWh() : injectCrt();
}
