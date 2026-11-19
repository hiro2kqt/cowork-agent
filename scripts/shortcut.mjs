#!/usr/bin/env node
// Create "Bridge Console" shortcuts on the Windows Desktop and Start Menu.
//
//   node scripts/shortcut.mjs            (both)
//   node scripts/shortcut.mjs --remove   (delete them)
//
// Each shortcut runs "Bridge Console.cmd" from this checkout in a minimized window.
// Close that window to stop the console.
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'Bridge Console.cmd');

if (process.platform !== 'win32') {
  console.error('Shortcuts are created on Windows only. Elsewhere run: node scripts/console.mjs');
  process.exit(1);
}
if (!fs.existsSync(launcher)) {
  console.error(`Missing ${launcher}`);
  process.exit(1);
}
const remove = process.argv.includes('--remove');

// Paths travel in environment variables, so no quoting of user paths inside the script is needed.
const script = `
$ErrorActionPreference = 'Stop'
$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($folder in $folders) {
  $link = Join-Path $folder 'Bridge Console.lnk'
  if ($env:BRIDGE_REMOVE -eq '1') {
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link; Write-Output "Removed $link" }
    continue
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = $env:BRIDGE_LAUNCHER
  $shortcut.WorkingDirectory = $env:BRIDGE_ROOT
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Coordinate Codex and Claude Code'
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) { $shortcut.IconLocation = "$node,0" }
  $shortcut.Save()
  Write-Output "Created $link"
}`;

const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, BRIDGE_LAUNCHER: launcher, BRIDGE_ROOT: root, BRIDGE_REMOVE: remove ? '1' : '0' },
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.error || result.status !== 0) {
  console.error((result.stderr || result.error?.message || 'PowerShell failed.').trim());
  process.exit(1);
}
if (!remove) console.log('Double-click "Bridge Console" to start it. Clicking it again while it runs reopens the page.');
