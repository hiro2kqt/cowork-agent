import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { storeBuffer, storePaths, fileMeta, idsInText, withAttachments, describeType } from '../lib/console-files.mjs';
import { updateState, applyAgentPost, readState } from '../lib/console-state.mjs';
import { startConsole } from '../scripts/console.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'console-files-'));

test('files are stored once by content, typed by extension, and referenced by marker', () => {
  const dir = tmp();
  const a = storeBuffer(dir, 'C:\\renders\\shot.PNG', Buffer.from('png-bytes'), { by: 'codex' });
  const b = storeBuffer(dir, 'other.png', Buffer.from('png-bytes'));
  assert.equal(a.id, b.id);
  assert.equal(a.name, 'shot.PNG');
  assert.equal(a.kind, 'image');
  assert.equal(describeType('part.stl').kind, 'model');
  assert.equal(describeType('notes.txt').kind, 'other');
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'png-bytes');
  const text = withAttachments('Look at this', [a]);
  assert.match(text, new RegExp(`\\[file ${a.id}\\] shot\\.PNG .*${a.path.replace(/[\\.]/g, '\\$&')}`));
  assert.deepEqual(idsInText(dir, `${text} [file 0123456789abcdef]`), [a.id]);
  assert.equal(fileMeta(dir, '../../etc/passwd'), null);
});

test('agents attach files by absolute path only', () => {
  const dir = tmp();
  const source = path.join(dir, 'model.stl');
  fs.writeFileSync(source, 'solid x\nendsolid x\n');
  const [stored] = storePaths(dir, [source], { by: 'claude' });
  assert.equal(stored.kind, 'model');
  assert.equal(stored.by, 'claude');
  assert.throws(() => storePaths(dir, ['model.stl']), /absolute/);
  assert.throws(() => storePaths(dir, [path.join(dir, 'missing.png')]), /not found/);
  assert.throws(() => storePaths(dir, [dir]), /regular file/);
});

test('a console_post report keeps its attachments, with or without text', () => {
  const dir = tmp();
  const file = storeBuffer(dir, 'render.png', Buffer.from('x'));
  const event = updateState(dir, state => applyAgentPost(state, 'codex', { kind: 'progress' }, [file.id]).event);
  assert.deepEqual(event.attachments, [file.id]);
  assert.equal(event.text, '');
  assert.deepEqual(readState(dir).events.at(-1).attachments, [file.id]);
});

test('the console uploads, serves, and forwards attached files to the agents', async () => {
  const dir = tmp();
  const sent = [];
  const transport = { platform: 'test', async listClaude() { return { sessions: [], warnings: [] }; }, async listCodex() { return { threads: [], warnings: [] }; },
    async send(job) { sent.push(job); return { method: 'test' }; } };
  const app = await startConsole({ port: 0, stateDir: dir, transport, token: 't'.repeat(48), log: () => {}, tickMs: 50, availabilityMs: 60000 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = { 'x-console-token': app.token };
    assert.equal((await fetch(`${base}/console-viewer.js`)).status, 200);
    const denied = await fetch(`${base}/api/upload`, { method: 'POST', body: 'x', headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(denied.status, 401);
    const upload = await fetch(`${base}/api/upload`, { method: 'POST', body: Buffer.from('fake-jpeg'),
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('ảnh chụp.jpg') } });
    const meta = await upload.json();
    assert.equal(meta.name, 'ảnh chụp.jpg');
    assert.equal(meta.kind, 'image');
    assert.equal(meta.path, undefined, 'the page never sees local paths');
    const file = await fetch(`${base}/api/files/${meta.id}`, { headers });
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.equal(await file.text(), 'fake-jpeg');
    assert.equal((await fetch(`${base}/api/files/${meta.id}`)).status, 401);

    app.engine.select('claude', { id: 'claude-session' });
    const { request } = app.engine.submit({ clientId: 'client-0001', message: '', kind: 'chat', attachments: [meta.id] });
    assert.deepEqual(request.attachments, [meta.id]);
    assert.match(request.message, /1 file attached/);
    await app.engine.tick();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].message.includes(fileMeta(dir, meta.id).path), 'the agent receives the local path');
    assert.equal(app.engine.snapshot().files[meta.id].name, 'ảnh chụp.jpg');
    assert.throws(() => app.engine.submit({ clientId: 'client-0002', message: 'x', kind: 'chat', attachments: ['0123456789abcdef'] }), /missing/);
  } finally { await app.close(); }
});

/* ---------- 3D parsers in the page script ---------- */
function viewer() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ui', 'console-viewer.js'), 'utf8'),
    { window, TextDecoder, TextEncoder, DataView, atob, Blob, Response, DecompressionStream });
  return window.BridgeViewer;
}
const ab = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

test('the viewer parses binary and ASCII STL, OBJ, PLY, and GLB into triangles', async () => {
  const { parseModel, defaultUp } = viewer();
  const binary = Buffer.alloc(84 + 50);
  binary.writeUInt32LE(1, 80);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => binary.writeFloatLE(v, 96 + i * 4));
  assert.equal((await parseModel('a.stl', ab(binary))).positions.length, 9);
  const ascii = Buffer.from('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n');
  assert.deepEqual([...(await parseModel('a.stl', ab(ascii))).positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const obj = Buffer.from('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1 2/2 3/3 4/4\n');
  assert.equal((await parseModel('q.obj', ab(obj))).positions.length, 18, 'a quad becomes two triangles');
  const ply = Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 255 0 0\n0 1 0 255 0 0\n3 0 1 2\n');
  const parsedPly = await parseModel('c.ply', ab(ply));
  assert.equal(parsedPly.positions.length, 9);
  assert.equal(parsedPly.colors[0], 1);

  // Minimal GLB: one triangle, node translated by +10 on X.
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [10, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] }));
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  const glb = Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, bin)]);
  glb.writeUInt32LE(glb.length, 8);
  assert.deepEqual([...(await parseModel('m.glb', ab(glb))).positions], [10, 0, 0, 11, 0, 0, 10, 1, 0]);
  assert.equal(defaultUp('m.glb'), 'y');
  assert.equal(defaultUp('m.stl'), 'z');
  await assert.rejects(parseModel('x.step', new ArrayBuffer(4)), /Unsupported/);
});
