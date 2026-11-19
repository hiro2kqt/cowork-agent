// Shared attachments for the Bridge Console: images, 3D models, and other result files.
//
// Files are copied into <state dir>/console/files/ under a content hash, so the user, the console
// and both agents (which run on the same machine and share the state directory) refer to one
// immutable copy. A message mentions a file with a "[file <id>]" marker followed by the copy's
// absolute path: the receiving agent opens the path, and the console shows the file from the marker.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { consoleDir } from './console-state.mjs';

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 12;
const ID = /^[a-f0-9]{16}$/;
const MARKER = /\[file ([a-f0-9]{16})\]/g;

const TYPES = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'], '.bmp': ['image', 'image/bmp'], '.svg': ['image', 'image/svg+xml'], '.avif': ['image', 'image/avif'],
  '.stl': ['model', 'model/stl'], '.obj': ['model', 'model/obj'], '.glb': ['model', 'model/gltf-binary'], '.gltf': ['model', 'model/gltf+json'],
  '.3mf': ['model', 'model/3mf'], '.ply': ['model', 'model/ply'],
};

export function filesDir(stateDir) { return path.join(consoleDir(stateDir), 'files'); }

export function describeType(name) {
  const ext = path.extname(String(name)).toLowerCase();
  const [kind, mime] = TYPES[ext] || ['other', 'application/octet-stream'];
  return { ext: /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '', kind, mime };
}

const cache = new Map();

/** Metadata of a stored file, or null. Stored metadata never changes, so it is cached. */
export function fileMeta(stateDir, id) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const key = `${path.resolve(stateDir)}\0${id}`;
  if (cache.has(key)) return cache.get(key);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(filesDir(stateDir), `${id}.json`), 'utf8'));
    meta.path = path.join(filesDir(stateDir), `${id}${meta.ext}`);
    cache.set(key, meta);
  } catch {}
  return meta;
}

/** Store bytes under their hash. Returns the metadata, including the stored copy's absolute path. */
export function storeBuffer(stateDir, name, buffer, { by = 'user' } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('File content must be bytes.');
  if (!buffer.length) throw new Error(`${name} is empty.`);
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`${name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const base = path.basename(String(name || 'file').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
  const { ext, kind, mime } = describeType(base);
  const id = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const existing = fileMeta(stateDir, id);
  if (existing) return existing;
  const dir = filesDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}${ext}`);
  writeOnce(target, buffer);
  const meta = { id, name: base, ext, kind, mime, size: buffer.length, by, createdAt: Date.now() };
  writeOnce(path.join(dir, `${id}.json`), JSON.stringify(meta));
  return fileMeta(stateDir, id) || { ...meta, path: target };
}

function writeOnce(file, data) {
  if (fs.existsSync(file)) return;
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (error) { if (!fs.existsSync(file)) throw error; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** Copy files an agent names by absolute path into the shared store. */
export function storePaths(stateDir, paths, { by } = {}) {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > MAX_FILES_PER_MESSAGE) throw new Error(`files must be a list of at most ${MAX_FILES_PER_MESSAGE} paths.`);
  return paths.map(given => {
    if (typeof given !== 'string' || !path.isAbsolute(given)) throw new Error(`File paths must be absolute: ${given}`);
    let stat;
    try { stat = fs.statSync(given); } catch { throw new Error(`File not found: ${given}`); }
    if (!stat.isFile()) throw new Error(`Not a regular file: ${given}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${given} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    return storeBuffer(stateDir, path.basename(given), fs.readFileSync(given), { by });
  });
}

const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Lines that tell a reader which files come with a message and where to open them. */
export function attachmentLines(files, heading = 'Attached files (local copies; open the path to view or use them):') {
  if (!files.length) return [];
  return [heading, ...files.map(file => `- [file ${file.id}] ${file.name} (${file.kind}, ${size(file.size)}): ${file.path}`)];
}

export function withAttachments(message, files) {
  return files.length ? `${message}\n\n${attachmentLines(files).join('\n')}` : message;
}

/** IDs of stored files a text mentions with a marker, in order and without repeats. */
export function idsInText(stateDir, value) {
  const ids = [...new Set([...String(value || '').matchAll(MARKER)].map(match => match[1]))];
  return ids.filter(id => fileMeta(stateDir, id));
}

/** IDs the user attached in the console; each must already be stored. */
export function checkIds(stateDir, ids) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > MAX_FILES_PER_MESSAGE) throw new Error(`Attach at most ${MAX_FILES_PER_MESSAGE} files.`);
  const unique = [...new Set(ids)];
  for (const id of unique) if (!fileMeta(stateDir, id)) throw new Error('An attached file is missing. Attach it again.');
  return unique;
}

/** Public metadata (without the absolute path) for the console page. */
export function publicMeta(meta) {
  if (!meta) return null;
  const { path: _path, ...rest } = meta;
  return rest;
}
