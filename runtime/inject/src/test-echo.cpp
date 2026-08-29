// rmch-test-echo.dll — self-test DLL implementing the same activation contract
// as the real hook DLLs:
//   * DllMain spawns a worker thread (CRT injection path)
//   * exports RmchHookProc which also spawns the worker (WH injection path) and
//     records that the hook actually fired in the target
// The worker connects to \\.\pipe\rmch-attach-<pid>, sends "ready", reads one
// frame, and replies {"t":"result","ok":true,"detail":"echo:<payload UPPERCASED>",
// "hook":<0|1>} so the test can verify both delivery and hook activation.
//
// Pure C style, no libstdc++ (see common.h).

#include <windows.h>
#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "common.h"

static volatile LONG g_workerStarted = 0;
static volatile LONG g_hookCalled = 0;

static DWORD WINAPI workerThread(LPVOID) {
  HANDLE pipe = pipeConnect(10000);
  if (pipe == INVALID_HANDLE_VALUE) return 0;

  pipeSendReady(pipe, "test-echo");

  Buf payload;
  bufInit(&payload);
  if (!pipeReadFrame(pipe, &payload, 1024 * 1024)) {
    CloseHandle(pipe);
    return 0;
  }
  for (DWORD i = 0; i < payload.len; i++) {
    unsigned char c = (unsigned char)payload.data[i];
    if (c < 0x80) payload.data[i] = (char)toupper(c); // keep UTF-8 bytes untouched
  }

  // In WH mode the hook proc may not have run yet when the worker starts;
  // give it a brief moment so the flag reflects reality.
  for (int i = 0; i < 25 && !g_hookCalled; i++) Sleep(20);

  Buf content;
  bufInit(&content);
  bufAppendStr(&content, "echo:");
  bufAppendStr(&content, payload.data ? payload.data : "");

  Buf res;
  bufInit(&res);
  bufAppendStr(&res, "{\"t\":\"result\",\"ok\":true,\"detail\":");
  jsonAppendEscaped(&res, content.data ? content.data : "");
  bufAppendStr(&res, ",\"hook\":");
  bufAppendStr(&res, g_hookCalled ? "1" : "0");
  bufAppendStr(&res, "}");
  if (res.data) pipeSendJson(pipe, res.data, res.len);
  bufFree(&res);
  bufFree(&content);
  bufFree(&payload);
  CloseHandle(pipe);
  return 0;
}

static void ensureWorker() {
  if (InterlockedCompareExchange(&g_workerStarted, 1, 0) == 0) {
    HANDLE h = CreateThread(NULL, 0, workerThread, NULL, 0, NULL);
    if (h) CloseHandle(h);
  }
}

extern "C" __declspec(dllexport) LRESULT CALLBACK RmchHookProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    g_hookCalled = 1;
    ensureWorker();
  }
  return CallNextHookEx(NULL, code, wParam, lParam);
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(hinst);
    ensureWorker();
  }
  return TRUE;
}
