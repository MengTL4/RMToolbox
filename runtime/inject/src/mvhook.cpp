// rmch-mvhook.dll — attaches to a running RPG Maker MV/MZ (NW.js) game.
//
// Injected into the game's renderer process (CreateRemoteThread + LoadLibraryW).
// Worker thread connects to the core's pipe, receives the bootstrap JS source,
// then arranges to compile+run it inside the page's V8 context:
//
//   1. Resolve V8 C++ API symbols exported by the game's nw.dll / node.dll
//      (component builds export them; verified on NW 0.29 / Chromium 65).
//   2. MinHook-hook v8::Function::Call (fires every frame via Blink) plus
//      v8::String::NewFromUtf8 as a fallback trigger.
//   3. The first hooked call that has a current context compiles+runs the
//      bootstrap right there, inside the detour: that is a natural V8 call
//      site (isolate entered, handle scope active, engine reentrancy-safe).
//      A RequestInterrupt callback is NOT — Script::Compile from inside one
//      reliably killed NW 0.29 x86. MTool's mzHook32.dll evals the same way.
//      Non-game contexts (extension background page etc.) make the bootstrap
//      throw, which reads as an empty Run: the detour then re-arms and lets
//      the next context retry.
//
// All V8 objects are passed around as opaque pointer-sized handles — Local<T>
// and MaybeLocal<T> are single-pointer wrappers. MSVC (BOTH arches) returns
// them through a hidden out pointer (user-provided default ctors make them
// ineligible for register return) while by-value args pass as raw handles;
// see the prototype section for the details and the disassembly evidence.
// Only the modern V8 ABI (NW.js >= 0.13, i.e. MV >= 1.3 and all MZ) is
// supported; on NW 0.12-era games we report a clean "unsupported" error.
//
// Pure C style, no libstdc++ (see common.h). Stage logging via dbgLog("mvhook").

#include <windows.h>
#include <stdio.h>
#include <string.h>

#include "common.h"
#include "MinHook.h"

#define DBG "mvhook"

#ifdef _WIN64
#define V8CC        // x64: single calling convention
#define V8THIS
#else
#define V8CC __cdecl  // x86: static members are cdecl...
#define V8THIS __thiscall // ...non-static members are thiscall
#endif

// --- V8 function prototypes (opaque handles) --------------------------------
// MSVC ABI, BOTH arches: Local<T>/MaybeLocal<T> have user-provided default
// constructors, so they are returned through a HIDDEN OUT POINTER — the first
// arg for statics, the first arg after `this` for members (the pointer is also
// echoed back in EAX/RAX). Never returned in a register directly — not even on
// x64: we initially assumed RAX there and the game's renderer died on the
// first hooked Function::Call until the x64 prototypes gained `out` too.
// By-value Local args pass as raw handle values in both arches. All of this is
// verified against nw.dll disassembly of NW 0.29 x86 (MV 1.6.1 x86) and x64
// (刷啊刷). The only per-arch difference left is the convention keyword:
// x86 statics are cdecl, members thiscall; x64 has a single convention.
typedef void*(V8CC* GetCurrent_t)();
typedef void*(V8THIS* GetCurrentContext_t)(void* self, void* out);
typedef void*(V8CC* NewFromUtf8_t)(void* out, void* isolate, const char* data, int type, int length);
typedef void*(V8CC* Compile_t)(void* out, void* ctxLocal, void* srcLocal, void* origin);
typedef void*(V8THIS* Run_t)(void* self, void* out, void* ctxLocal);
typedef void*(V8THIS* FunctionCall_t)(void* self, void* out, void* ctxLocal, void* recv, int argc, void* argv);

