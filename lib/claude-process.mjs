import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

/** Claude Code on Linux records `linux:<machine-id>:pid:[<pid namespace>]` and the process start time from
 * /proc/<pid>/stat (clock ticks since boot). Both are read here directly; nothing is spawned. */
function linuxIdentity(record, { readFile, readLink }) {
  let machineId, namespace;
  try { machineId = readFile('/etc/machine-id', 'utf8').trim(); namespace = readLink('/proc/self/ns/pid'); } catch {
    throw new Error('This Linux system does not expose a machine ID or PID namespace, so the Claude process cannot be verified.');
  }
  if (record.pidDomain !== `linux:${machineId}:${namespace}` || !/^[0-9]+$/.test(String(record.procStart))) {
    throw new Error('Claude session belongs to a different process namespace or has invalid creation metadata.');
  }
  let start = null;
  try {
    const stat = readFile(`/proc/${record.pid}/stat`, 'utf8');
    // The command name can contain spaces and parentheses; the fields after its last ")" are fixed.
    start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {}
  if (start !== record.procStart) throw new Error('Claude session is offline or its process identity changed. Open the intended Code session again.');
}

/** Verify the registry's creation token against the actual local process.
 * The injectable probe and platform keep OS policy tests independent of the host.
 */
export function assertClaudeProcessIdentity(record, { platform = process.platform,
  hostName = hostname(), spawn = spawnSync, readFile = readFileSync, readLink = readlinkSync } = {}) {
  if (platform === 'linux') {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('Claude session has invalid creation metadata.');
    return linuxIdentity(record, { readFile, readLink });
  }
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error('Verified Claude process identity is supported only on Windows, macOS, and Linux.');
  }
  const expectedDomain = platform === 'win32' ? `win32:${hostName.toLowerCase()}` : 'darwin';
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pidDomain !== expectedDomain ||
      typeof record.procStart !== 'string' || !record.procStart ||
      (platform === 'win32' && !/^[0-9]+$/.test(record.procStart))) {
    throw new Error('Claude session belongs to a different process namespace or has invalid creation metadata.');
  }
  // Only the validated PID is passed to the OS; keys, sockets and messages are not.
  const result = platform === 'win32'
    ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${record.pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 16_384 })
    : spawn('/bin/ps', ['-o', 'lstart=', '-p', String(record.pid)],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 16_384, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() !== record.procStart) {
    throw new Error('Claude session is offline or its process identity changed. Open the intended Code session again.');
  }
}
