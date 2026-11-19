import crypto from 'node:crypto';
import { publicDelivery } from './delivery.mjs';
import { stateDirectoryWarning } from './state-directory.mjs';
import { legacyEnvironmentWarnings } from './legacy-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverClaudeSessions, resolveClaudeSession, resolveClaudeCaller, sendToClaude, probeClaudeInbox } from './claude-sessions.mjs';
import { listCodexTools, listCodexChats, sendToCodex } from './codex-desktop.mjs';
import { publishCodexHost, getCodexHosts } from './codex-host.mjs';
import { canonicalLocalSocket, localSocketPresence } from './local-socket.mjs';
import { defaultStateDir, createSession, getSession, recordMessage, finishMessage, getMessages } from './store.mjs';
import { readComposerEnterBehavior } from './codex-settings.mjs';
import { openDaemon, listTerminalThreads, readDaemonVersions, readTerminalThread, sendToTerminalThread, normalizeCodexThreadId,
  queueToTerminalThread, queueRefusal, queueTargetRefusal, TerminalNotLoadedError, DaemonUnavailableError, NOT_RUNNING_MESSAGE, scrubPaths } from './codex-daemon.mjs';
import { codexPeerContent } from './codex-peer.mjs';
import { validateSshHostAlias } from './codex-ssh.mjs';
import { readState, updateState, applyAgentPost, consumePeerBudget, AGENT_LABEL } from './console-state.mjs';
import { storePaths, withAttachments } from './console-files.mjs';

export function codexThreadId(metadata = {}) {
  let turn = metadata['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); } catch { throw new Error('Invalid Codex turn metadata'); }
  }
  if (turn !== undefined && (turn === null || typeof turn !== 'object' || Array.isArray(turn))) throw new Error('Invalid Codex turn metadata');
  const candidates = [turn?.thread_id, metadata['openai/threadId'], metadata['openai/thread_id'],
    metadata['codex/threadId'], metadata.codexThreadId, metadata.codex_thread_id, metadata.threadId,
    metadata.thread_id, metadata.thread?.id].filter(v => v !== undefined);
  if (candidates.some(v => typeof v !== 'string' || !v.trim())) throw new Error('Invalid Codex task identity in MCP metadata');
  const identities = [...new Set(candidates.map(normalizeCodexThreadId))];
  if (identities.length > 1) throw new Error('Conflicting Codex task identities in MCP metadata');
  // A server can serve multiple tasks. Its startup CODEX_THREAD_ID identifies
  // the host context, not necessarily the task making this particular call.
  const threadId = identities[0];
  if (!threadId) throw new Error('The calling Codex task identity is unavailable in this tool call.');
  return threadId;
}

export function codexIdentity(metadata = {}, env = process.env) {
  const threadId = codexThreadId(metadata);
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error('Codex Desktop did not provide its local app-tools pipe');
  return { threadId, pipePath: env.CODEX_APP_TOOLS_PIPE_PATH };
}

function settings(context) {
  const env = context.env || process.env;
  return { env, sshSpawn: context.sshSpawn, platform: context.platform ?? process.platform,
    stateDir: context.stateDir || defaultStateDir({ env }),
    registryDir: context.registryDir || env.CLAUDE_CODEX_BRIDGE_REGISTRY_DIR ||
      (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'sessions') : undefined),
    daemon: context.daemon,
    daemonVersion: context.daemonVersion,
    desktop: context.desktop,
    queue: context.queue,
  };
}

function sshHost(config) {
  if (config.platform !== 'darwin' || config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST === undefined) return null;
  return { sshHostAlias: validateSshHostAlias(config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST),
    ...(config.sshSpawn ? { spawnImpl: config.sshSpawn } : {}) };
}

/** A Desktop-only user, without the Codex CLI or a running daemon, should not see a terminal warning on every listing;
 * bridge_doctor still reports it. */
export function shouldReportTerminalUnavailable(error, desktopSucceeded) {
  return !(desktopSucceeded === true && error instanceof DaemonUnavailableError &&
    (/executable was not found/i.test(error.message) || error.message === NOT_RUNNING_MESSAGE));
}