// --- Mangled export names ----------------------------------------------------
#ifdef _WIN64
static const char* NAME_GET_CURRENT = "?GetCurrent@Isolate@v8@@SAPEAV12@XZ";
static const char* NAME_GET_CURRENT_CTX = "?GetCurrentContext@Isolate@v8@@QEAA?AV?$Local@VContext@v8@@@2@XZ";
static const char* NAME_NEW_FROM_UTF8_MAYBE = "?NewFromUtf8@String@v8@@SA?AV?$MaybeLocal@VString@v8@@@2@PEAVIsolate@2@PEBDW4NewStringType@2@H@Z";
static const char* NAME_NEW_FROM_UTF8_LOCAL = "?NewFromUtf8@String@v8@@SA?AV?$Local@VString@v8@@@2@PEAVIsolate@2@PEBDW4NewStringType@12@H@Z";
static const char* NAME_COMPILE = "?Compile@Script@v8@@SA?AV?$MaybeLocal@VScript@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VString@v8@@@2@PEAVScriptOrigin@2@@Z";
static const char* NAME_RUN = "?Run@Script@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@@Z";
static const char* NAME_FUNCTION_CALL = "?Call@Function@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VValue@v8@@@2@HQEAV52@@Z";
// NW 0.12-era (MV <= 1.2): NewFromUtf8 without an Isolate parameter.
static const char* NAME_NEW_FROM_UTF8_OLD = "?NewFromUtf8@String@v8@@SA?AV?$Local@VString@v8@@@2@PEBDW4NewStringType@2@H@Z";
#else
static const char* NAME_GET_CURRENT = "?GetCurrent@Isolate@v8@@SAPAV12@XZ";
static const char* NAME_GET_CURRENT_CTX = "?GetCurrentContext@Isolate@v8@@QAE?AV?$Local@VContext@v8@@@2@XZ";
static const char* NAME_NEW_FROM_UTF8_MAYBE = "?NewFromUtf8@String@v8@@SA?AV?$MaybeLocal@VString@v8@@@2@PAVIsolate@2@PBDW4NewStringType@2@H@Z";
static const char* NAME_NEW_FROM_UTF8_LOCAL = "?NewFromUtf8@String@v8@@SA?AV?$Local@VString@v8@@@2@PAVIsolate@2@PBDW4NewStringType@12@H@Z";
static const char* NAME_COMPILE = "?Compile@Script@v8@@SA?AV?$MaybeLocal@VScript@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VString@v8@@@2@PAVScriptOrigin@2@@Z";
static const char* NAME_RUN = "?Run@Script@v8@@QAE?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@@Z";
static const char* NAME_FUNCTION_CALL = "?Call@Function@v8@@QAE?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VValue@v8@@@2@HQAV52@@Z";
static const char* NAME_NEW_FROM_UTF8_OLD = "?NewFromUtf8@String@v8@@SA?AV?$Local@VString@v8@@@2@PBDW4NewStringType@2@H@Z";
#endif

// --- Resolved function pointers ----------------------------------------------
static GetCurrent_t fpGetCurrent = NULL;
static GetCurrentContext_t fpGetCurrentContext = NULL;
static NewFromUtf8_t fpNewFromUtf8Maybe = NULL;
static NewFromUtf8_t fpNewFromUtf8Local = NULL;
static Compile_t fpCompile = NULL;
static Run_t fpRun = NULL;
static FunctionCall_t fpFunctionCall = NULL;

// --- Shared state --------------------------------------------------------------
static Buf g_bootstrap;
static volatile LONG g_claimed = 0; // 0 idle, 1 a detour claimed the one-shot eval
static volatile DWORD g_lastRetry = 0; // GetTickCount of the last context miss
static HANDLE g_evEvalDone = NULL;
static volatile LONG g_evalState = 0; // 0 pending, 1 ok, 2 fail
static char g_evalDetail[512];

// Resolve one symbol from nw.dll, falling back to node.dll.
static FARPROC resolveV8(const char* mangled) {
  HMODULE mods[2];
  mods[0] = GetModuleHandleW(L"nw.dll");
  mods[1] = GetModuleHandleW(L"node.dll");
  for (int i = 0; i < 2; i++) {
    if (!mods[i]) continue;
    FARPROC p = GetProcAddress(mods[i], mangled);
    if (p) return p;
  }
  return NULL;
}

