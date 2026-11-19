// Locate the native Codex executable without a shell. `codex.cmd` shims cannot be spawned safely
// without shell:true, so resolve the vendored codex.exe from the @openai/codex package the shim runs.
// That package ships only bin/codex.js; the binary lives in an optional platform package installed under
// the alias names below (its optionalDependencies), which codex.js finds with Node's node_modules walk.
import fs from 'node:fs';
import path from 'node:path';

const PLATFORMS = {
  x64: ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
  arm64: ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};
const LAUNCHER = /"((?:%~?dp0%?|[A-Za-z]:)[^"\r\n]*[\\/]codex\.js)"/i;
// Volta's shim carries no path; its package image is <VOLTA_HOME>\tools\image\packages\<name>, and the source
// directory inside it depends on the package manager (npm: the root, pnpm: 5, yarn: lib).
const VOLTA_SOURCE_DIRS = ['', '5', 'lib'];

function readShim(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    return buffer.toString('utf8', 0, fs.readSync(descriptor, buffer, 0, buffer.length, 0));
  } finally { fs.closeSync(descriptor); }
}

// Package roots (the directories holding bin/codex.js) that the shim at `directory\codex.cmd` can belong to.
function packageRoots(directory, read) {
  const roots = [];
  let shim = '';
  try { shim = read(path.join(directory, 'codex.cmd')); } catch { /* unreadable: fall back to the npm layout */ }
  // npm (cmd-shim) writes %dp0%\node_modules\..., pnpm (@zkochan/cmd-shim) %~dp0\... or an absolute path.
  const launcher = LAUNCHER.exec(shim)?.[1];
  if (launcher) roots.push(path.dirname(path.dirname(path.normalize(launcher.replace(/^%~?dp0%?/i, directory)))));
  if (/\bvolta run\b/i.test(shim) && path.basename(directory).toLowerCase() === 'bin') {
    const image = path.join(path.dirname(directory), 'tools', 'image', 'packages', '@openai', 'codex');
    for (const source of VOLTA_SOURCE_DIRS) roots.push(path.join(image, source, 'node_modules', '@openai', 'codex'));
  }
  roots.push(path.join(directory, 'node_modules', '@openai', 'codex'));
  return roots;
}

// Walk up from the package like Node's resolver. Both targets are tried, the running architecture first: only the
// platform package matching the installing npm's CPU is present, and that can differ from this process's.
function vendored(root, arch, { exists, realpath }) {
  let directory;
  try { directory = realpath(root); } catch { directory = root; }
  const targets = [arch, ...Object.keys(PLATFORMS).filter(key => key !== arch)].filter(key => PLATFORMS[key]).map(key => PLATFORMS[key]);
  for (;;) {
    if (path.basename(directory) !== 'node_modules') {
      for (const [name, triple] of targets) {
        const candidate = path.join(directory, 'node_modules', '@openai', name, 'vendor', triple, 'bin', 'codex.exe');
        if (exists(candidate)) return candidate;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// Codex Desktop (the ChatGPT app) ships its own CLI at %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe and does
// not put it on PATH. With several builds present, the most recently written one is the current app's.
function desktopBundled(env, exists, listDir, mtime) {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
  let builds;
  try { builds = listDir(bin); } catch { return null; }
  return builds.map(name => path.join(bin, name, 'codex.exe')).filter(file => exists(file))
    .map(file => ({ file, at: (() => { try { return mtime(file); } catch { return 0; } })() }))
    .sort((a, b) => b.at - a.at)[0]?.file ?? null;
}

export function resolveCodexExecutable({ env = process.env, exists = fs.existsSync, read = readShim, realpath = fs.realpathSync,
  arch = process.arch, listDir = directory => fs.readdirSync(directory), mtime = file => fs.statSync(file).mtimeMs,
  platform = process.platform, executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } } } = {}) {
  const override = env.CLAUDE_CODEX_BRIDGE_CODEX_BIN;
  if (override) return exists(override) ? override : null;
  // Linux and macOS: the `codex` on PATH is the real program (or a symlink to it), spawned without a shell.
  if (platform !== 'win32') {
    for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, 'codex');
      if (executable(candidate)) return candidate;
    }
    return null;
  }
  const directories = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const direct = path.join(directory, 'codex.exe');
    if (exists(direct)) return direct;
    if (!exists(path.join(directory, 'codex.cmd'))) continue;
    for (const root of packageRoots(directory, read)) {
      const found = vendored(root, arch, { exists, realpath });
      if (found) return found;
    }
  }
  return desktopBundled(env, exists, listDir, mtime);
}
