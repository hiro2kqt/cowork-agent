#!/usr/bin/env node
// Bridge Relay: open the Bridge Console from anywhere in your tailnet, like Claude's /remote-control.
//
// Runs on a server. The laptop's console connects OUT to it (HTTP long-polling) and the relay passes
// each browser request down that connection; the console on the laptop answers it as usual. Nothing
// on the laptop listens to the network. Node.js standard library only.
//
//   node scripts/relay.mjs --name console.example.com [--port 80] [--listen <tailscale IP>]
//   node scripts/relay.mjs --name console.example.com --listen 127.0.0.1 --port 8787   (behind nginx, which sets X-Real-IP)
//
// There is no login: access is your Tailscale network. The relay therefore listens on the server's
// Tailscale address only, accepts only tailnet clients, answers only to the names given with --name
// (and its Tailscale IP), and refuses requests sent by other web pages.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const POLL_MS = 25_000;          // a laptop poll is held this long when nothing is waiting
const OFFLINE_MS = 45_000;       // no poll for this long: the laptop is offline
const ANSWER_MS = 120_000;       // a browser request waits this long for the laptop's answer
const MAX_BODY = 72 * 1024 * 1024;
// Response headers passed from the console to the browser.
const PASS_HEADERS = ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy',
  'x-frame-options', 'content-disposition'];