static bool resolveAll() {
  fpGetCurrent = (GetCurrent_t)(void*)resolveV8(NAME_GET_CURRENT);
  fpGetCurrentContext = (GetCurrentContext_t)(void*)resolveV8(NAME_GET_CURRENT_CTX);
  fpNewFromUtf8Maybe = (NewFromUtf8_t)(void*)resolveV8(NAME_NEW_FROM_UTF8_MAYBE);
  fpNewFromUtf8Local = (NewFromUtf8_t)(void*)resolveV8(NAME_NEW_FROM_UTF8_LOCAL);
  fpCompile = (Compile_t)(void*)resolveV8(NAME_COMPILE);
  fpRun = (Run_t)(void*)resolveV8(NAME_RUN);
  fpFunctionCall = (FunctionCall_t)(void*)resolveV8(NAME_FUNCTION_CALL);
  dbgLog(DBG, "resolve: getcur=%p ctx=%p nfuM=%p nfuL=%p comp=%p run=%p fcall=%p",
         fpGetCurrent, fpGetCurrentContext, fpNewFromUtf8Maybe, fpNewFromUtf8Local,
         fpCompile, fpRun, fpFunctionCall);
  // Function::Call is the primary trigger (Blink calls it every frame for rAF
  // and events — NewFromUtf8 alone can go quiet for tens of seconds on idle
  // MV title screens, which starved the first hook-only builds).
  if (!fpFunctionCall && !fpNewFromUtf8Maybe && !fpNewFromUtf8Local) {
    strcpy(g_evalDetail,
           resolveV8(NAME_NEW_FROM_UTF8_OLD) ? "unsupported-nw-0.12" : "v8-symbols-missing");
    return false;
  }
  if (!(fpGetCurrent && fpGetCurrentContext && fpCompile && fpRun)) {
    strcpy(g_evalDetail, "v8-symbols-missing");
    return false;
  }
  return true;
}

static NewFromUtf8_t g_origMaybe = NULL;
static NewFromUtf8_t g_origLocal = NULL;

// --- ABI wrappers: uniform "handle or NULL" calls ----------------------------
static void* callGetCurrentContext(void* isolate) {
  void* h = NULL;
  fpGetCurrentContext(isolate, &h);
  return h;
}

static void* callNewFromUtf8(NewFromUtf8_t fn, void* isolate, const char* data, int length) {
  void* h = NULL;
  fn(&h, isolate, data, 0, length);
  return h;
}

static void* callCompile(void* ctx, void* src) {
  void* h = NULL;
  fpCompile(&h, ctx, src, NULL);
  return h;
}

static void* callRun(void* script, void* ctx) {
  void* h = NULL;
  fpRun(script, &h, ctx);
  return h;
}

// Compiles and runs the bootstrap inside the CURRENT V8 call. Runs on a V8
// thread from inside a detour — a natural V8 call site, so the isolate is
// entered, a handle scope is active, and the engine is reentrancy-safe here
// (a RequestInterrupt callback is not: Script::Compile from inside one
// reliably killed NW 0.29 x86; MTool's mzHook32.dll evals the same way).
// No C++-side DOM sniffing either (Object::Get can run Blink getters — also
// not safe here): the bootstrap self-guards and THROWS on non-game contexts,
// which reads here as an empty Run result.
static void evalBootstrapIn(void* isolate, void* ctx) {
  dbgLog(DBG, "evalBootstrap isolate=%p ctx=%p", isolate, ctx);
  NewFromUtf8_t newStr = fpNewFromUtf8Maybe ? fpNewFromUtf8Maybe : fpNewFromUtf8Local;
  void* src = callNewFromUtf8(newStr, isolate, g_bootstrap.data, (int)g_bootstrap.len);
  dbgLog(DBG, "src=%p", src);
  if (src) {
    void* script = callCompile(ctx, src);
    dbgLog(DBG, "script=%p", script);
    if (script) {
      void* val = callRun(script, ctx);
      dbgLog(DBG, "run -> %p", val);
      if (val) {
        InterlockedExchange(&g_evalState, 1);
        SetEvent(g_evEvalDone);
        return;
      }
      // Empty result == the bootstrap guard threw "rmch-not-game-page": this
      // was a spare/background context. Release the claim (rate-limited) so
      // the next context's call retries. Genuine bootstrap errors are caught
      // inside the bootstrap itself and logged to attach-error.log.
      dbgLog(DBG, "not a game page context; re-arming");
      g_lastRetry = GetTickCount();
      InterlockedExchange(&g_claimed, 0);
      return;
    } else {
      strcpy(g_evalDetail, "compile-failed");
    }
  } else {
    strcpy(g_evalDetail, "bootstrap-string-alloc-failed");
  }
  InterlockedExchange(&g_evalState, 2);
  SetEvent(g_evEvalDone);
}