function checkCancellation(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Bridge request was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

// Routing and identity probes run before every Codex send, including Desktop-only ones, so they
// get a short budget instead of the 10 s connect and 15 s request defaults. A caller-supplied
// daemon timeout (bridge_doctor's) wins.
const PROBE_TIMEOUT_MS = 3000;
const probeTimeout = config => config.daemon?.timeoutMs ?? PROBE_TIMEOUT_MS;

async function withDaemon(config, signal, action, { timeoutMs } = {}) {
  const connection = await openDaemon({ env: config.env, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(config.daemon ?? {}) });
  try { return await action(connection); } finally { connection.close(); }
}

/** Creation origin does not identify a thread's current client. A stored, unloaded
 * thread needs an explicit transport; a loaded daemon thread is directly addressable. */
async function resolveTerminalTarget(threadId, transport, config, signal) {
  if (!['auto', 'desktop', 'terminal'].includes(transport)) throw new Error('Invalid Codex transport. Choose auto, desktop, or terminal.');
  if (transport === 'desktop') return false;
  const timeoutMs = probeTimeout(config);
  try {
    const thread = await withDaemon(config, signal, connection => readTerminalThread(connection, threadId, { signal, timeoutMs }), { timeoutMs });
    if (!thread) {
      if (transport === 'terminal') throw new Error('The selected Codex session was not found in the Codex daemon thread store.');
      return false;
    }
    const queueRoute = thread.status?.type === 'notLoaded';
    if (queueRoute && transport === 'auto') throw new Error('The selected Codex session is not loaded in the daemon, so its current client cannot be determined. Set transport to desktop for Codex Desktop or terminal for Codex CLI. No message was sent.');
    return { queueRoute, allowQueue: transport === 'terminal' };
  } catch (error) {
    checkCancellation(signal);
    // Explicit terminal selection also supports a standalone CLI without a running daemon.
    // The queue command still enforces the kill switch and validates the exact thread ID.
    if (error instanceof DaemonUnavailableError) return transport === 'terminal'
      ? { queueRoute: true, queueOnly: true, allowQueue: true } : false;
    throw error;
  }
}

async function identifyCaller(context, config) {
  const meta = context.metadata || {};
  const hasCodexMetadata = ['x-codex-turn-metadata', 'openai/threadId', 'openai/thread_id',
    'codex/threadId', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id', 'thread'].some(key => Object.hasOwn(meta, key));
  const notClaude = !config.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (notClaude && config.env.CODEX_APP_TOOLS_PIPE_PATH && hasCodexMetadata) {
    return { kind: 'codex', transport: 'desktop', ...codexIdentity(meta, config.env) };
  }
  if (notClaude && hasCodexMetadata) {
    const threadId = codexThreadId(meta);
    // The host supplies identity per call. Historical originator/source fields and
    // daemon availability cannot verify which client currently owns this caller.
    return { kind: 'codex', transport: 'terminal', threadId };
  }
  const endpoint = resolveClaudeCaller({ registryDir: config.registryDir, parentPid: context.parentPid ?? process.ppid,
    socketPath: config.env.CLAUDE_CODE_MESSAGING_SOCKET });
  return { kind: 'claude', endpoint };
}

async function caller(context, config, { publish = false } = {}) {
  const who = await identifyCaller(context, config);
  // Host publication is needed for outbound routing from Codex to Claude and
  // for Claude's later send_to_codex discovery. bridge_doctor is the explicit,
  // non-destructive way to register a task, and its annotations say it writes;
  // catalog and history calls, which the panel repeats, stay truly read-only.
  // Terminal callers have no Desktop endpoint to publish.
  if (publish && who.kind === 'codex' && who.transport === 'desktop') {
    publishCodexHost({ stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId });
  }
  return who;
}

function publicThread({ thread_id, title = '', status = 'unknown', cwd = '', host_id, source }) {
  return { thread_id, title, status, cwd, host_id, source };
}

function sender(who) {
  return who.kind === 'codex'
    ? { kind: 'codex', id: who.threadId }
    : { kind: 'claude', id: who.endpoint.sessionId };
}

function senderLabel(id) {
  // Claude's native `from` field is a short, single-line display label. The
  // message notice below carries the complete, escaped reply address.
  return `Codex task ${id.replace(/[\r\n\0]/g, ' ').slice(0, 180)}`;
}

function senderLedgerId(who) {
  // Preserve existing Codex task ledgers. Prefix Claude IDs so their ledgers
  // cannot collide with a Codex task or depend on a prior one-to-one pairing.
  return who.kind === 'codex' ? who.threadId : `claude:${who.endpoint.sessionId}`;
}

function senderLedger(who, config, create = false) {
  const threadId = senderLedgerId(who);
  const existing = getSession({ stateDir: config.stateDir, threadId });
  if (existing || !create) return existing;
  fs.mkdirSync(config.stateDir, { recursive: true });
  // A stable user-owned directory avoids binding a conversation's history to
  // the plugin cache or whichever project happened to launch its MCP server.
  return createSession({ stateDir: config.stateDir, threadId, cwd: config.stateDir });
}

// Desktop's tool catalog answers in milliseconds even while its tool execution is stuck, so a
// short catalog probe tells a stopped app from a stalled one before the longer discovery wait.
const DESKTOP_TIMEOUTS = { catalogMs: 3000, listMs: 10000, budgetMs: 15000 };

// The context each Desktop pipe last accepted in this MCP process. A send reuses it instead of
// proving it again with chat discovery, so a stalled discovery tool cannot block delivery.
const acceptedContexts = new Map();

/** Find a saved Desktop endpoint and context that work, probing each pipe once. Pipes that no
 * longer exist are skipped without a connection, and a pipe that stalls is not retried with its
 * other contexts. Returns { host, catalog, chats } on success and always a report of the rest.
 */
async function selectDesktopHost(hosts, config, signal, { limit = 1, reuse = false, compatible } = {}) {
  const timeouts = { ...DESKTOP_TIMEOUTS, ...(config.desktop ?? {}) };
  const deadline = Date.now() + timeouts.budgetMs;
  // A wait the budget cut short proves nothing about the app: its timeout counts as unchecked, not stalled.
  const wait = cap => { const ms = Math.max(1, Math.min(cap, deadline - Date.now())); return { ms, cut: ms < cap }; };
  const report = { budgetMs: timeouts.budgetMs, gone: 0, stalled: 0, rejected: 0, incompatible: 0, compatible: 0,
    unchecked: 0, errors: [], tools: undefined };
  const pipes = new Map();
  for (const host of hosts) {
    const pipePath = host && canonicalLocalSocket(host.pipePath);
    if (!pipePath) continue;
    if (!pipes.has(pipePath)) pipes.set(pipePath, []);
    if (typeof host.threadId === 'string' && host.threadId.trim() && !pipes.get(pipePath).includes(host.threadId)) {
      pipes.get(pipePath).push(host.threadId);
    }
  }
  const present = localSocketPresence();
  const failed = (error, cut) => {
    checkCancellation(signal);
    if (error.code === 'ENDPOINT_GONE') report.gone++;
    else if (error.code === 'DESKTOP_TIMEOUT') report[cut ? 'unchecked' : 'stalled']++;
    else if (error.code === 'CONTEXT_REJECTED') report.rejected++;
    else report.errors.push(scrubPaths(String(error.message)).slice(0, 200));
  };
  for (const [pipePath, contexts] of pipes) {
    if (Date.now() >= deadline) { report.unchecked += Math.max(1, contexts.length); continue; }
    if (present(pipePath) === false) { report.gone++; continue; }
    let catalog;
    const catalogWait = wait(timeouts.catalogMs);
    try { catalog = await listCodexTools(pipePath, { signal, timeoutMs: catalogWait.ms }); }
    catch (error) { failed(error, catalogWait.cut); continue; }
    report.tools = catalog.map(tool => String(tool?.name ?? ''));
    if (compatible && !compatible(catalog)) { report.incompatible++; continue; }
    report.compatible++;
    const accepted = contexts.includes(acceptedContexts.get(pipePath)) ? acceptedContexts.get(pipePath) : undefined;
    if (reuse && accepted) return { host: { pipePath, threadId: accepted }, catalog, report };
    for (const threadId of accepted ? [accepted, ...contexts.filter(id => id !== accepted)] : contexts) {
      if (Date.now() >= deadline) { report.unchecked++; continue; }
      const listWait = wait(timeouts.listMs);
      try {
        const chats = await listCodexChats({ pipePath, contextThreadId: threadId, limit, signal, catalog, timeoutMs: listWait.ms });
        acceptedContexts.set(pipePath, threadId);
        return { host: { pipePath, threadId }, catalog, chats, report };
      } catch (error) {
        // Only a rejection disproves the context. A stalled or cut-short listing says nothing about
        // it, and dropping it there would let a doctor or discovery call block the next send.
        if (error.code === 'CONTEXT_REJECTED' && acceptedContexts.get(pipePath) === threadId) acceptedContexts.delete(pipePath);
        failed(error, listWait.cut);
        // Every context on a stalled app waits for the same stuck tool execution, so trying the
        // pipe's other contexts only multiplies the wait. A cut wait means the budget is spent.
        if (error.code === 'DESKTOP_TIMEOUT') break;
      }
    }
  }
  return { report };
}

/** One sentence per cause, most actionable first, so a stale record never hides a stalled app. */
function desktopFailure(report) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const causes = [];
  if (report.stalled) causes.push('Codex Desktop is running but did not answer in time; restart Codex Desktop, then retry.');
  if (report.rejected) causes.push(`Codex Desktop rejected ${plural(report.rejected, 'saved task context')}, probably of removed tasks; call bridge_doctor once from an open Codex Desktop task to register it.`);
  if (report.incompatible) causes.push('A running Codex Desktop does not expose compatible discovery and message tools; update Codex Desktop.');
  if (report.errors.length) causes.push(`Endpoint errors: ${[...new Set(report.errors)].join(' ')}`);
  if (report.unchecked) causes.push(`${plural(report.unchecked, 'saved endpoint record')} could not be checked within ${report.budgetMs / 1000} s.`);
  if (report.gone) causes.push(`${plural(report.gone, 'saved endpoint')} belong${report.gone === 1 ? 's' : ''} to earlier Codex Desktop launches.${causes.length ? ''
    : ' Open a Codex Desktop task with the bridge enabled; its bridge server registers the current endpoint when it starts.'}`);
  return causes.length ? causes.join(' ') : 'No saved Codex Desktop endpoint has a usable task context.';
}

async function desktopRoute(who, config, signal, options) {
  checkCancellation(signal);
  if (who.kind === 'codex' && who.transport === 'desktop') return { host: { pipePath: who.pipePath, threadId: who.threadId } };
  const hosts = getCodexHosts({ stateDir: config.stateDir });
  if (hosts.length === 0) throw new Error('Codex Desktop has not registered its bridge endpoint yet. Open Codex with the plugin enabled, or run the installer from an open Codex task.');
  const selected = await selectDesktopHost(hosts, config, signal, options);
  if (!selected.host) throw new Error(`No registered Codex Desktop endpoint accepted a task context. ${desktopFailure(selected.report)}`);
  return selected;
}

function inspectStateDirectory(stateDir) {
  const directory = path.resolve(stateDir);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid state directory');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return { status: 'pass', detail: 'The shared state directory is readable and writable.' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'fail', detail: 'The shared state location must be a readable, writable real directory. Check its configuration and permissions.' };
  }
  let ancestor = path.dirname(directory);
  for (;;) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid state parent');
      fs.accessSync(ancestor, fs.constants.R_OK | fs.constants.W_OK);
      return { status: 'warning', detail: 'The state directory does not exist yet. Its parent is accessible; an authorized send or host registration will create it.' };
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) {
        return { status: 'fail', detail: 'The shared state directory cannot be created under its configured parent. Check the location and permissions.' };
      }
      ancestor = path.dirname(ancestor);
    }
  }
}

