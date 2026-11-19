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

const OFFLINE_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Bridge Console — offline</title>
<style>:root{color-scheme:light dark;font:15px/1.6 system-ui,sans-serif}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;background:Canvas}</style>
</head><body><div><b>The laptop is offline.</b><br><span style="opacity:.7">Start the Bridge Console on it. This page retries every 10 seconds.</span></div></body></html>`;

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

  const queue = [];            // browser requests waiting for a laptop poll
  const polls = [];            // laptop polls waiting for a browser request
  const waiting = new Map();   // id -> browser request handed to the laptop, awaiting its answer
  let lastPoll = 0, laptopVersion = '', server;
  const online = () => polls.length > 0 || Date.now() - lastPoll < OFFLINE_MS;

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

  function hand(poll, job) {
    clearTimeout(poll.timer);
    waiting.set(job.id, job);
    poll.res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-relay-id': job.id,
      'x-relay-method': job.method, 'x-relay-path': encodeURIComponent(job.path),
      'x-relay-content-type': job.contentType, 'x-relay-file-name': job.fileName });
    poll.res.end(job.body);
  }

  async function forward(req, res, url) {
    if (!online()) {
      if (url.pathname.startsWith('/api/')) return json(res, 503, { error: 'The laptop is offline. Start the Bridge Console on it.' });
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(OFFLINE_PAGE);
    }
    const body = ['GET', 'HEAD'].includes(req.method) ? Buffer.alloc(0) : await readBody(req, MAX_BODY);
    const job = { id: crypto.randomUUID(), method: req.method, path: url.pathname + url.search, body,
      contentType: String(req.headers['content-type'] || ''), fileName: String(req.headers['x-file-name'] || ''), res };
    job.timer = setTimeout(() => {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      waiting.delete(job.id);
      json(res, 504, { error: 'The laptop did not answer in time.' });
    }, ANSWER_MS);
    res.on('close', () => {
      if (res.writableEnded) return;
      clearTimeout(job.timer); waiting.delete(job.id);
      const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1);
    });
    const poll = polls.shift();
    if (poll) hand(poll, job); else queue.push(job);
  }

  server = http.createServer(async (req, res) => {
    try {
      if (!allowAddress(clientAddress(req))) { res.writeHead(403); return res.end(); }
      const url = new URL(req.url, 'http://relay');
      // Only by a name of this relay, and never sent by another web page (that would also let a page take the laptop's polls).
      if (!hostAllowed(req.headers.host)) return json(res, 421, { error: `Open the console by its address${names[0] ? ` (http://${names[0]})` : ''}.` });
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !hostAllowed(new URL(origin).host)) return json(res, 403, { error: 'Cross-site request refused.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request refused.' });

      // The laptop side.
      if (url.pathname.startsWith('/connector/')) {
        lastPoll = Date.now();
        laptopVersion = String(req.headers['x-console-version'] || '').slice(0, 40);
        if (req.method === 'GET' && url.pathname === '/connector/poll') {
          const job = queue.shift();
          const poll = { res };
          if (job) return hand(poll, job);
          poll.timer = setTimeout(() => {
            const i = polls.indexOf(poll); if (i >= 0) polls.splice(i, 1);
            lastPoll = Date.now(); res.writeHead(204); res.end();
          }, POLL_MS);
          res.on('close', () => { clearTimeout(poll.timer); const i = polls.indexOf(poll); if (i >= 0) polls.splice(i, 1); });
          polls.push(poll);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/connector/answer') {
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

      if (url.pathname === '/relay/status') return json(res, 200, { online: online(), laptopVersion });
      await forward(req, res, url);
    } catch (error) {
      json(res, error.status || 400, { error: String(error.message || error) });
    }
  });
  server.requestTimeout = 0; // long polls and large uploads
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, listen, resolve); });
  return { listen, port: server.address().port,
    close: () => new Promise(resolve => { for (const p of polls) p.res.destroy(); server.close(resolve); server.closeAllConnections?.(); }) };
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