// NewFromUtf8-path entry: context comes from the isolate's current context.
static void evalBootstrap(void* isolate) {
  void* ctx = callGetCurrentContext(isolate);
  if (!ctx) {
    // Background thread / between contexts — release and retry on the next call.
    InterlockedExchange(&g_claimed, 0);
    return;
  }
  evalBootstrapIn(isolate, ctx);
}

// Rate limit: after a wrong-context miss, wait a bit before burning another
// compile+run on what is likely the same busy background context.
static bool retryThrottled() {
  DWORD last = g_lastRetry;
  return last != 0 && (long)(GetTickCount() - last) < 400;
}

// Runs on a V8 thread inside the hooked NewFromUtf8. The first call that has
// a current context gets to run the bootstrap (claimed via CAS); if the
// bootstrap reports a non-game context by throwing, the claim is released and
// a later call — usually a different context of the same isolate — retries.
// Every other call, including the nested ones our own eval triggers, passes
// straight through. Two instances, one per overload; the orig pointer is
// selected via the template parameter. The signature must mirror the hooked
// function's hidden-out-param layout exactly, since MinHook detours at the
// machine-code level.
template <int which>
static void* V8CC detourNewFromUtf8(void* out, void* isolate, const char* data, int type, int length) {
  NewFromUtf8_t orig = which == 0 ? g_origMaybe : g_origLocal;
  if (!g_claimed && isolate && !retryThrottled() &&
      InterlockedCompareExchange(&g_claimed, 1, 0) == 0) {
    evalBootstrap(isolate);
  }
  return orig(out, isolate, data, type, length);
}

// The primary trigger: Blink goes through v8::Function::Call for every rAF
// tick, event and timer, so this fires immediately and constantly — unlike
// NewFromUtf8, which can go quiet for tens of seconds on an idle title
// screen. The context being called in is the ctx argument itself; the
// isolate comes from GetCurrent(). One instance (not an overload set).
static FunctionCall_t g_origCall = NULL;

static void* V8THIS detourFunctionCall(void* self, void* out, void* ctx, void* recv, int argc, void* argv) {
  if (!g_claimed && ctx && !retryThrottled() &&
      InterlockedCompareExchange(&g_claimed, 1, 0) == 0) {
    void* isolate = fpGetCurrent();
    if (isolate) evalBootstrapIn(isolate, ctx);
    else InterlockedExchange(&g_claimed, 0);
  }
  return g_origCall(self, out, ctx, recv, argc, argv);
}

static void disableHooks() {
  if (fpFunctionCall) MH_DisableHook((LPVOID)fpFunctionCall);
  if (fpNewFromUtf8Maybe) MH_DisableHook((LPVOID)fpNewFromUtf8Maybe);
  if (fpNewFromUtf8Local) MH_DisableHook((LPVOID)fpNewFromUtf8Local);
}