/** Diagnose local configuration and transports, registering only verified Desktop
 * callers. Never send prompts or return credentials and local addresses.
 */
async function bridgeDoctor(context, config) {
  const signal = context.signal;
  checkCancellation(signal);
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add('platform', ['win32', 'darwin', 'linux'].includes(config.platform) ? 'pass' : 'fail',
    config.platform === 'win32' ? 'Claude Code and Codex transports are supported on Windows.'
      : config.platform === 'darwin' ? 'macOS uses Claude Unix inboxes and an operator-configured Codex SSH host.'
      : config.platform === 'linux' ? 'Linux uses Claude Unix inboxes and the Codex CLI (daemon or queue); Codex Desktop does not run on Linux.'
      : 'Claude process identity verification is supported on Windows, macOS, and Linux.');
  checks.push({ name: 'state_directory', ...inspectStateDirectory(config.stateDir) });
  const migrationWarning = stateDirectoryWarning(config.stateDir);
  if (migrationWarning) add('state_migration', 'warning', migrationWarning);
  for (const warning of legacyEnvironmentWarnings(config.env)) add('legacy_environment', 'warning', warning);
  let application = config.env.CLAUDE_CODE_MESSAGING_SOCKET ? 'claude'
    : config.env.CODEX_APP_TOOLS_PIPE_PATH ? 'codex' : 'unknown';
  const doctorConfig = { ...config, daemon: { ...(config.daemon ?? {}), timeoutMs: 2000 } };
  let who;
  try {
    who = await identifyCaller(context, doctorConfig);
    application = who.kind;
    add('caller', 'pass', 'The calling conversation has a verified runtime identity.');
  } catch {
    add('caller', 'fail', application === 'unknown'
      ? 'No caller identity is available. Run this tool from the intended Claude Code or Codex conversation.'
      : application === 'codex'
      ? 'This call has no valid Codex task context. Run the tool from an open Codex task with the bridge enabled.'
      : 'The direct Claude parent session could not be verified. Open the bridge in the intended Claude Code session.');
  }
  checkCancellation(signal);
  if (who?.kind === 'codex' && who.transport === 'desktop') {
    try { publishCodexHost({ stateDir: config.stateDir, pipePath: who.pipePath, threadId: who.threadId }); }
    catch { add('codex_registration', 'fail', 'The verified Codex Desktop task could not be registered. Check the shared state directory and saved endpoint records.'); }
  }
  let acceptedContext = false;
  let daemonReachable = false;
  let terminalSessions = 0;
  const sshConfigured = config.platform === 'darwin' && config.env.CLAUDE_CODEX_BRIDGE_SSH_HOST !== undefined;
  if (sshConfigured) {
    add('codex_registry', 'pass', 'The configured SSH route does not use the local Desktop registry or daemon.');
    try {
      const chats = await listCodexChats({ ...sshHost(config), limit: 50, signal, timeoutMs: 6000 });
      add('codex_tools', 'pass', 'The configured SSH host accepts public app-server discovery.');
      acceptedContext = chats.some(chat => chat.status === 'idle');
      add('codex_context', acceptedContext ? 'pass' : 'warning', acceptedContext
        ? 'The configured SSH host has a loaded idle chat.'
        : 'No idle chat was found in the bounded loaded-chat catalog. Open the intended idle chat on the configured SSH host.');
    } catch (error) {
      checkCancellation(signal);
      add('codex_tools', 'fail', `The configured SSH route is unavailable: ${String(error.message).slice(0, 300)}`);
      add('codex_context', 'fail', 'SSH discovery failed. No local Codex transport was attempted.');
    }
  } else {
    let hosts = [];
    try {
      hosts = getCodexHosts({ stateDir: config.stateDir });
      const present = localSocketPresence();
      const existing = hosts.filter(host => present(host.pipePath) !== false).length;
      add('codex_registry', existing ? 'pass' : 'warning', !hosts.length
        ? 'No saved Codex endpoint is registered. Call bridge_doctor once from an open Codex Desktop task before discovery from Claude.'
        : existing ? `Saved Codex endpoint records are valid; ${existing} of ${hosts.length} point to an existing endpoint.`
        : `None of the ${hosts.length} saved Codex endpoint records points to an existing endpoint; they belong to earlier Codex Desktop launches. Open a Codex Desktop task with the bridge enabled.`);
    } catch {
      add('codex_registry', 'fail', 'Saved Codex endpoint records are malformed or unreadable. Check the shared state configuration.');
    }
    try {
      terminalSessions = (await withDaemon(doctorConfig, signal, connection => listTerminalThreads(connection, { limit: 1, signal, timeoutMs: 2000 }))).length;
      daemonReachable = true;
      add('codex_daemon', 'pass', terminalSessions
        ? 'The Codex daemon is reachable and lists stored Codex sessions. Their current client is not implied by discovery.'
        : 'The Codex daemon is reachable, but no stored Codex session is available yet. Start a Codex conversation.');
    } catch (error) {
      checkCancellation(signal);
      add('codex_daemon', 'warning', `Terminal Codex sessions are unavailable: ${error.message}`);
    }
    const versions = await readDaemonVersions({ env: config.env, timeoutMs: 2000, ...(config.daemonVersion ?? {}) });
    if (versions) {
      const differ = versions.cli && versions.server && versions.cli !== versions.server;
      add('codex_versions', differ ? 'warning' : 'pass',
        `Codex CLI ${versions.cli ?? 'unknown'}, daemon ${versions.server ?? 'unknown'}.${differ ? ' They differ; update or restart so both run the same version.' : ''}`);
    }
    const current = who?.kind === 'codex' && who.transport === 'desktop' ? { pipePath: who.pipePath, threadId: who.threadId }
      : config.env.CODEX_APP_TOOLS_PIPE_PATH ? { pipePath: config.env.CODEX_APP_TOOLS_PIPE_PATH,
        threadId: config.env.CODEX_THREAD_ID } : null;
    const compatible = tools => {
      const messageTool = tools.find(tool => tool?.name === 'send_message_to_thread');
      const listTool = tools.find(tool => tool?.name === 'list_threads');
      return typeof messageTool?.namespace === 'string' && Boolean(messageTool.namespace) &&
        messageTool.inputSchema?.properties?.threadId?.type === 'string' &&
        messageTool.inputSchema?.properties?.prompt?.type === 'string' &&
        typeof listTool?.namespace === 'string' && Boolean(listTool.namespace) &&
        ['integer', 'number'].includes(listTool.inputSchema?.properties?.limit?.type);
    };
    // A slower Desktop build needs seconds for one discovery; a shorter wait would report a healthy app as stalled.
    const { host, report } = await selectDesktopHost([current, ...hosts],
      { ...config, desktop: { catalogMs: 1500, listMs: 5000, budgetMs: 8000, ...config.desktop } }, signal, { compatible });
    acceptedContext = Boolean(host);
    const codexStatus = passed => passed ? 'pass' : report.unchecked || daemonReachable ? 'warning' : 'fail';
    add('codex_tools', codexStatus(report.compatible > 0), report.compatible
      ? 'Codex exposes compatible discovery and message tool schemas.'
      : report.incompatible ? `No checked Codex endpoint exposes compatible tools. Enable the bridge in Codex and check the application version. Catalog tools: ${report.tools.join(', ').slice(0, 600)}`
      : `No Codex Desktop tool catalog answered. ${desktopFailure(report)}`);
    add('codex_context', codexStatus(acceptedContext), acceptedContext
      ? 'Codex accepted a registered context for read-only chat discovery.'
      : `No checked Codex context accepted chat discovery. ${desktopFailure(report)}`);
  }
  let sessions = [];
  try {
    sessions = discoverClaudeSessions({ registryDir: config.registryDir });
    add('claude_registry', sessions.length ? 'pass' : 'fail', sessions.length
      ? 'Live Claude Code sessions are registered.'
      : 'No live Claude Code session with an inbox is registered. Open the intended session and check its Peer address in /status.');
  } catch {
    add('claude_registry', 'fail', 'The Claude session registry is unreadable or invalid. Check Claude configuration and reopen its Code session.');
  }
  let inboxAvailable = false;
  const claudeDeadline = Date.now() + 4500;
  let claudeChecked = 0;
  for (const session of sessions) {
    if (Date.now() >= claudeDeadline) break;
    claudeChecked++;
    checkCancellation(signal);
    try {
      const endpoint = who?.kind === 'claude' && who.endpoint.sessionId === session.sessionId ? who.endpoint
        : resolveClaudeSession(session.sessionId, { registryDir: config.registryDir });
      await probeClaudeInbox({ socketPath: endpoint.socketPath, signal,
        timeoutMs: Math.min(1500, Math.max(1, claudeDeadline - Date.now())) });
      inboxAvailable = true;
      break;
    } catch { checkCancellation(signal); }
  }
  const claudeIncomplete = !inboxAvailable && claudeChecked < sessions.length;
  add('claude_inbox', inboxAvailable ? 'pass' : claudeIncomplete ? 'warning' : 'fail', inboxAvailable
    ? 'A verified Claude inbox accepts local connections. This check sent no message.'
    : claudeIncomplete ? 'Some Claude inboxes were not checked within the diagnostic time budget. Availability is inconclusive.'
    : 'No checked Claude inbox is available with a valid session key. Reopen the intended Claude Code session.');
  return { application, ready: (acceptedContext || (daemonReachable && terminalSessions > 0)) && inboxAvailable && checks.every(check => check.status !== 'fail'), checks };
}