/** Tailscale addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnet(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
}

export function tailscaleAddress(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) for (const item of list || []) {
    if (item.family === 'IPv4' && isTailnet(item.address)) return item.address;
  }
  return null;
}

export function parseArgs(argv) {
  const options = { listen: null, port: 80, names: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--listen') options.listen = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--name') options.names.push(String(argv[++i] || '').toLowerCase());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be 1–65535.');
  if (options.names.some(name => !/^[a-z0-9.-]+$/.test(name))) throw new Error('--name must be a host name such as console.example.com.');
  return options;
}

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

/** The relay's own page: the machines that run a Bridge Console, to pick one. */
function machinesPage(machines, { current, note = '' } = {}) {
  // Two consoles with the same computer name (for example two state folders): tell them apart by ID.
  const twice = new Set(machines.map(m => m.name).filter((name, i, all) => all.indexOf(name) !== i));
  const rows = machines.map(m => `<a class="m${m.online ? '' : ' off'}" href="/relay/use?m=${encodeURIComponent(m.id)}">
  <span class="dot${m.online ? ' on' : ''}"></span>
  <span class="grow"><b>${esc(m.name)}</b>${twice.has(m.name) ? ` <span class="sub">#${esc(m.id.slice(0, 6))}</span>` : ''}${m.id === current ? ' <span class="tag">current</span>' : ''}<br>
  <span class="sub">${esc(m.platform || '')}${m.version ? ` · ${esc(m.version)}` : ''} · ${m.online ? 'online' : `offline · seen ${ago(m.lastPoll)}`}</span></span>
  <span class="go">${m.online ? 'Open ›' : ''}</span></a>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#141413" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-capable" content="yes"><meta http-equiv="refresh" content="5"><title>Bridge Console</title><style>
:root{--bg:#f7f7f5;--panel:#fff;--line:#e6e5e1;--text:#1d1d1b;--muted:#8a8984;--ok:#1f8a4c;--soft:#f0efec;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1c1c1b;--line:#2e2e2c;--text:#ecebe8;--muted:#8f8d87;--ok:#62cc8f;--soft:#252523}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);display:flex;justify-content:center;
padding:max(28px,env(safe-area-inset-top)) 14px max(28px,env(safe-area-inset-bottom))}
main{width:min(520px,100%)}h1{font-size:18px;margin:0 0 4px}.lead{color:var(--muted);font-size:13.5px;margin:0 0 18px}
.m{display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:inherit;text-decoration:none;margin-bottom:10px}
.m:hover{border-color:var(--muted)}.m.off{opacity:.6;pointer-events:none}.grow{flex:1;min-width:0}.sub{color:var(--muted);font-size:12.5px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}.dot.on{background:var(--ok)}
.go{color:var(--muted);font-size:13px}.tag{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--soft);color:var(--muted);font-weight:400}
.empty{border:1px dashed var(--line);border-radius:12px;padding:22px 16px;color:var(--muted);font-size:14px;line-height:1.7}
.note{background:var(--soft);border-radius:10px;padding:10px 12px;font-size:13.5px;margin-bottom:14px}code{font-size:12.5px}
</style></head><body><main><h1>Bridge Console</h1><p class="lead">Machines running the console and connected to this relay. Updates every 5 seconds.</p>
${note ? `<div class="note">${esc(note)}</div>` : ''}
${rows || `<div class="empty">No machine is connected yet.<br>On the computer that runs Codex and Claude Code, start the Bridge Console and connect it to this address (sidebar → <b>Cloud</b>, or <code>node scripts/console.mjs --connect https://${'${host}'}</code>).</div>`}
</main></body></html>`;
}

export async function startRelay({ listen, port = 80, names = [], log = message => console.error(message), allowAddress = isTailnet } = {}) {
  listen ||= tailscaleAddress();
  if (!listen) throw new Error('No Tailscale address found on this server. Connect it to your tailnet (tailscale up), or pass --listen <tailscale IP>.');
  if (['0.0.0.0', '::'].includes(listen)) throw new Error('Listening on every interface would expose the console without a login. Use the Tailscale address, or 127.0.0.1 behind nginx.');
  // Behind a reverse proxy on this server (nginx), the client is the proxy; the real address comes in X-Real-IP.
  const behindProxy = ['127.0.0.1', '::1', 'localhost'].includes(listen);
  const clientAddress = req => {
    const peer = req.socket.remoteAddress || '';
    const loopback = /^(::ffff:)?127\.|^::1$/.test(peer);
    return behindProxy && loopback ? String(req.headers['x-real-ip'] || '') : peer;
  };

  // Every computer whose console connects here: its own queue of browser requests and parked polls.
  const machines = new Map();  // id -> { id, name, platform, version, lastPoll, queue, polls }
  const waiting = new Map();   // job id -> browser request handed to a machine, awaiting its answer
  let server;
  const isOnline = m => m.polls.length > 0 || Date.now() - m.lastPoll < OFFLINE_MS;
  const listing = () => [...machines.values()].map(m => ({ id: m.id, name: m.name, platform: m.platform, version: m.version, lastPoll: m.lastPoll, online: isOnline(m) }))
    .sort((a, b) => (b.online - a.online) || b.lastPoll - a.lastPoll);

  function machineFor(req) {
    const id = String(req.headers['x-console-machine-id'] || 'default').slice(0, 64);
    let m = machines.get(id);
    if (!m) { m = { id, queue: [], polls: [], lastPoll: 0 }; machines.set(id, m); log(`Machine connected: ${id}`); }
    let name = String(req.headers['x-console-machine'] || '');
    try { name = decodeURIComponent(name); } catch {}
    m.name = (name || m.name || id).slice(0, 80);
    m.platform = String(req.headers['x-console-platform'] || m.platform || '').slice(0, 20);
    m.version = String(req.headers['x-console-version'] || m.version || '').slice(0, 40);
    m.lastPoll = Date.now();
    return m;
  }

  /** The machine this browser uses: its cookie choice, or the only one online. */
  function chosen(req) {
    const id = /(?:^|;\s*)bridge_machine=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const picked = id && machines.get(decodeURIComponent(id));
    if (picked) return picked;
    const online = [...machines.values()].filter(isOnline);
    return online.length === 1 ? online[0] : null;
  }

  // Names this relay answers to: the --name values and its own address. Anything else is DNS rebinding.
  function hostAllowed(host) {
    const name = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return names.includes(name) || name === listen;
  }

  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  function json(res, status, value) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  function page(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
    res.end(html.replace('${host}', esc(names[0] || listen)));
  }

  function hand(poll, job) {
    clearTimeout(poll.timer);
    waiting.set(job.id, job);
    poll.res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-relay-id': job.id,
      'x-relay-method': job.method, 'x-relay-path': encodeURIComponent(job.path),
      'x-relay-content-type': job.contentType, 'x-relay-file-name': job.fileName });
    poll.res.end(job.body);
  }

  async function forward(req, res, url) {
    const m = chosen(req);
    if (!m || !isOnline(m)) {
      if (url.pathname.startsWith('/api/')) {
        return json(res, 503, { error: m ? `${m.name} is offline.` : 'No machine is chosen.', relay: true, machines: '/machines' });
      }
      return page(res, 200, machinesPage(listing(), { current: m?.id, note: m ? `${m.name} is offline. Choose another machine, or start the console on it.` : '' }));
    }
    const body = ['GET', 'HEAD'].includes(req.method) ? Buffer.alloc(0) : await readBody(req, MAX_BODY);
    const job = { id: crypto.randomUUID(), method: req.method, path: url.pathname + url.search, body,
      contentType: String(req.headers['content-type'] || ''), fileName: String(req.headers['x-file-name'] || ''), res };
    job.timer = setTimeout(() => {
      const i = m.queue.indexOf(job);
      if (i >= 0) m.queue.splice(i, 1);
      waiting.delete(job.id);
      json(res, 504, { error: `${m.name} did not answer in time.`, relay: true });
    }, ANSWER_MS);
    res.on('close', () => {
      if (res.writableEnded) return;
      clearTimeout(job.timer); waiting.delete(job.id);
      const i = m.queue.indexOf(job); if (i >= 0) m.queue.splice(i, 1);
    });
    const poll = m.polls.shift();
    if (poll) hand(poll, job); else m.queue.push(job);
  }

  server = http.createServer(async (req, res) => {
    try {
      if (!allowAddress(clientAddress(req))) { res.writeHead(403); return res.end(); }
      const url = new URL(req.url, 'http://relay');
      // Only by a name of this relay, and never sent by another web page (that would also let a page take a machine's polls).
      if (!hostAllowed(req.headers.host)) return json(res, 421, { error: `Open the console by its address${names[0] ? ` (https://${names[0]})` : ''}.` });
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !hostAllowed(new URL(origin).host)) return json(res, 403, { error: 'Cross-site request refused.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused.' });

      // The machines' side.
      if (url.pathname.startsWith('/connector/')) {
        if (req.method === 'GET' && url.pathname === '/connector/poll') {
          const m = machineFor(req);
          const job = m.queue.shift();
          const poll = { res };
          if (job) return hand(poll, job);
          poll.timer = setTimeout(() => {
            const i = m.polls.indexOf(poll); if (i >= 0) m.polls.splice(i, 1);
            m.lastPoll = Date.now(); res.writeHead(204); res.end();
          }, POLL_MS);
          res.on('close', () => { clearTimeout(poll.timer); const i = m.polls.indexOf(poll); if (i >= 0) m.polls.splice(i, 1); });
          m.polls.push(poll);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/connector/answer') {
          machineFor(req);
          const job = waiting.get(String(req.headers['x-relay-id'] || ''));
          const body = await readBody(req, MAX_BODY);
          if (!job) return json(res, 410, { error: 'That request is gone.' });
          waiting.delete(job.id);
          clearTimeout(job.timer);
          let headers = {};
          try { headers = JSON.parse(String(req.headers['x-relay-headers'] || '{}')); } catch {}
          const pass = Object.fromEntries(PASS_HEADERS.filter(name => typeof headers[name] === 'string').map(name => [name, headers[name]]));
          if (!job.res.writableEnded) { job.res.writeHead(Number(req.headers['x-relay-status']) || 502, pass); job.res.end(body); }
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'Not found.' });
      }

      // The relay's own pages.
      if (url.pathname === '/machines') return page(res, 200, machinesPage(listing(), { current: chosen(req)?.id }));
      if (url.pathname === '/relay/use') {
        const id = url.searchParams.get('m') || '';
        if (!machines.has(id)) { res.writeHead(303, { location: '/machines' }); return res.end(); }
        res.writeHead(303, { location: '/', 'set-cookie': `bridge_machine=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
        return res.end();
      }
      if (url.pathname === '/relay/status') {
        const m = chosen(req);
        return json(res, 200, { online: Boolean(m && isOnline(m)), machine: m ? m.name : null, laptopVersion: m?.version || '', machines: listing() });
      }
      await forward(req, res, url);
    } catch (error) {
      json(res, error.status || 400, { error: String(error.message || error) });
    }
  });
  server.requestTimeout = 0; // long polls and large uploads
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, listen, resolve); });
  return { listen, port: server.address().port,
    close: () => new Promise(resolve => { for (const m of machines.values()) for (const p of m.polls) p.res.destroy(); server.close(resolve); server.closeAllConnections?.(); }) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  if (options.help) {
    console.log('Usage: node scripts/relay.mjs --name console.example.com [--port 80] [--listen <tailscale IP>]\nSee docs/RELAY.md.');
    process.exit(0);
  }
  try {
    const relay = await startRelay(options);
    // Behind nginx the public address is https://<name>; otherwise this server's own port.
    const proxied = ['127.0.0.1', '::1', 'localhost'].includes(relay.listen);
    const where = proxied ? `https://${options.names[0]}` : `http://${options.names[0] || relay.listen}${relay.port === 80 ? '' : `:${relay.port}`}`;
    console.log(`Bridge Relay on ${relay.listen}:${relay.port} (tailnet only).`);
    console.log(`Phone: ${where}`);
    console.log(`Laptop, once: node scripts/console.mjs --connect ${where}`);
    const stop = () => relay.close().finally(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error.code === 'EACCES' ? `Port ${options.port} needs root or CAP_NET_BIND_SERVICE (see docs/RELAY.md), or use --port 8787.` : error.message);
    process.exit(1);
  }
}
