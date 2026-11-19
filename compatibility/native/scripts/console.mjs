#!/usr/bin/env node
// Bridge Console: a local web page to pick one Codex chat and one Claude Code session, choose a
// router, send requests, and follow both agents. Node standard library only.
//
//   node scripts/console.mjs [--port 4317] [--no-open] [--demo] [--state-dir <dir>]
//
// The server listens on 127.0.0.1 only. Every API call needs the per-launch token from the URL
// it prints, and the Host header must be the loopback address, so other web pages cannot drive it.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from '../lib/state-directory.mjs';
import { createEngine } from '../lib/console-engine.mjs';
import { readState } from '../lib/console-state.mjs';
import { MAX_FILE_BYTES, storeBuffer, fileMeta, publicMeta } from '../lib/console-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

export function parseArgs(argv) {
  const options = { port: 4317, open: true, demo: false, stateDir: null, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-open') options.open = false;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg === '--state-dir') options.stateDir = argv[++i];
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice(12);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port must be 0–65535.');
  return options;
}

export async function startConsole({ port = 4317, demo = false, stateDir, token = crypto.randomBytes(24).toString('hex'),
  transport, env = process.env, log = message => console.error(message), tickMs = 1200, availabilityMs = 15000 } = {}) {
  stateDir = path.resolve(stateDir || (demo ? path.join(os.tmpdir(), 'claude-codex-bridge-console-demo') : defaultStateDir({ env })));
  fs.mkdirSync(stateDir, { recursive: true });
  if (!transport) {
    if (demo) transport = (await import('../lib/console-demo.mjs')).demoTransport({ stateDir, log });
    else transport = (await import('../lib/bridge-service.mjs')).consoleTransport({ env, stateDir });
  }
  const engine = createEngine({ stateDir, transport, log });
  const html = () => fs.readFileSync(path.join(root, 'ui', 'console.html'), 'utf8');
  const viewer = () => fs.readFileSync(path.join(root, 'ui', 'console-viewer.js'), 'utf8');
  const availability = { codex: null, claude: null };
  let catalog = { claude: [], codex: [], warnings: [], at: 0 };

  async function refreshCatalog() {
    const [claude, codex] = await Promise.allSettled([transport.listClaude(), transport.listCodex()]);
    const warnings = [];
    if (claude.status === 'fulfilled') warnings.push(...claude.value.warnings); else warnings.push(`Claude sessions: ${claude.reason.message}`);
    if (codex.status === 'fulfilled') warnings.push(...codex.value.warnings); else warnings.push(`Codex chats: ${codex.reason.message}`);
    catalog = { claude: claude.status === 'fulfilled' ? claude.value.sessions : null,
      codex: codex.status === 'fulfilled' ? codex.value.threads : null, warnings: [...new Set(warnings)], at: Date.now() };
    // Availability of the *selected* sessions only. A missing session is reported, never replaced.
    const { selection } = readState(stateDir);
    for (const agent of ['codex', 'claude']) {
      const chosen = selection[agent];
      const list = catalog[agent];
      if (!chosen) availability[agent] = null;
      else if (!list) availability[agent] = { state: 'unknown', checkedAt: Date.now(), detail: `${agent === 'codex' ? 'Codex' : 'Claude'} discovery failed; availability is unknown.` };
      else {
        const found = list.find(item => item.id === chosen.id);
        availability[agent] = found
          ? { state: agent === 'codex' && found.status === 'notLoaded' ? 'stored' : 'available', checkedAt: Date.now(), status: found.status, title: found.title }
          : { state: 'missing', checkedAt: Date.now(), detail: agent === 'claude'
            ? 'This Claude Code session is not running or has no live inbox. Reopen it, or choose another session.'
            : 'This Codex chat was not found. Open it in Codex, or choose another chat.' };
      }
    }
    return catalog;
  }

  const routes = {
    'GET /api/state': () => ({ ...engine.snapshot(), availability, demo, version, platform: transport.platform ?? process.platform,
      stateDir: demo ? stateDir : undefined, now: Date.now() }),
    'GET /api/sessions': async () => refreshCatalog(),
    'POST /api/select': async body => { const r = engine.select(body.agent, body.participant ?? null); await refreshCatalog().catch(() => {}); return r; },
    'POST /api/config': body => engine.configure(body),
    'POST /api/submit': body => engine.submit(body),
    'POST /api/choose': body => engine.choose(body),
    'POST /api/cancel': body => engine.cancel(body),
    'POST /api/retry': body => engine.retry(body),
    'POST /api/peer-grant': () => engine.grantPeerTurns(),
    'POST /api/clear': () => engine.clearHistory(),
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
        ...(type.startsWith('text/html') ? { 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:; base-uri 'none'; form-action 'none'" } : {}) });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const address = server.address();
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(req.headers.host)) return send(421, { error: 'Unexpected Host header.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(200, html(), 'text/html; charset=utf-8');
      // The viewer is static code with no data in it, so it is served without the token.
      if (req.method === 'GET' && url.pathname === '/console-viewer.js') return send(200, viewer(), 'text/javascript; charset=utf-8');
      const fileMatch = /^\/api\/files\/([a-f0-9]{16})$/.exec(url.pathname);
      const handler = routes[`${req.method} ${url.pathname}`] || (req.method === 'GET' && fileMatch) || (req.method === 'POST' && url.pathname === '/api/upload');
      if (!handler) return send(404, { error: 'Not found.' });
      const given = Buffer.from(String(req.headers['x-console-token'] || ''));
      const expected = Buffer.from(token);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return send(401, { error: 'Open the console with the URL it printed (the token changes on each start).' });
      if (fileMatch) {
        const meta = fileMeta(stateDir, fileMatch[1]);
        if (!meta) return send(404, { error: 'File not found.' });
        res.writeHead(200, { 'content-type': meta.kind === 'image' ? meta.mime : 'application/octet-stream', 'content-length': meta.size,
          'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'content-disposition': 'attachment' });
        return fs.createReadStream(meta.path).on('error', () => res.destroy()).pipe(res);
      }
      if (url.pathname === '/api/upload') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_FILE_BYTES) return send(413, { error: `Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.` }); chunks.push(chunk); }
        let name = 'file';
        try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch {}
        return send(200, publicMeta(storeBuffer(stateDir, name, Buffer.concat(chunks), { by: 'user' })));
      }
      let body = {};
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { error: 'JSON required.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) return send(413, { error: 'Request too large.' }); chunks.push(chunk); }
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      }
      send(200, await handler(body));
    } catch (error) {
      send(400, { error: String(error.message || error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  const timers = [setInterval(() => engine.tick().catch(error => log(`tick: ${error.message}`)), tickMs),
    setInterval(() => refreshCatalog().catch(error => log(`discovery: ${error.message}`)), availabilityMs)];
  refreshCatalog().catch(error => log(`discovery: ${error.message}`));
  engine.tick().catch(error => log(`tick: ${error.message}`));
  const url = `http://127.0.0.1:${actualPort}/#t=${token}`;
  // Lets a second launch (a double-clicked shortcut) reopen this running console instead of failing.
  const serverFile = path.join(stateDir, 'console', 'server.json');
  if (!demo) {
    try { fs.mkdirSync(path.dirname(serverFile), { recursive: true }); fs.writeFileSync(serverFile, JSON.stringify({ port: actualPort, token, pid: process.pid }), { mode: 0o600 }); }
    catch (error) { log(`Could not record the running console: ${error.message}`); }
  }
  return { url, port: actualPort, token, stateDir, engine, refreshCatalog,
    async close() {
      timers.forEach(clearInterval);
      if (!demo) try { if (JSON.parse(fs.readFileSync(serverFile, 'utf8')).pid === process.pid) fs.unlinkSync(serverFile); } catch {}
      await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.();
    } };
}

/** URL of a console already running for this state directory, if it answers with its recorded token. */
export async function runningConsole({ stateDir, env = process.env } = {}) {
  stateDir = path.resolve(stateDir || defaultStateDir({ env }));
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(stateDir, 'console', 'server.json'), 'utf8')); } catch { return null; }
  if (!Number.isInteger(info?.port) || typeof info.token !== 'string') return null;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/state`, { headers: { 'x-console-token': info.token }, signal: AbortSignal.timeout(2000) });
    return response.ok ? `http://127.0.0.1:${info.port}/#t=${info.token}` : null;
  } catch { return null; }
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  if (options.help) {
    console.log('Usage: node scripts/console.mjs [--port 4317] [--no-open] [--demo] [--state-dir <dir>]\nSee docs/CONSOLE.md.');
    process.exit(0);
  }
  if (!options.demo) {
    const existing = await runningConsole({ stateDir: options.stateDir });
    if (existing) {
      console.log(`Bridge Console is already running: ${existing}`);
      if (options.open) openBrowser(existing);
      process.exit(0);
    }
  }
  try {
    const app = await startConsole(options);
    console.log(`Bridge Console ${version}${options.demo ? ' (DEMO — simulated sessions)' : ''}`);
    console.log(`Open: ${app.url}`);
    console.log(`State: ${app.stateDir}`);
    console.log('Press Ctrl+C to stop. Requests and history are kept and shown again next time.');
    if (options.open) openBrowser(app.url);
    const stop = () => app.close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `Port ${options.port} is in use. Is the console already running? Use --port <n> to pick another.` : error.message);
    process.exit(1);
  }
}