async function listCodexThreadsAs(who, config, limit, signal) {
  const context = { signal };
  const ssh = sshHost(config);
  if (ssh) return { threads: (await listCodexChats({ ...ssh, limit, signal: context.signal }))
    .map(chat => publicThread({ ...chat, source: 'ssh' })), warnings: [] };
  const warnings = [];
  let chats = [];
  let desktopFailed = false;
  let terminalFailed = false;
  try {
    // The listing itself proves the context; a separate one-chat probe would double the wait.
    const found = await desktopRoute(who, config, context.signal, { limit });
    const desktop = found.chats ?? await listCodexChats({ pipePath: found.host.pipePath, contextThreadId: found.host.threadId,
      limit, signal: context.signal });
    chats = desktop.map(chat => ({ ...chat, source: 'desktop' }));
  } catch (error) {
    checkCancellation(context.signal);
    desktopFailed = true;
    warnings.push(`Codex Desktop unavailable: ${error.message}`);
  }
  try {
    const terminal = await withDaemon(config, context.signal, connection => listTerminalThreads(connection,
      { limit, signal: context.signal, timeoutMs: PROBE_TIMEOUT_MS }), { timeoutMs: PROBE_TIMEOUT_MS });
    // Source names describe discovery transports, not the thread's current client.
    // Retain the Desktop title and metadata when both transports list the same ID.
    const desktopIds = new Set(chats.map(chat => chat.thread_id));
    chats = [...chats, ...terminal.filter(chat => !desktopIds.has(chat.thread_id))];
  } catch (error) {
    checkCancellation(context.signal);
    terminalFailed = true;
    if (shouldReportTerminalUnavailable(error, !desktopFailed)) {
      warnings.push(`Codex terminal sessions unavailable: ${error.message}`);
    }
  }
  if (desktopFailed && terminalFailed) throw new Error(warnings.join(' '));
  return { threads: chats.map(publicThread), warnings };
}

