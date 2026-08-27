# Launch the RMCH GUI (NW.js window). Runs the Node setup (setup-gui.mjs)
# first if the runtime is missing — never setup-gui.ps1, whose Chinese-path
# handling breaks under PowerShell 5.1.
param(
  [switch]$Setup
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$GuiDir = Join-Path $ProjectRoot "app\gui"
# The donor runtime binary is renamed on link-in (core/setup-gui-runtime.mjs)
# so the GUI never shares the games' Game.exe process name.
$GuiExe = Join-Path $GuiDir "RMToolbox.exe"

if (-not (Test-Path -LiteralPath $GuiExe) -or $Setup) {
  & node (Join-Path $ProjectRoot "tools\setup-gui.mjs") $(if ($Setup) { "--force" })
  if ($LASTEXITCODE -ne 0) {
    throw "gui setup failed (exit $LASTEXITCODE)"
  }
}
if (-not (Test-Path -LiteralPath $GuiExe)) {
  throw "GUI runtime missing after setup: $GuiExe"
}

# Refresh the CJS copy of the ESM core modules (the NW.js window cannot
# dynamic-import .mjs itself). Cheap text transform; always rebuild.
& node (Join-Path $ProjectRoot "tools\gui-build.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "gui-build failed (exit $LASTEXITCODE)"
}

Start-Process -FilePath $GuiExe -WorkingDirectory $GuiDir