static DWORD WINAPI workerThreadBody(LPVOID) {
  HANDLE pipe = pipeConnect(15000);
  if (pipe == INVALID_HANDLE_VALUE) {
    dbgLog(DBG, "pipe connect failed, gle=%lu", GetLastError());
    return 0;
  }
  dbgLog(DBG, "pipe connected");

  pipeSendReady(pipe, "mvhook");

  bufInit(&g_bootstrap);
  if (!pipeReadFrame(pipe, &g_bootstrap, 4 * 1024 * 1024)) {
    dbgLog(DBG, "bootstrap read failed");
    pipeSendResult(pipe, false, "bootstrap-read-failed");
    CloseHandle(pipe);
    return 0;
  }
  dbgLog(DBG, "bootstrap %lu bytes", (unsigned long)g_bootstrap.len);

  if (!resolveAll()) {
    dbgLog(DBG, "resolveAll failed: %s", g_evalDetail);
    pipeSendResult(pipe, false, "%s", g_evalDetail);
    CloseHandle(pipe);
    return 0;
  }

  g_evEvalDone = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!g_evEvalDone) {
    pipeSendResult(pipe, false, "event-alloc-failed");
    CloseHandle(pipe);
    return 0;
  }

  if (MH_Initialize() != MH_OK) {
    pipeSendResult(pipe, false, "minhook-init-failed");
    CloseHandle(pipe);
    return 0;
  }

  // Hook Function::Call (primary, fires every frame) plus whichever
  // NewFromUtf8 overloads exist as a fallback trigger.
  int hooks = 0;
  if (fpFunctionCall &&
      MH_CreateHook((LPVOID)fpFunctionCall, (LPVOID)&detourFunctionCall,
                    (LPVOID*)&g_origCall) == MH_OK &&
      MH_EnableHook((LPVOID)fpFunctionCall) == MH_OK) {
    hooks++;
  }
  if (fpNewFromUtf8Maybe &&
      MH_CreateHook((LPVOID)fpNewFromUtf8Maybe, (LPVOID)&detourNewFromUtf8<0>,
                    (LPVOID*)&g_origMaybe) == MH_OK &&
      MH_EnableHook((LPVOID)fpNewFromUtf8Maybe) == MH_OK) {
    hooks++;
  }
  if (fpNewFromUtf8Local &&
      MH_CreateHook((LPVOID)fpNewFromUtf8Local, (LPVOID)&detourNewFromUtf8<1>,
                    (LPVOID*)&g_origLocal) == MH_OK &&
      MH_EnableHook((LPVOID)fpNewFromUtf8Local) == MH_OK) {
    hooks++;
  }
  dbgLog(DBG, "hooks installed: %d", hooks);
  if (hooks == 0) {
    pipeSendResult(pipe, false, "hook-install-failed");
    CloseHandle(pipe);
    return 0;
  }

  // The detour evaluates the bootstrap on the first suitable V8 call and then
  // signals g_evEvalDone; the worker just waits here. The hooks stay armed
  // during the eval (nested NewFromUtf8 calls pass straight through) and are
  // disabled after we have a result.
  DWORD w = WaitForSingleObject(g_evEvalDone, 20000);
  if (w == WAIT_OBJECT_0) {
    LONG st = g_evalState;
    dbgLog(DBG, "eval state=%ld detail=%s", st, g_evalDetail);
    pipeSendResult(pipe, st == 1, "%s", st == 1 ? "evaled" : g_evalDetail);
  } else {
    dbgLog(DBG, "deadline hit, no v8 call captured");
    pipeSendResult(pipe, false, "timeout-no-v8-call");
  }

  disableHooks();
  MH_Uninitialize();
  CloseHandle(pipe);
  if (g_evEvalDone) CloseHandle(g_evEvalDone);
  return 0;
}

static DWORD WINAPI workerThread(LPVOID arg) {
  return workerThreadBody(arg);
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(hinst);
    char exe[MAX_PATH];
    DWORD n = GetModuleFileNameA(NULL, exe, sizeof(exe));
    (void)n;
    dbgLog(DBG, "DllMain attach in %s", exe);
    HANDLE h = CreateThread(NULL, 0, workerThread, NULL, 0, NULL);
    if (h) CloseHandle(h);
  }
  return TRUE;
}
