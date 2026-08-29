// rmch-rgsshook.dll — attaches to a running RPG Maker XP/VX/VXAce (RGSS) game.
//
// Loaded into the game by SetWindowsHookEx(WH_GETMESSAGE) on the game's main
// window thread, so our hook procedure executes ON the game's main thread —
// the same OS thread that owns the Ruby interpreter. That makes
// rb_eval_string_protect safe for every RGSS generation (Ruby 1.8 and 1.9
// alike): the engine itself evals scripts on exactly this thread.
//
// Flow:
//   hook proc (main thread, 1st message) → spawn worker thread
//   worker → pipe connect → "ready" → receive bootstrap Ruby source → set flag
//   hook proc (next message) → flag set → rb_eval_string_protect(bootstrap)
//   worker → report {"ok": status==0} → core tells injector to unhook
//
// The DLL also gets LoadLibrary'd inside the injector process itself (to
// obtain the HMODULE for SetWindowsHookEx). It must stay inert there: DllMain
// does nothing, and only the hook proc (never called in the injector) starts
// the worker.
//
// Pure C style, no libstdc++ (see common.h).

#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>

#include "common.h"

typedef uintptr_t(__cdecl* RbEvalStringProtect_t)(const char*, int*);
typedef uintptr_t(__cdecl* RbEvalString_t)(const char*);
typedef uintptr_t(__cdecl* RbProtect_t)(uintptr_t(__cdecl*)(uintptr_t), uintptr_t, int*);

static volatile LONG g_workerStarted = 0;
static volatile LONG g_evaled = 0;
static HANDLE g_evBootstrapReady = NULL;
static HANDLE g_evEvalDone = NULL;
static Buf g_bootstrap;
static int g_rubyStatus = -1;
static char g_rubyDetail[512];

static RbEvalStringProtect_t fpEvalProtect = NULL;
static RbEvalString_t fpEval = NULL;
static RbProtect_t fpProtect = NULL;

// Find the game's rgss*.dll module (the embedded Ruby interpreter) and resolve
// the eval entry points from it.
static bool resolveRuby() {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
                                         GetCurrentProcessId());
  if (snap == INVALID_HANDLE_VALUE) {
    strcpy(g_rubyDetail, "module-snapshot-failed");
    return false;
  }
  HMODULE rgss = NULL;
  MODULEENTRY32W me;
  me.dwSize = sizeof(me);
  for (BOOL ok = Module32FirstW(snap, &me); ok; ok = Module32NextW(snap, &me)) {
    const wchar_t* name = me.szModule;
    if ((name[0] == L'r' || name[0] == L'R') &&
        (name[1] == L'g' || name[1] == L'G') &&
        (name[2] == L's' || name[2] == L'S') &&
        (name[3] == L's' || name[3] == L'S')) {
      rgss = (HMODULE)me.hModule;
      break;
    }
  }
  CloseHandle(snap);
  if (!rgss) {
    strcpy(g_rubyDetail, "rgss-module-not-found");
    return false;
  }

  fpEvalProtect = (RbEvalStringProtect_t)(void*)GetProcAddress(rgss, "rb_eval_string_protect");
  if (!fpEvalProtect) {
    fpEval = (RbEvalString_t)(void*)GetProcAddress(rgss, "rb_eval_string");
    fpProtect = (RbProtect_t)(void*)GetProcAddress(rgss, "rb_protect");
  }
  if (!fpEvalProtect && !(fpEval && fpProtect)) {
    strcpy(g_rubyDetail, "ruby-symbols-missing");
    return false;
  }
  return true;
}

static uintptr_t __cdecl evalTrampoline(uintptr_t str) {
  return fpEval((const char*)str);
}

// Executed on the game's main thread from the hook proc.
static void doEval() {
  if (!resolveRuby()) {
    g_rubyStatus = -1;
    return; // g_rubyDetail already set
  }
  int status = 0;
  if (fpEvalProtect) {
    fpEvalProtect(g_bootstrap.data, &status);
  } else {
    fpProtect(evalTrampoline, (uintptr_t)g_bootstrap.data, &status);
  }
  g_rubyStatus = status;
  _snprintf(g_rubyDetail, sizeof(g_rubyDetail), "ruby-status-%d", status);
  g_rubyDetail[sizeof(g_rubyDetail) - 1] = 0;
}

static DWORD WINAPI workerThread(LPVOID) {
  HANDLE pipe = pipeConnect(15000);
  if (pipe == INVALID_HANDLE_VALUE) return 0;

  pipeSendReady(pipe, "rgsshook");

  bufInit(&g_bootstrap);
  if (!pipeReadFrame(pipe, &g_bootstrap, 4 * 1024 * 1024)) {
    pipeSendResult(pipe, false, "bootstrap-read-failed");
    CloseHandle(pipe);
    return 0;
  }
  if (g_evBootstrapReady) SetEvent(g_evBootstrapReady);

  if (g_evEvalDone && WaitForSingleObject(g_evEvalDone, 60000) == WAIT_OBJECT_0) {
    pipeSendResult(pipe, g_rubyStatus == 0, "%s", g_rubyDetail);
  } else {
    pipeSendResult(pipe, false, "timeout-no-message-loop");
  }
  CloseHandle(pipe);
  return 0;
}

// WH_GETMESSAGE hook procedure — runs inside the target process on its main
// window thread.
extern "C" __declspec(dllexport) LRESULT CALLBACK RmchHookProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    if (InterlockedCompareExchange(&g_workerStarted, 1, 0) == 0) {
      g_evBootstrapReady = CreateEventW(NULL, TRUE, FALSE, NULL);
      g_evEvalDone = CreateEventW(NULL, TRUE, FALSE, NULL);
      HANDLE h = CreateThread(NULL, 0, workerThread, NULL, 0, NULL);
      if (h) CloseHandle(h);
    } else if (g_evBootstrapReady && WaitForSingleObject(g_evBootstrapReady, 0) == WAIT_OBJECT_0 &&
               InterlockedCompareExchange(&g_evaled, 1, 0) == 0) {
      doEval();
      if (g_evEvalDone) SetEvent(g_evEvalDone);
    }
  }
  return CallNextHookEx(NULL, code, wParam, lParam);
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
  (void)hinst;
  (void)reason;
  return TRUE; // deliberately inert — see file header
}
