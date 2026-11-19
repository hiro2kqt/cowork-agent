// Simulated Codex and Claude sessions for `node scripts/console.mjs --demo` and the tests.
// They answer through the same shared state as the console_post MCP tool, so the console flow
// is exactly the real one; only the two conversations are fake. Nothing here touches a real app.
import { updateState, applyAgentPost, readState, consumePeerBudget } from './console-state.mjs';

export const DEMO_SESSIONS = {
  codex: [
    { id: '019a0000-demo-4000-8000-00000000c0de', title: 'Demo: Fusion enclosure redesign', cwd: '~/projects/demo-hardware', status: 'idle', source: 'desktop' },
    { id: '019a0000-demo-4000-8000-0000000000c2', title: 'Demo: Firmware refactor', cwd: '~/projects/demo-firmware', status: 'notLoaded', source: 'terminal' },
  ],
  claude: [
    { id: '7d1e0000-0000-4000-8000-00000000c1a0', title: 'Demo: Design review', cwd: '~/projects/demo-hardware', entrypoint: 'cli', status: 'idle', live: true },
    { id: '7d1e0000-0000-4000-8000-00000000c1a2', title: 'Demo: Docs writing', cwd: '~/projects/demo-docs', entrypoint: 'claude-desktop', status: 'busy', live: true },
  ],
};

export function demoTransport({ stateDir, delayMs = 700, log = () => {} }) {
  const peer = [];
  const failedOnce = new Set();
  const later = (ms, fn) => setTimeout(() => { try { fn(); } catch (error) { log(`demo: ${error.message}`); } }, ms * delayMs / 700);
  const post = (agent, args) => updateState(stateDir, state => applyAgentPost(state, agent, args));
  const ids = () => readState(stateDir).selection;

  function peerSend(from, to, message) {
    const selection = ids();
    if (!selection.codex || !selection.claude) return;
    const budget = consumePeerBudget(stateDir, { fromKind: from, fromId: selection[from].id, toKind: to, toId: selection[to].id });
    const allowed = !budget || budget.allowed;
    peer.push({ key: `${from}:demo-${peer.length}:${selection[to].id}`, from, to, message, status: allowed ? 'submitted' : 'failed',
      error: allowed ? null : 'Refused by the Bridge Console AI-to-AI limit.', createdAt: Date.now(), manual: false });
  }

  function behave(to, message) {
    const id = /request #(R\d+)/.exec(message)?.[1];
    if (!id) return;
    const verbatim = /"""\n([\s\S]*?)\n"""/.exec(message)?.[1] ?? '';
    if (message.includes('ROUTING ONLY')) {
      const lower = verbatim.toLowerCase();
      const codex = /\bcodex\b|fusion|cad/.test(lower);
      const claude = /\bclaude\b|review|read-only/.test(lower);
      const assignee = codex && claude ? 'both' : codex ? 'codex' : claude ? 'claude' : 'unclear';
      later(900, () => post(to, { kind: 'route', request_id: id, assignee,
        interpretation: assignee === 'unclear' ? '' : `The request is about ${codex ? 'CAD/Fusion work' : ''}${codex && claude ? ' and ' : ''}${claude ? 'a review' : ''}.`,
        question: assignee === 'unclear' ? 'Who should carry this out?' : assignee === 'both' ? 'Should both work on it, each within their role?' : '',
        options: assignee === 'unclear' || assignee === 'both' ? ['Codex', 'Claude', 'Both'] : [] }));
      return;
    }
    if (message.includes('FOR YOUR INFORMATION ONLY')) { later(1200, () => post(to, { kind: 'ack', request_id: id })); return; }
    const assigned = message.includes('You are ASSIGNED') || message.includes('The user is answering');
    if (!assigned) return;
    later(800, () => post(to, { kind: 'ack', request_id: id }));
    later(1800, () => post(to, { kind: 'progress', request_id: id, message: to === 'codex' ? 'Opening the model and checking the affected sketches.' : 'Reading the current design notes.' }));
    if (/\?\s*$|ask me/i.test(verbatim)) {
      later(2600, () => post(to, { kind: 'question', request_id: id, message: 'Should I keep the current wall thickness (2 mm)?' }));
      return;
    }
    const both = message.includes('together with the other agent');
    if (both && to === 'codex') {
      later(2800, () => peerSend('codex', 'claude', `#${id} Codex: first pass done. Could you review the change list?`));
      later(4200, () => peerSend('claude', 'codex', `#${id} Claude: reviewed — two notes, I'll report them to the user.`));
    }
    later(both ? 5200 : 3600, () => post(to, { kind: 'done', request_id: id, message: to === 'codex' ? 'Done (simulated). No real file was changed.' : 'Review finished (simulated).' }));
  }

  return {
    platform: 'demo',
    async listClaude() { return { sessions: DEMO_SESSIONS.claude, warnings: ['Demo mode: these sessions are simulated.'] }; },
    async listCodex() { return { threads: DEMO_SESSIONS.codex, warnings: ['Demo mode: these sessions are simulated.'] }; },
    async send({ to, target, message, messageId }) {
      const known = DEMO_SESSIONS[to].find(s => s.id === target.id);
      if (!known) throw new Error(`The selected ${to} session is unavailable (demo).`);
      // "#fail-claude" or "#fail-codex" in a message makes that recipient fail once, to try resending.
      const marker = `#fail-${to}`;
      const key = messageId.replace(/-a\d+$/, '');
      if (message.includes(marker) && !failedOnce.has(key)) {
        failedOnce.add(key);
        throw new Error(`Simulated failure: the ${to} session did not accept the write. Nothing was delivered.`);
      }
      behave(to, message);
      return { method: 'demo', status: 'written', acknowledged: false };
    },
    async peerMessages() { return peer.slice(); },
  };
}
