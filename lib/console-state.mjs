// Shared coordination state for the Bridge Console.
//
// One JSON document per bridge state directory, written atomically under the store's file lock.
// Three kinds of process touch it: the console server (user actions, deliveries), each agent's
// MCP server (console_post reports, AI-to-AI exchange budget), and tests. Nothing here talks to a
// transport; delivery lives in console-engine.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withStateLock } from './store.mjs';

export const AGENTS = ['codex', 'claude'];
export const AGENT_LABEL = { codex: 'Codex', claude: 'Claude' };
export const POST_KINDS = ['ack', 'progress', 'done', 'blocked', 'question', 'reply', 'route'];
export const DEFAULT_PEER_LIMIT = 8;
const MAX_REQUESTS = 500;
const MAX_EVENTS = 4000;
const MAX_TEXT = 65536;
// A delivery left in `sending` this long belongs to a console process that stopped mid-write.
export const SENDING_STALE_MS = 60_000;

export const other = agent => (agent === 'codex' ? 'claude' : 'codex');
const now = () => Date.now();

export function consoleDir(stateDir) { return path.join(path.resolve(stateDir), 'console'); }
const stateFile = stateDir => path.join(consoleDir(stateDir), 'coordination.json');

export function emptyState() {
  return {
    schemaVersion: 1, version: 0, seq: 0, eventSeq: 0,
    selection: { codex: null, claude: null },
    router: null,
    roles: { codex: '', claude: '' },
    peerLimit: DEFAULT_PEER_LIMIT,
    peer: { count: 0, since: 0, blocked: 0 },
    requests: [], events: [], imported: {},
  };
}

export function readState(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8'));
    if (!value || value.schemaVersion !== 1) throw new Error('Unsupported console state');
    return { ...emptyState(), ...value };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`The Bridge Console state is unreadable: ${error.message}`);
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; } catch (error) {
        // Windows readers can briefly hold the destination open.
        if (process.platform !== 'win32' || attempt > 40 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** Mutate the shared document under the cross-process lock. `fn` may return a value. */
export function updateState(stateDir, fn) {
  const dir = consoleDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  return withStateLock(dir, () => {
    const state = readState(stateDir);
    const result = fn(state);
    state.version++;
    if (state.requests.length > MAX_REQUESTS) state.requests = state.requests.slice(-MAX_REQUESTS);
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
    writeAtomic(stateFile(stateDir), state);
    return result;
  });
}

export function text(value, name, max = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new Error(`${name} must be nonempty text of at most ${max} bytes.`);
  }
  return value;
}

/** @mentions decide recipients without the router. Returns the assigned agents, or [] if none. */
export function parseMentions(message) {
  const found = new Set();
  for (const match of String(message).matchAll(/(^|[^\w@])@(codex|claude|all)\b/gi)) {
    const name = match[2].toLowerCase();
    if (name === 'all') { found.add('codex'); found.add('claude'); } else found.add(name);
  }
  return AGENTS.filter(agent => found.has(agent));
}

export function nextEventId(state) { state.eventSeq = (state.eventSeq || 0) + 1; return `E${state.eventSeq}`; }

export function addEvent(state, event) {
  const record = { id: nextEventId(state), at: now(), ...event };
  state.events.push(record);
  return record;
}

export function findRequest(state, id) { return state.requests.find(request => request.id === id) || null; }

/** Delivery record for one recipient and one purpose; the key makes a dispatch idempotent. */
export function addDelivery(request, { to, purpose, body }) {
  const id = `${request.id}-${purpose}-${to}`;
  const existing = request.deliveries.find(delivery => delivery.id === id);
  if (existing) return existing;
  const delivery = { id, to, purpose, body, status: 'pending', createdAt: now(), attempts: [], readAt: null, doneAt: null };
  request.deliveries.push(delivery);
  return delivery;
}

/** The exchange budget for direct AI-to-AI messages between the selected pair.
 * Returns null when this pair is not coordinated by the console, else { allowed, count, limit }.
 * The count resets whenever the user sends from the console or grants more turns. */
export function consumePeerBudget(stateDir, { fromKind, fromId, toKind, toId }) {
  let snapshot;
  try { snapshot = readState(stateDir); } catch { return null; }
  if (!pairMatches(snapshot, fromKind, fromId, toKind, toId)) return null;
  return updateState(stateDir, state => {
    if (!pairMatches(state, fromKind, fromId, toKind, toId)) return null;
    const limit = Number.isSafeInteger(state.peerLimit) && state.peerLimit > 0 ? state.peerLimit : DEFAULT_PEER_LIMIT;
    if (state.peer.count >= limit) {
      if (!state.peer.blocked) addEvent(state, { from: 'system', kind: 'peer_limit', text:
        `${AGENT_LABEL[fromKind]} tried to message ${AGENT_LABEL[toKind]} after ${limit} AI-to-AI messages. Further messages wait for you.` });
      state.peer.blocked = (state.peer.blocked || 0) + 1;
      return { allowed: false, count: state.peer.count, limit };
    }
    state.peer.count++;
    return { allowed: true, count: state.peer.count, limit };
  });
}

function pairMatches(state, fromKind, fromId, toKind, toId) {
  return state.selection?.[fromKind]?.id === fromId && state.selection?.[toKind]?.id === toId && fromKind !== toKind;
}

export function resetPeerBudget(state) { state.peer = { count: 0, since: now(), blocked: 0 }; }

/** Apply a report an agent sent with console_post. `agent` is the verified caller kind. */
export function applyAgentPost(state, agent, args, attachments = []) {
  const kind = args.kind;
  if (!POST_KINDS.includes(kind)) throw new Error(`kind must be one of ${POST_KINDS.join(', ')}.`);
  const request = args.request_id ? findRequest(state, args.request_id) : null;
  if (args.request_id && !request) throw new Error(`Unknown console request ${args.request_id}.`);
  const message = args.message === undefined ? '' : text(args.message, 'message');
  if (kind === 'route') {
    if (!request) throw new Error('A routing decision needs request_id.');
    if (state.router !== agent || request.routing?.router !== agent) throw new Error('Only the selected router may route this request.');
    const assignee = args.assignee;
    if (!['codex', 'claude', 'both', 'unclear'].includes(assignee)) throw new Error('assignee must be codex, claude, both, or unclear.');
    const requestType = args.request_type === 'chat' ? 'chat' : 'task';
    const decision = { assignee, requestType, interpretation: args.interpretation?.trim() || '', question: args.question?.trim() || '',
      options: Array.isArray(args.options) ? args.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 6).map(o => o.slice(0, 200)) : [],
      at: now() };
    const event = addEvent(state, { from: agent, to: 'user', kind: 'route', requestId: request.id, text: message || describeDecision(decision), decision,
      ...(attachments.length ? { attachments } : {}) });
    if (request.status !== 'routing') {
      event.note = 'Arrived after the request left routing; it did not change the assignment.';
      return { event, applied: false };
    }
    request.routing.decision = decision;
    // A plain question or conversation needs no executor: whoever it addresses (both if unclear)
    // answers, and nobody is allowed to act on it, so it goes out without asking the user.
    if (requestType === 'chat') {
      sendChat(request, assignee === 'codex' || assignee === 'claude' ? [assignee] : AGENTS, 'router');
      return { event, applied: true };
    }
    // Only a single, clear executor is assigned automatically. Two executors, a split, or doubt
    // always comes back to the user, so the router never puts both agents to work by itself.
    if (assignee === 'codex' || assignee === 'claude') assign(request, [assignee], 'router');
    else request.status = 'awaiting_user';
    return { event, applied: true };
  }
  const event = addEvent(state, { from: agent, to: args.to === other(agent) ? other(agent) : 'user', kind,
    requestId: request?.id ?? null, text: message || (attachments.length ? '' : defaultPostText(kind)),
    ...(attachments.length ? { attachments } : {}) });
  if (request) {
    for (const delivery of request.deliveries.filter(d => d.to === agent)) {
      // An agent's own report proves it read the request; transport success alone never does.
      delivery.readAt ??= event.at;
      if (kind === 'done' && delivery.purpose === 'assign') delivery.doneAt = event.at;
      // A chat message is complete once that agent answered it.
      if (['reply', 'done'].includes(kind) && (delivery.purpose === 'chat' || delivery.purpose === 'reply')) delivery.doneAt = event.at;
      if (kind === 'blocked' && delivery.purpose === 'assign') delivery.blockedAt = event.at;
    }
  }
  return { event, applied: true };
}

