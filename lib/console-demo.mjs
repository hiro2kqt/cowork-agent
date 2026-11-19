// Simulated Codex and Claude sessions for `node scripts/console.mjs --demo` and the tests.
// They answer through the same shared state as the console_post MCP tool, so the console flow
// is exactly the real one; only the two conversations are fake. Nothing here touches a real app.
import { updateState, applyAgentPost, readState, consumePeerBudget } from './console-state.mjs';
import { storeBuffer, withAttachments } from './console-files.mjs';

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
  const post = (agent, args, files = []) => updateState(stateDir, state => applyAgentPost(state, agent, args, files.map(file => file.id)));
  const sample = () => [storeBuffer(stateDir, 'enclosure-render.svg', Buffer.from(demoRender()), { by: 'codex' }),
    storeBuffer(stateDir, 'enclosure.stl', demoStl(), { by: 'codex' })];
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
      if (/^(hi|hello|hey|alo|ping)\b|\?\s*$/i.test(verbatim.trim()) && !/\b(fix|edit|change|update|implement)\b/i.test(lower)) {
        later(900, () => post(to, { kind: 'route', request_id: id, request_type: 'chat', assignee: codex !== claude ? (codex ? 'codex' : 'claude') : 'both',
          interpretation: 'A question or greeting; it needs an answer, not work.' }));
        return;
      }
      later(900, () => post(to, { kind: 'route', request_id: id, request_type: 'task', assignee,
        interpretation: assignee === 'unclear' ? '' : `The request is about ${codex ? 'CAD/Fusion work' : ''}${codex && claude ? ' and ' : ''}${claude ? 'a review' : ''}.`,
        question: assignee === 'unclear' ? 'Who should carry this out?' : assignee === 'both' ? 'Should both work on it, each within their role?' : '',
        options: assignee === 'unclear' || assignee === 'both' ? ['Codex', 'Claude', 'Both'] : [] }));
      return;
    }
    if (message.includes('CONVERSATION — the user is talking')) {
      later(1000, () => post(to, { kind: 'reply', request_id: id, message: to === 'codex' ? 'Codex here — I can hear you (simulated).' : 'Claude here — loud and clear (simulated).' }));
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
      later(2800, () => peerSend('codex', 'claude', withAttachments(`#${id} Codex: first pass done. Could you review the render and the model?`, sample())));
      later(4200, () => peerSend('claude', 'codex', `#${id} Claude: reviewed — two notes, I'll report them to the user.`));
    }
    later(both ? 5200 : 3600, () => to === 'codex'
      ? post(to, { kind: 'done', request_id: id, message: 'Done (simulated). Render and model attached; no real file was changed.' }, sample())
      : post(to, { kind: 'done', request_id: id, message: 'Review finished (simulated).' }));
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

/** A simple "render" for the demo: an SVG image. */
function demoRender() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9edf5"/><stop offset="1" stop-color="#c9d2e3"/></linearGradient></defs>
<rect width="640" height="400" fill="url(#g)"/>
<polygon points="170,250 390,310 520,230 300,170" fill="#7b8db8"/>
<polygon points="170,250 170,190 300,110 300,170" fill="#5d6f9c"/>
<polygon points="300,170 300,110 520,170 520,230" fill="#91a3cf"/>
<polygon points="170,190 390,250 520,170 300,110" fill="#b8c5e6" opacity=".55"/>
<text x="24" y="40" font-family="sans-serif" font-size="20" fill="#2b3550">Enclosure — simulated render</text>
<text x="24" y="66" font-family="sans-serif" font-size="13" fill="#59617a">60 × 40 × 20 mm · wall 2 mm</text>
</svg>`;
}

/** A binary STL for the demo: an open enclosure (floor, four walls) with four screw posts. */
function demoStl() {
  const tris = [];
  const box = (x0, y0, z0, x1, y1, z1) => {
    const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) tris.push([p[a], p[b], p[c]], [p[a], p[c], p[d]]);
  };
  const post = (cx, cy, r, z0, z1, n = 24) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      const p0 = [cx + r * Math.cos(a), cy + r * Math.sin(a)], p1 = [cx + r * Math.cos(b), cy + r * Math.sin(b)];
      tris.push([[cx, cy, z1], [...p0, z1], [...p1, z1]], [[cx, cy, z0], [...p1, z0], [...p0, z0]],
        [[...p0, z0], [...p1, z0], [...p1, z1]], [[...p0, z0], [...p1, z1], [...p0, z1]]);
    }
  };
  box(0, 0, 0, 60, 40, 2);
  box(0, 0, 2, 60, 2, 20); box(0, 38, 2, 60, 40, 20); box(0, 2, 2, 2, 38, 20); box(58, 2, 2, 60, 38, 20);
  for (const [x, y] of [[7, 7], [53, 7], [7, 33], [53, 33]]) post(x, y, 3, 2, 14);
  const buffer = Buffer.alloc(84 + tris.length * 50);
  buffer.write('Bridge Console demo enclosure', 0);
  buffer.writeUInt32LE(tris.length, 80);
  tris.forEach((tri, i) => tri.forEach((v, j) => v.forEach((c, k) => buffer.writeFloatLE(c, 84 + i * 50 + 12 + j * 12 + k * 4))));
  return buffer;
}
