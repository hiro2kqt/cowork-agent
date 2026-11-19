// The laptop end of the Bridge Relay (scripts/relay.mjs). The console connects OUT to the relay and
// long-polls it; each browser request the relay hands over is replayed against this console on
// 127.0.0.1 with the local token, and the answer goes back up. Nothing here listens to the network.
import fs from 'node:fs';
import path from 'node:path';
import { consoleDir } from './console-state.mjs';

const PARALLEL = 4;   // concurrent polls, so a slow upload does not hold up the page
const PASS = ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy',
  'x-frame-options', 'content-disposition'];

export const cloudFile = stateDir => path.join(consoleDir(stateDir), 'cloud.json');

export function readCloud(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(cloudFile(stateDir), 'utf8'));
    return typeof value?.url === 'string' ? value : null;
  } catch { return null; }
}

export function saveCloud(stateDir, url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--connect needs an http:// or https:// address.');
  const value = { url: parsed.origin };
  fs.mkdirSync(consoleDir(stateDir), { recursive: true });
  fs.writeFileSync(cloudFile(stateDir), JSON.stringify(value), { mode: 0o600 });
  return value;
}

export function forgetCloud(stateDir) { fs.rmSync(cloudFile(stateDir), { force: true }); }

/** Keep polling the relay until stop() is called. Reports connection changes through `log`. */
export function connectCloud({ relay, localPort, token, version, log = () => {} }) {
  let stopped = false, connected = null;
  const controllers = new Set();
  const status = online => {
    if (connected === online) return;
    connected = online;
    log(online ? `Cloud: connected to ${relay}` : `Cloud: cannot reach ${relay}; retrying.`);
  };

  async function handle(response) {
    const id = response.headers.get('x-relay-id');
    const method = response.headers.get('x-relay-method') || 'GET';
    const target = decodeURIComponent(response.headers.get('x-relay-path') || '/');
    const body = Buffer.from(await response.arrayBuffer());
    let code = 502, headers = {}, out = Buffer.alloc(0);
    // Only the console's own paths, on this machine.
    if (!target.startsWith('/') || target.startsWith('//')) out = Buffer.from(JSON.stringify({ error: 'Bad path.' }));
    else {
      try {
        const local = await fetch(`http://127.0.0.1:${localPort}${target}`, { method,
          headers: { 'x-console-token': token, ...(response.headers.get('x-relay-content-type') ? { 'content-type': response.headers.get('x-relay-content-type') } : {}),
            ...(response.headers.get('x-relay-file-name') ? { 'x-file-name': response.headers.get('x-relay-file-name') } : {}) },
          body: ['GET', 'HEAD'].includes(method) ? undefined : body });
        code = local.status;
        headers = Object.fromEntries(PASS.map(name => [name, local.headers.get(name)]).filter(([, value]) => value !== null));
        out = Buffer.from(await local.arrayBuffer());
      } catch (error) { out = Buffer.from(JSON.stringify({ error: `Console on the laptop: ${error.message}` })); }
    }
    await fetch(`${relay}/connector/answer`, { method: 'POST', body: out,
      headers: { 'content-type': 'application/octet-stream', 'x-relay-id': id,
        'x-relay-status': String(code), 'x-relay-headers': JSON.stringify(headers), 'x-console-version': version } });
  }

  async function loop() {
    let delay = 1000;
    while (!stopped) {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 40_000);
      try {
        const response = await fetch(`${relay}/connector/poll`, { signal: controller.signal,
          headers: { 'x-console-version': version } });
        if (response.status >= 400) { await response.arrayBuffer().catch(() => {}); throw new Error(`relay answered ${response.status}`); }
        status(true);
        delay = 1000;
        if (response.status === 200) handle(response).catch(error => log(`Cloud: ${error.message}`));
        else await response.arrayBuffer().catch(() => {});
      } catch (error) {
        if (stopped) break;
        status(false);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      } finally { clearTimeout(timer); controllers.delete(controller); }
    }
  }

  for (let i = 0; i < PARALLEL; i++) loop();
  return { stop() { stopped = true; for (const c of controllers) c.abort(); } };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
