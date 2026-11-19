#!/usr/bin/env node
// agent-bridge: one terminal command for the Bridge Console and its tools.
// Install it once from this checkout with `npm link` (Windows, Linux, macOS).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const script = name => path.join(root, 'scripts', name);

const HELP = `agent-bridge ${version} — coordinate Codex and Claude Code

Usage:
  agent-bridge                     start the console and open it in the browser
  agent-bridge console [options]   same, with options: --port <n> --no-open --state-dir <dir>
  agent-bridge demo                try the console with simulated sessions
  agent-bridge connect <address>   remember a Bridge Relay (e.g. https://agents.example.com), then start
  agent-bridge disconnect          forget the relay
  agent-bridge status              Claude sessions, Codex chats, relay, and what is missing
  agent-bridge install [--claude | --codex]
                                   install or update the plugin in Claude Code and Codex
  agent-bridge relay [options]     run the relay on a server (see docs/RELAY.md)
  agent-bridge shortcut [--remove] Windows: Desktop and Start Menu shortcuts
  agent-bridge help | --version`;

function run(file, args) {
  const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit', windowsHide: false });
  const forward = signal => () => { try { child.kill(signal); } catch {} };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
  child.on('error', error => { console.error(error.message); process.exit(1); });
}

async function status() {
  const os = await import('node:os');
  const { defaultStateDir } = await import('../lib/state-directory.mjs');
  const { readCloud } = await import('../lib/console-cloud.mjs');
  const { consoleTransport } = await import('../lib/bridge-service.mjs');
  const { runningConsole } = await import('./console.mjs');
  const stateDir = defaultStateDir({ env: process.env });
  const line = (ok, label, detail) => console.log(`${ok === true ? '✓' : ok === false ? '✕' : '•'} ${label}${detail ? `: ${detail}` : ''}`);
  console.log(`agent-bridge ${version} on ${os.hostname()} (${process.platform})\n`);
  const transport = consoleTransport({});
  try {
    const { sessions, warnings } = await transport.listClaude();
    line(sessions.length > 0, 'Claude Code sessions', sessions.length ? `${sessions.length} open` : 'none open with a live inbox');
    for (const s of sessions.slice(0, 8)) console.log(`    ${s.title || s.id}  [${s.status}]  ${s.cwd}`);
    for (const w of warnings) console.log(`    ! ${w}`);
  } catch (error) { line(false, 'Claude Code sessions', error.message); }
  try {
    const { threads, warnings } = await transport.listCodex({ limit: 20 });
    line(threads.length > 0, 'Codex chats', threads.length ? `${threads.length} found` : 'none');
    for (const t of threads.slice(0, 8)) console.log(`    ${(t.title || t.id).slice(0, 60)}  [${t.status} · ${t.source}]`);
    for (const w of warnings) console.log(`    ! ${w}`);
  } catch (error) {
    line(false, 'Codex chats', error.message);
    if (process.platform !== 'win32' && /daemon/i.test(error.message)) console.log('    → start it with: codex app-server daemon start');
  }
  const cloud = readCloud(stateDir);
  line(cloud ? true : null, 'Cloud relay', cloud ? cloud.url : 'not connected (agent-bridge connect <address>)');
  const running = await runningConsole({ stateDir });
  line(running ? true : null, 'Console', running ? `running — ${running}` : 'not running (agent-bridge)');
  console.log(`\nState folder: ${stateDir}`);
}

const [command = 'console', ...rest] = process.argv.slice(2);
switch (command) {
  case 'console': run(script('console.mjs'), rest); break;
  case 'demo': run(script('console.mjs'), ['--demo', ...rest]); break;
  case 'connect':
    if (!rest[0] || rest[0].startsWith('-')) { console.error('Usage: agent-bridge connect <relay address>'); process.exit(2); }
    run(script('console.mjs'), ['--connect', /^https?:\/\//i.test(rest[0]) ? rest[0] : `https://${rest[0]}`, ...rest.slice(1)]);
    break;
  case 'disconnect': run(script('console.mjs'), ['--disconnect', '--no-open', ...rest]); break;
  case 'install': run(script('install.mjs'), rest); break;
  case 'relay': run(script('relay.mjs'), rest); break;
  case 'shortcut': run(script('shortcut.mjs'), rest); break;
  case 'status': status().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); break;
  case 'help': case '--help': case '-h': console.log(HELP); break;
  case '--version': case '-v': console.log(version); break;
  default:
    if (command.startsWith('-')) run(script('console.mjs'), [command, ...rest]);
    else { console.error(`Unknown command: ${command}\n\n${HELP}`); process.exit(2); }
}
