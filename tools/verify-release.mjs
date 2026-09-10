import {execFileSync} from 'node:child_process';

const psString = value => "'" + value.replaceAll("'", "''") + "'";

// Verify the compressed artifact, not just the directory it was built from.
// Stream hashes so the large NW DLL need not be read wholly into memory.
export function verifyReleaseArchive(zip, staging) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[System.IO.Compression.ZipFile]::OpenRead(${psString(zip)})
$stage=${psString(staging)}
$names=@{}
$count=0
try {
 foreach($entry in $archive.Entries) {
  $name=$entry.FullName.Replace([char]92,[char]47)
  if($name.EndsWith('/')) { continue }
  if(-not $name.StartsWith('RMToolbox/') -or $name.Contains('../')) { throw "Bad archive path: $name" }
  $rel=$name.Substring(10)
  if($names.ContainsKey($rel)) { throw "Duplicate ZIP entry: $name" }
  $names[$rel]=$true
  $file=Join-Path $stage $rel
  if(-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Unexpected ZIP entry: $name" }
  $stream=$entry.Open()
  $sha=[System.Security.Cryptography.SHA256]::Create()
  try { $actual=([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLower() }
  finally { $stream.Dispose(); $sha.Dispose() }
  # Get-FileHash is a module cmdlet and is missing on some Windows PowerShell
  # builds (e.g. 5.1.26100); hash the staged file with plain .NET instead.
  $fileStream=[System.IO.File]::OpenRead($file)
  $fileSha=[System.Security.Cryptography.SHA256]::Create()
  try { $expected=([System.BitConverter]::ToString($fileSha.ComputeHash($fileStream))).Replace('-','').ToLower() }
  finally { $fileStream.Dispose(); $fileSha.Dispose() }
  if($actual -ne $expected) { throw "ZIP content mismatch: $name" }
  $count++
 }
 foreach($required in @('RMToolbox.cmd','app/gui/RMToolbox.exe','app/gui/nw.dll','app/gui/.nw-runtime.json','app/gui/ui/modern.js','build-info.json','runtime/inject/bin/win32/rmch-inject.exe','runtime/inject/bin/x64/rmch-inject.exe')) {
  if(-not $names.ContainsKey($required)) { throw "Missing required entry: $required" }
 }
 $stagedCount=(Get-ChildItem -LiteralPath $stage -File -Recurse -Force | Measure-Object).Count
 if($stagedCount -ne $count) { throw "ZIP omitted staged files: $stagedCount vs $count" }
 Write-Output "ZIP integrity PASS: $count files match staging"
} finally { $archive.Dispose() }
`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {stdio: 'inherit', windowsHide: true});
}
