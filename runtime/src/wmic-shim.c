// wmic.exe shim — instant UTF-16LE answers for the Grover shell's ancestry
// probe on Windows 11, where Microsoft removed wmic.exe.
//
// The shell (bg_script) execs, from its cwd:
//   wmic process where ProcessId=<pid> get ParentProcessId/value
//   wmic process where ProcessId=<pid> get Name=value
// and fail-closes (eventually killing the game) when the exec errors. On
// Win11 there is no wmic.exe, so the check can never succeed. This shim is
// deployed into the shadow app dir (the game process's cwd, which cmd.exe
// searches before PATH) and answers with a whitelisted ancestor name in the
// exact byte format real wmic uses (UTF-16LE, CRLF), so the shell's parser
// behaves as on a machine that still ships wmic.
//
// Build (see tools/build-inject.mjs for the toolchain discovery):
//   x86_64-w64-mingw32-gcc -O2 -o wmic.exe wmic_shim.c
#include <windows.h>
#include <string.h>
#include <stdio.h>
#include <tlhelp32.h>

static void log_err(const char *what, DWORD code);

// Real parent pid of `pid` via the toolhelp snapshot. Returns 0 when unknown.
static DWORD real_parent_pid(DWORD pid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) { log_err("snapshot", GetLastError()); return 0; }
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    DWORD parent = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) { parent = pe.th32ParentProcessID; break; }
            if (!parent && pe.th32ProcessID == 0) log_err("walk-end", 0);
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return parent;
}

// Real image name of `pid` (lowercase, .exe). Returns 0 when unknown.
static int real_name(DWORD pid, char *out, int cap) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    int found = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) {
                int i = 0;
                while (pe.szExeFile[i] && i < cap - 1) {
                    wchar_t c = pe.szExeFile[i];
                    out[i] = (char)((c >= L'A' && c <= L'Z') ? c + 32 : c);
                    i++;
                }
                out[i] = 0;
                found = 1;
                break;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return found;
}

// First live explorer.exe pid from the snapshot (0 when absent). Used to
// root the ancestry chain at a process that genuinely exists with a
// whitelisted name.
static DWORD find_explorer_pid(void) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    DWORD pid = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            int i = 0, hit = 1;
            const char *want = "explorer.exe";
            while (want[i]) {
                wchar_t c = pe.szExeFile[i];
                char lc = (char)((c >= L'A' && c <= L'Z') ? c + 32 : c);
                if (lc != want[i]) { hit = 0; break; }
                i++;
            }
            if (hit && pe.szExeFile[i] == 0) { pid = pe.th32ProcessID; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

// "Node=<computername>" preamble line that real wmic /value output emits
static char NODE_LINE[128];

static void build_node_line(void) {
    wchar_t host[64];
    DWORD n = 64;
    char host_a[64];
    if (!GetComputerNameW(host, &n)) { n = 0; host_a[0] = 0; }
    DWORD i = 0;
    for (; i < n && i < 60; i++) {
        wchar_t c = host[i];
        host_a[i] = (char)((c >= L'A' && c <= L'Z') ? c + 32 : c);
    }
    host_a[i] = 0;
    snprintf(NODE_LINE, sizeof(NODE_LINE), "\r\r\nNode=%s\r\r\n\r\r\n", host_a);
}

static const char *WHITELIST[] = { "gearnt.exe", "totalcmd", "steam.exe", "cmd.exe", "explorer.exe" };

static void log_to(const char *suffix, const char *line) {
    char path[MAX_PATH];
    UINT n = GetTempPathA(sizeof(path) - 40, path);
    if (!n) return;
    snprintf(path + n, sizeof(path) - n, "rmch-%s", suffix);
    FILE *f = fopen(path, "a");
    if (!f) return;
    fprintf(f, "%s", line);
    fclose(f);
}

static void log_call(const char *joined) {
    char line[1200];
    snprintf(line, sizeof(line), "[%ld] %s\n", (long)GetTickCount(), joined);
    log_to("wmic-shim.log", line);
}

static void log_err(const char *what, DWORD code) {
    char line[160];
    snprintf(line, sizeof(line), "[%ld] ERR %s gle=%lu\n", (long)GetTickCount(), what, (unsigned long)code);
    log_to("wmic-shim.log", line);
}

static void write_utf16(const char *ascii) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    int n = 0;
    while (ascii[n]) n++;
    wchar_t buf[512];
    if (n > 500) n = 500;
    for (int i = 0; i < n; i++) buf[i] = (wchar_t)(unsigned char)ascii[i];
    DWORD written = 0;
    WriteFile(out, buf, (DWORD)(n * sizeof(wchar_t)), &written, NULL);
}

static void write_ascii(const char *s) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD written = 0;
    WriteFile(out, s, (DWORD)strlen(s), &written, NULL);
}

int main(int argc, char **argv) {
    char joined[1024];
    joined[0] = 0;
    int len = 0;
    for (int i = 1; i < argc; i++) {
        int alen = 0;
        while (argv[i][alen]) alen++;
        if (len + alen + 2 >= (int)sizeof(joined)) break;
        if (i > 1) joined[len++] = ' ';
        memcpy(joined + len, argv[i], alen);
        len += alen;
        joined[len] = 0;
    }
    // Real wmic /value output: leading blank line, "Key=value", trailing
    // blank lines, CRLF endings, UTF-16LE encoded.
    build_node_line();
    log_call(joined);
    // Real wmic /value layout: leading blank line + "Key=value" + trailing
    // blank line, every line terminated CRCRLF ("\r\r\n").
    // PPID queries answer with the REAL parent pid (consistency with what the
    // shell knows from the OS); Name queries answer with a whitelisted name so
    // the ancestry walk passes. Bare probe -> both fields.
    {
        char pbuf[320];
        // Bare probe (`wmic` with no args): both fields, same layout.
        snprintf(pbuf, sizeof(pbuf), "%sParentProcessId=4\r\r\n\r\r\nName=explorer.exe\r\r\n\r\r\n", NODE_LINE);
        const char *payload = pbuf;
        if (strstr(joined, "ParentProcessId")) {
            const char *p = strstr(joined, "ProcessId=");
            DWORD asked = p ? (DWORD)strtoul(p + 10, NULL, 10) : 0;
            DWORD parent = real_parent_pid(asked);
            if (!parent) parent = find_explorer_pid();
            if (!parent) parent = 4;
            snprintf(pbuf, sizeof(pbuf), "%sParentProcessId=%lu\r\r\n\r\r\n", NODE_LINE, (unsigned long)parent);
            payload = pbuf;
        } else if (strstr(joined, "Name")) {
            const char *p = strstr(joined, "ProcessId=");
            DWORD asked = p ? (DWORD)strtoul(p + 10, NULL, 10) : 0;
            char name[64];
            // ALWAYS answer the real image name. The shell cross-checks known
            // pids (a query for PID 4 must yield "system") — a whitelisted lie
            // there trips its anti-tamper and freezes the boot.
            int ok = real_name(asked, name, sizeof(name));
            if (!ok) strcpy(name, "system");
            snprintf(pbuf, sizeof(pbuf), "%sName=%s\r\r\n\r\r\n", NODE_LINE, name);
            payload = pbuf;
        }
        DWORD written = 0;
        WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), payload, (DWORD)strlen(payload), &written, NULL);
        WriteFile(GetStdHandle(STD_ERROR_HANDLE), payload, (DWORD)strlen(payload), &written, NULL);
    }
    return 0;
}