export async function executeBridgeTool(name, args = {}, context = {}) {
  checkCancellation(context.signal);
  const config = settings(context);
  if (name === 'bridge_doctor') return bridgeDoctor(context, config);
  if (name === 'list_claude_sessions') return { sessions: discoverClaudeSessions({ registryDir: config.registryDir })
    .map(({ sessionId, name: title, cwd, entrypoint, status }) => ({ session_id: sessionId, title, cwd, entrypoint, status })) };
  const publishesHost = ['send_to_claude', 'send_to_codex', 'panel_send', 'panel_retry_notice'].includes(name);
  const who = await caller(context, config, { publish: publishesHost });
  if (['bridge_panel', 'panel_history', 'panel_send', 'panel_retry_notice'].includes(name)) {
    if (who.kind !== 'codex' || who.transport !== 'desktop') throw new Error('The conversation panel is available only from a Codex Desktop chat.');
    if (name === 'panel_send') {
      const { manualSend } = await import('./manual-service.mjs');
      return manualSend(args, context);
    }
    if (name === 'panel_retry_notice') {
      const { retryManualNotice } = await import('./manual-service.mjs');
      return retryManualNotice(args, context);
    }
    const { listClaudeConversations } = await import('./claude-history.mjs');
    const { getBridgeConversation } = await import('./bridge-history.mjs');
    if (name === 'panel_history') return getBridgeConversation({ stateDir: config.stateDir,
      ownerThreadId: who.threadId, sessionId: args.session_id, limit: args.limit, cursor: args.cursor, signal: context.signal });
    const catalog = await listClaudeConversations({ registryDir: config.registryDir,
      projectsDir: path.join(config.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
      stateDir: config.stateDir, ownerThreadId: who.threadId, signal: context.signal });
    return { owner_thread_id: who.threadId, application: 'codex', sessions: catalog.conversations, warnings: catalog.warnings,
      composer_enter_behavior: readComposerEnterBehavior({ env: config.env }) };
  }
  if (name === 'console_post') return consolePost(who, args, config);
  if (name === 'list_codex_threads') return listCodexThreadsAs(who, config, args.limit || 30, context.signal);
  if (name === 'list_deliveries') {
    const session = senderLedger(who, config);
    return { application: who.kind, sender_id: sender(who).id,
      deliveries: session ? getMessages(session, args.limit || 20, undefined, sender(who)).map(publicDelivery) : [] };
  }
  if (name !== 'send_to_claude' && name !== 'send_to_codex') throw new Error('Unknown bridge tool');
  if ((name === 'send_to_claude') !== (who.kind === 'codex')) throw new Error(`Use ${who.kind === 'codex' ? 'send_to_claude' : 'send_to_codex'} from this application.`);
  const direction = who.kind === 'codex' ? 'to_claude' : 'to_codex';
  const targetThreadId = direction === 'to_codex' ? normalizeCodexThreadId(args.thread_id) : null;
  const ssh = direction === 'to_codex' ? sshHost(config) : null;
  const transport = args.transport ?? 'auto';
  if (ssh && !['auto', 'ssh'].includes(transport)) throw new Error('This bridge is pinned to the configured SSH host. Use auto or ssh transport; local Desktop and terminal routes are not selected from this configuration.');
  if (!ssh && direction === 'to_codex' && transport === 'ssh') throw new Error('SSH delivery requires CLAUDE_CODEX_BRIDGE_SSH_HOST on macOS.');
  const endpoint = direction === 'to_claude' ? resolveClaudeSession(args.session_id, { registryDir: config.registryDir }) : null;
  const terminalTarget = direction === 'to_codex' && !ssh ? await resolveTerminalTarget(targetThreadId, transport, config, context.signal) : false;
  const desktop = direction === 'to_codex' && !ssh && !terminalTarget
    ? await desktopRoute(who, config, context.signal, { reuse: true }) : null;
  const host = ssh || desktop?.host || null;
  const route = { from: sender(who), to: direction === 'to_claude'
    ? { kind: 'claude', id: endpoint.sessionId }
    : { kind: 'codex', id: targetThreadId, ...(ssh ? { host_id: `ssh:${ssh.sshHostAlias}` } : {}) } };
  const messageId = args.message_id ?? crypto.randomUUID();
  // Attached files are copied into the shared console store; the text carries their markers and paths.
  if (args.files?.length) {
    if (ssh) throw new Error('Files cannot be attached on the SSH route: the remote Codex host cannot open local paths. Describe the file instead.');
    args = { ...args, message: withAttachments(args.message, storePaths(config.stateDir, args.files, { by: who.kind })) };
  }
  const peerText = terminalTarget || ssh ? codexPeerContent({ fromKind: 'claude', fromId: route.from.id, bridgeMessageId: messageId, body: args.message }) : undefined;
  // Refuse before recordMessage reserves the ID, so a message that can never be sent does not spend it as failed.
  const queueRefused = terminalTarget?.queueRoute ? queueTargetRefusal(targetThreadId) || queueRefusal(peerText) : null;
  if (queueRefused) throw new Error(queueRefused);
  checkCancellation(context.signal);
  // The Bridge Console caps direct AI-to-AI turns between its selected pair until the user speaks
  // again. Refused before recordMessage, so the message ID is not spent. Manual sends are the user's.
  if (context.manual !== true) {
    const budget = consumePeerBudget(config.stateDir, { fromKind: route.from.kind, fromId: route.from.id,
      toKind: route.to.kind, toId: route.to.id });
    if (budget && !budget.allowed) throw new Error(`The Bridge Console limits direct AI-to-AI messages between these two sessions to ${budget.limit} per user turn, and that limit is reached. No message was sent. Report to the user with console_post (kind "question" or "progress") and wait for them; the user can allow more exchanges in the console.`);
  }
  const session = senderLedger(who, config, true);
  checkCancellation(context.signal);
  const reserved = recordMessage(session, { id: messageId, direction, message: args.message, route,
    manual: context.manual === true });
  if (!reserved.created) {
    if (reserved.message.status === 'failed') {
      throw new Error('This message_id already has a failed attempt. Inspect the destination before retrying with a new message_id.');
    }
    if (reserved.message.status !== 'submitted') {
      throw new Error(`This message_id has ${reserved.message.status} delivery. No new send was made; inspect the destination and list_deliveries before choosing a new message_id.`);
    }
    return { delivery: publicDelivery(reserved.message) };
  }
  let receipt;
  try {
    checkCancellation(context.signal);
    if (direction === 'to_claude') {
      const source = context.manual === true ? 'User sent from Codex Desktop task'
        : who.transport === 'terminal' ? 'From Codex terminal session' : 'From Codex Desktop task';
      const notice = `[${source} ${JSON.stringify(route.from.id)}; bridge message ${JSON.stringify(reserved.message.id)}]\n\n${args.message}`;
      receipt = await sendToClaude({ ...endpoint, message: notice, senderName: senderLabel(route.from.id), signal: context.signal });
    } else if (terminalTarget) {
      let sent;
      try {
        if (terminalTarget.queueOnly) throw new TerminalNotLoadedError('The daemon is unavailable for this explicit terminal route.');
        sent = await withDaemon(config, context.signal, connection => sendToTerminalThread(connection,
          { threadId: route.to.id, text: peerText, messageId: reserved.message.id, signal: context.signal }));
      } catch (error) {
        // Thrown before anything is written, so the queue fallback can never double-deliver.
        if (!(error instanceof TerminalNotLoadedError)) throw error;
        if (!terminalTarget.allowQueue) throw new Error('The selected Codex session left the daemon before sending. No message was sent. Select desktop or terminal transport explicitly.');
        sent = await queueToTerminalThread({ threadId: route.to.id, text: peerText, env: config.env, signal: context.signal,
          ...(config.queue ?? {}) });
      }
      receipt = { status: 'written', method: sent.method, ...(sent.turnId ? { turn_id: sent.turnId } : {}),
        ...(sent.queueId ? { queue_id: sent.queueId } : {}), acknowledged: false };
    } else if (ssh) {
      const delivered = await sendToCodex({ ...ssh, threadId: route.to.id, message: peerText, signal: context.signal });
      receipt = { ...delivered, host_id: route.to.host_id };
    } else {
      const entrypoint = who.endpoint.entrypoint;
      const client = entrypoint === 'claude-desktop' ? 'Claude Desktop' : entrypoint === 'claude-vscode' ? 'Claude Code VS Code' : 'Claude Code CLI';
      const notice = `[From ${client} session ${JSON.stringify(route.from.id)}; bridge message ${JSON.stringify(reserved.message.id)}]\n\n${args.message}`;
      try {
        await sendToCodex({ pipePath: host.pipePath, contextThreadId: host.threadId, catalog: desktop.catalog,
          threadId: route.to.id, message: notice, signal: context.signal });
      } catch (error) {
        // A reused context may belong to a task removed since; prove it again before the next send.
        if (acceptedContexts.get(host.pipePath) === host.threadId) acceptedContexts.delete(host.pipePath);
        throw error;
      }
    }
  } catch (error) {
    try { finishMessage(session, reserved.message.id, { status: error.deliveryUnknown ? 'uncertain' : 'failed', route, error: error.message }); }
    catch { error.message += ' The transport outcome could not be saved; inspect the receiving conversation before retrying.'; }
    throw error;
  }
  try {
    return { delivery: publicDelivery(finishMessage(session, reserved.message.id, { status: 'submitted', route, ...(receipt ? { receipt } : {}) })) };
  } catch {
    const error = new Error('The message was submitted, but its receipt could not be saved. Do not resend it without inspecting the receiving conversation.');
    error.deliveryUnknown = true;
    throw error;
  }
}

/** console_post: a selected participant reports to the user in the Bridge Console. The caller is
 * the verified runtime identity, so one session cannot report, acknowledge, or route for another. */
function consolePost(who, args, config) {
  const agent = who.kind;
  const id = agent === 'codex' ? who.threadId : who.endpoint.sessionId;
  let state;
  try { state = readState(config.stateDir); } catch (error) { throw new Error(error.message); }
  const selected = state.selection?.[agent];
  if (!selected) throw new Error(`The Bridge Console has no ${AGENT_LABEL[agent]} session selected. Nothing was posted.`);
  if (selected.id !== id) throw new Error(`This ${AGENT_LABEL[agent]} conversation is not the one selected in the Bridge Console. Nothing was posted.`);
  const files = storePaths(config.stateDir, args.files, { by: agent });
  const result = updateState(config.stateDir, current => {
    if (current.selection?.[agent]?.id !== id) throw new Error('The Bridge Console selection changed. Nothing was posted.');
    const { event, applied } = applyAgentPost(current, agent, args, files.map(file => file.id));
    const request = event.requestId ? current.requests.find(r => r.id === event.requestId) : null;
    return { event_id: event.id, applied, ...(event.note ? { note: event.note } : {}), ...(request ? { request_status: request.status } : {}) };
  });
  return { posted: true, ...result, ...(files.length ? { files: files.map(file => ({ id: file.id, name: file.name, kind: file.kind })) } : {}) };
}

/** Transport used by the Bridge Console server. The console sends as the user, so it has no caller
 * identity of its own; it reaches Claude by the selected session's inbox and Codex by the same
 * routes send_to_codex uses (SSH, daemon or queue, Desktop app-tools). */
export function consoleTransport(context = {}) {
  const config = settings(context);
  const consoleCaller = { kind: 'console' };
  return {
    platform: config.platform,
    async listClaude({ signal } = {}) {
      const { listClaudeConversations } = await import('./claude-history.mjs');
      const live = new Map(discoverClaudeSessions({ registryDir: config.registryDir }).map(s => [s.sessionId, s]));
      let catalog = { conversations: [], warnings: [] };
      try {
        catalog = await listClaudeConversations({ registryDir: config.registryDir,
          projectsDir: path.join(config.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
          stateDir: config.stateDir, ownerThreadId: 'bridge-console', signal });
      } catch (error) { catalog.warnings.push(`Claude history metadata unavailable: ${error.message}`); }
      const sessions = [...live.values()].map(session => {
        const known = catalog.conversations.find(c => c.session_id === session.sessionId);
        return { id: session.sessionId, title: session.name || known?.title || '', cwd: session.cwd || known?.cwd || '',
          entrypoint: session.entrypoint, status: session.status, live: true, last_activity_at: known?.last_activity_at ?? null };
      });
      return { sessions, warnings: catalog.warnings };
    },
    async listCodex({ signal, limit = 50 } = {}) {
      const { threads, warnings } = await listCodexThreadsAs(consoleCaller, config, limit, signal);
      return { threads: threads.map(t => ({ id: t.thread_id, title: t.title, cwd: t.cwd, status: t.status, source: t.source, host_id: t.host_id })), warnings };
    },
    async send({ to, target, message, messageId, signal }) {
      if (to === 'claude') {
        const endpoint = resolveClaudeSession(target.id, { registryDir: config.registryDir });
        const receipt = await sendToClaude({ ...endpoint, message, senderName: 'Bridge Console (user)', signal });
        return { method: 'claude-inbox', ...receipt };
      }
      if (to !== 'codex') throw new Error('Unknown console recipient.');
      const threadId = normalizeCodexThreadId(target.id);
      const ssh = sshHost(config);
      const transport = target.transport || 'auto';
      if (ssh) return { method: 'ssh', ...(await sendToCodex({ ...ssh, threadId, message, signal })) };
      if (transport === 'ssh') throw new Error('SSH delivery requires CLAUDE_CODEX_BRIDGE_SSH_HOST on macOS.');
      const terminalTarget = await resolveTerminalTarget(threadId, transport, config, signal);
      if (terminalTarget) {
        const refused = terminalTarget.queueRoute ? queueTargetRefusal(threadId) || queueRefusal(message) : null;
        if (refused) throw new Error(refused);
        try {
          if (terminalTarget.queueOnly) throw new TerminalNotLoadedError('The daemon is unavailable for this explicit terminal route.');
          const sent = await withDaemon(config, signal, connection => sendToTerminalThread(connection, { threadId, text: message, messageId, signal }));
          return { method: sent.method, turn_id: sent.turnId ?? null };
        } catch (error) {
          if (!(error instanceof TerminalNotLoadedError)) throw error;
          if (!terminalTarget.allowQueue) throw new Error('The selected Codex session left the daemon before sending. No message was sent. Choose the desktop or terminal route for this session.');
          const queued = await queueToTerminalThread({ threadId, text: message, env: config.env, signal, ...(config.queue ?? {}) });
          return { method: 'queue', queue_id: queued.queueId ?? null };
        }
      }
      const desktop = await desktopRoute(consoleCaller, config, signal, { reuse: true });
      try {
        await sendToCodex({ pipePath: desktop.host.pipePath, contextThreadId: desktop.host.threadId, catalog: desktop.catalog,
          threadId, message, signal });
      } catch (error) {
        if (acceptedContexts.get(desktop.host.pipePath) === desktop.host.threadId) acceptedContexts.delete(desktop.host.pipePath);
        throw error;
      }
      return { method: 'desktop' };
    },
    /** Direct deliveries between the selected pair, read from the bridge's own sender ledgers. */
    async peerMessages({ codexId, claudeId }) {
      const records = [];
      const ledgers = [{ from: 'codex', ledger: codexId, toKind: 'claude', toId: claudeId },
        { from: 'claude', ledger: `claude:${claudeId}`, toKind: 'codex', toId: codexId }];
      for (const { from, ledger, toKind, toId } of ledgers) {
        const session = getSession({ stateDir: config.stateDir, threadId: ledger });
        if (!session) continue;
        for (const record of getMessages(session, 200)) {
          if (record.route?.to?.kind !== toKind || record.route.to.id !== toId) continue;
          if (record.route.from?.id !== (from === 'codex' ? codexId : claudeId)) continue;
          records.push({ key: `${from}:${record.id}:${toId}`, from, to: toKind, message: record.message, status: record.status,
            error: typeof record.error === 'string' ? record.error : record.error?.message ?? null,
            createdAt: record.createdAt, manual: Boolean(record.manual) });
        }
      }
      return records;
    },
  };
}
