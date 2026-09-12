// test-target.exe — minimal Win32 app used by the injection self-test.
// Creates a visible window with a title, prints "pid <n>" + "ready" on stdout,
// then runs a message loop (with a timer so messages keep flowing even when
// idle, which WH_GETMESSAGE injection relies on).

#include <windows.h>
#include <stdio.h>
#include <string.h>

static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, w, l);
}

int main(int argc, char** argv) {
  // OEP self-test evidence: rmch-test-echo.dll creates this event in DllMain.
  // Seeing it here, as main() starts, proves the DLL ran before any game code.
  HANDLE preMain = OpenEventW(SYNCHRONIZE, FALSE, L"Local\\rmch-oep-echo-premain");
  printf("dll-premain %d\n", preMain ? 1 : 0);
  if (preMain) CloseHandle(preMain);
  // main-reached marker for diagnosing launch flows from the outside.
  {
    char marker[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, marker);
    if (n > 0) {
      _snprintf(marker + n, MAX_PATH - n, "rmch-target-main-%lu.ok",
                (unsigned long)GetCurrentProcessId());
      FILE* f = fopen(marker, "wb");
      if (f) fclose(f);
    }
  }

  bool hidden = argc > 1 && strcmp(argv[1], "--hidden") == 0;
  WNDCLASSW wc;
  ZeroMemory(&wc, sizeof(wc));
  wc.lpfnWndProc = wndProc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.lpszClassName = L"RmchInjectTestTarget";
  RegisterClassW(&wc);

  HWND hwnd = CreateWindowW(wc.lpszClassName, L"RMCH Inject Test Target",
                            WS_OVERLAPPEDWINDOW, 100, 100, 320, 200,
                            NULL, NULL, wc.hInstance, NULL);
  if (!hidden) ShowWindow(hwnd, SW_SHOWNORMAL);
  SetTimer(hwnd, 1, 100, NULL); // keep the queue busy

  printf("pid %lu\n", (unsigned long)GetCurrentProcessId());
  printf("ready\n");
  fflush(stdout);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