function defaultPostText(kind) {
  return { ack: 'Read the request.', progress: 'Working on it.', done: 'Finished.', blocked: 'Blocked.',
    question: 'Has a question.', reply: '(empty reply)' }[kind] || kind;
}

export function describeDecision(decision) {
  const who = { codex: 'Codex', claude: 'Claude', both: 'both agents', unclear: 'unclear' }[decision.assignee];
  return decision.assignee === 'unclear' ? 'The router could not tell who should carry this out.' : `The router proposes: ${who}.`;
}

/** Mark the executors and create their deliveries (bodies are rendered later by the engine). */
export function assign(request, assignees, by, clarification) {
  request.assignees = AGENTS.filter(agent => assignees.includes(agent));
  request.observers = request.notifyOther ? AGENTS.filter(agent => !request.assignees.includes(agent)) : [];
  request.assignedBy = by;
  if (clarification) request.clarification = clarification;
  request.status = 'dispatching';
  for (const agent of request.assignees) addDelivery(request, { to: agent, purpose: 'assign' });
  for (const agent of request.observers) addDelivery(request, { to: agent, purpose: 'observe' });
}

/** A conversational message: each recipient answers; nobody is assigned work. */
export function sendChat(request, agents, by) {
  request.kind = 'chat';
  request.assignees = AGENTS.filter(agent => agents.includes(agent));
  request.observers = [];
  request.assignedBy = by;
  request.status = 'dispatching';
  for (const agent of request.assignees) addDelivery(request, { to: agent, purpose: 'chat' });
}

/** Overall request phase, derived from its deliveries, for the list and the attention counter. */
export function requestPhase(request) {
  if (request.status === 'routing' || request.status === 'awaiting_user' || request.status === 'cancelled') return request.status;
  const work = request.deliveries.filter(d => ['assign', 'reply', 'chat'].includes(d.purpose));
  const all = request.deliveries.filter(d => d.purpose !== 'route');
  if (all.some(d => d.status === 'failed' || d.status === 'uncertain')) return 'delivery_problem';
  if (all.some(d => d.status === 'pending' || d.status === 'sending')) return 'dispatching';
  if (work.length && work.every(d => d.doneAt)) return 'done';
  if (work.some(d => d.readAt)) return 'in_progress';
  return 'delivered';
}
