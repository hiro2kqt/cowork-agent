// Bridge Console 3D viewer: a small WebGL renderer for STL, OBJ, PLY, GLB/glTF and 3MF files.
// No libraries. Geometry only: every format becomes a triangle soup with optional vertex colours,
// drawn with flat shading, a ground grid, and orbit / pan / zoom controls.
'use strict';
(function () {
  /* ---------- small helpers ---------- */
  const fail = message => { throw new Error(message); };
  const ext = name => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) { // column-major 4x4: a * b
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  const isIdentity = m => m.every((v, i) => v === IDENTITY[i]);

  /** Collects triangles. `add` takes three [x,y,z] points; an optional matrix transforms them. */
  function Soup() {
    let pos = new Float32Array(1 << 16), col = null, n = 0;
    function grow(need) {
      if (need <= pos.length) return;
      let size = pos.length; while (size < need) size *= 2;
      const p = new Float32Array(size); p.set(pos); pos = p;
      if (col) { const c = new Float32Array(size); c.set(col); col = c; }
    }
    return {
      push(x, y, z, color) {
        grow(n + 3);
        pos[n] = x; pos[n + 1] = y; pos[n + 2] = z;
        if (color && !col) { col = new Float32Array(pos.length); col.fill(0.72, 0, n); }
        if (col) { const c = color || [0.72, 0.72, 0.72]; col[n] = c[0]; col[n + 1] = c[1]; col[n + 2] = c[2]; }
        n += 3;
      },
      done() {
        if (!n) fail('The file has no triangles to show.');
        return { positions: pos.subarray(0, n), colors: col ? col.subarray(0, n) : null };
      },
    };
  }
  function pushPoint(soup, m, x, y, z, color) {
    if (!m) return soup.push(x, y, z, color);
    soup.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], color);
  }

  /* ---------- STL ---------- */
  function parseSTL(buffer) {
    const view = new DataView(buffer);
    const soup = Soup();
    if (buffer.byteLength >= 84) {
      const count = view.getUint32(80, true);
      if (84 + count * 50 === buffer.byteLength) {
        for (let i = 0; i < count; i++) {
          const o = 84 + i * 50 + 12;
          for (let v = 0; v < 3; v++) soup.push(view.getFloat32(o + v * 12, true), view.getFloat32(o + v * 12 + 4, true), view.getFloat32(o + v * 12 + 8, true));
        }
        return soup.done();
      }
    }
    const text = new TextDecoder().decode(buffer);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m; while ((m = re.exec(text))) soup.push(+m[1], +m[2], +m[3]);
    return soup.done();
  }

  /* ---------- OBJ ---------- */
  function parseOBJ(buffer) {
    const text = new TextDecoder().decode(buffer);
    const v = [];
    const soup = Soup();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('v ')) { const p = line.split(/\s+/); v.push([+p[1], +p[2], +p[3]]); }
      else if (line.startsWith('f ')) {
        const idx = line.split(/\s+/).slice(1).map(token => { const i = parseInt(token, 10); return i < 0 ? v.length + i : i - 1; });
        for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) {
          const p = v[i] || fail('The OBJ file refers to a missing vertex.');
          soup.push(p[0], p[1], p[2]);
        }
      }
    }
    return soup.done();
  }

  /* ---------- PLY ---------- */
  const PLY_TYPES = { char: ['Int8', 1], int8: ['Int8', 1], uchar: ['Uint8', 1], uint8: ['Uint8', 1], short: ['Int16', 2], int16: ['Int16', 2],
    ushort: ['Uint16', 2], uint16: ['Uint16', 2], int: ['Int32', 4], int32: ['Int32', 4], uint: ['Uint32', 4], uint32: ['Uint32', 4],
    float: ['Float32', 4], float32: ['Float32', 4], double: ['Float64', 8], float64: ['Float64', 8] };
  function parsePLY(buffer) {
    const bytes = new Uint8Array(buffer);
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const end = head.indexOf('end_header');
    if (!head.startsWith('ply') || end < 0) fail('Not a PLY file.');
    // The header is ASCII, so its character offset is also its byte offset.
    let bodyStart = end + 'end_header'.length;
    if (bytes[bodyStart] === 13) bodyStart++;
    if (bytes[bodyStart] === 10) bodyStart++;
    const elements = [];
    let format = 'ascii';
    for (const line of head.slice(0, end).split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'format') format = p[1];
      else if (p[0] === 'element') elements.push({ name: p[1], count: +p[2], props: [] });
      else if (p[0] === 'property' && elements.length) {
        const props = elements[elements.length - 1].props;
        if (p[1] === 'list') props.push({ list: true, countType: p[2], type: p[3], name: p[4] });
        else props.push({ type: p[1], name: p[2] });
      }
    }
    const verts = [], cols = [], faces = [];
    if (format === 'ascii') {
      const tokens = new TextDecoder().decode(bytes.subarray(bodyStart)).trim().split(/\s+/);
      let t = 0;
      for (const el of elements) for (let i = 0; i < el.count; i++) {
        const rec = {};
        for (const prop of el.props) {
          if (prop.list) { const n = +tokens[t++]; rec[prop.name] = tokens.slice(t, t + n).map(Number); t += n; }
          else rec[prop.name] = +tokens[t++];
        }
        collect(el, rec);
      }
    } else {
      const little = format === 'binary_little_endian';
      const view = new DataView(buffer);
      let o = bodyStart;
      const read = type => { const [fn, size] = PLY_TYPES[type] || fail(`Unsupported PLY type ${type}.`); const v = view[`get${fn}`](o, little); o += size; return v; };
      for (const el of elements) for (let i = 0; i < el.count; i++) {
        const rec = {};
        for (const prop of el.props) {
          if (prop.list) { const n = read(prop.countType); const list = new Array(n); for (let k = 0; k < n; k++) list[k] = read(prop.type); rec[prop.name] = list; }
          else rec[prop.name] = read(prop.type);
        }
        collect(el, rec);
      }
    }
    function collect(el, rec) {
      if (el.name === 'vertex') {
        verts.push([rec.x, rec.y, rec.z]);
        if (rec.red !== undefined) cols.push([rec.red / 255, rec.green / 255, rec.blue / 255]);
      } else if (el.name === 'face') faces.push(rec.vertex_indices || rec.vertex_index || []);
    }
    const soup = Soup();
    for (const f of faces) for (let k = 1; k + 1 < f.length; k++) for (const i of [f[0], f[k], f[k + 1]]) {
      const p = verts[i] || fail('The PLY file refers to a missing vertex.');
      soup.push(p[0], p[1], p[2], cols.length ? cols[i] : null);
    }
    return soup.done();
  }

  /* ---------- glTF / GLB ---------- */
  const COMPONENTS = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
  const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  function parseGLTF(buffer, isBinary) {
    let json, bin = null;
    if (isBinary) {
      const view = new DataView(buffer);
      if (view.getUint32(0, true) !== 0x46546c67) fail('Not a GLB file.');
      let o = 12;
      while (o + 8 <= buffer.byteLength) {
        const length = view.getUint32(o, true), type = view.getUint32(o + 4, true);
        if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, o + 8, length)));
        else if (type === 0x004e4942) bin = buffer.slice(o + 8, o + 8 + length);
        o += 8 + length;
      }
    } else json = JSON.parse(new TextDecoder().decode(buffer));
    if (!json) fail('The glTF file has no JSON part.');
    const used = [...(json.extensionsRequired || [])];
    if (used.length) fail(`This model needs ${used.join(', ')}, which the console viewer does not support. Export it without compression.`);
    const buffers = (json.buffers || []).map((b, i) => {
      if (b.uri === undefined) return i === 0 && bin ? bin : fail('The glTF buffer is missing.');
      const m = /^data:[^,]*;base64,(.*)$/.exec(b.uri);
      if (!m) fail('This .gltf uses separate .bin files. Export it as a single .glb instead.');
      const raw = atob(m[1]); const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out.buffer;
    });
    function accessor(index) {
      const a = json.accessors[index];
      const [Type, size] = COMPONENTS[a.componentType] || fail('Unsupported glTF component type.');
      const width = WIDTH[a.type];
      const out = new Float64Array(a.count * width);
      if (a.bufferView === undefined) return out;
      const bv = json.bufferViews[a.bufferView];
      const view = new DataView(buffers[bv.buffer]);
      const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
      const stride = bv.byteStride || size * width;
      const getter = `get${Type.name.replace('Array', '')}`;
      for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = view[getter](base + i * stride + k * size, true);
      return out;
    }
    function local(node) {
      if (node.matrix) return node.matrix.slice();
      const [tx, ty, tz] = node.translation || [0, 0, 0];
      const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
      const [sx, sy, sz] = node.scale || [1, 1, 1];
      return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
        2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
        2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
        tx, ty, tz, 1];
    }
    const soup = Soup();
    function drawMesh(mesh, m) {
      for (const prim of mesh.primitives || []) {
        const mode = prim.mode ?? 4;
        if (![4, 5, 6].includes(mode) || prim.attributes?.POSITION === undefined) continue;
        const pos = accessor(prim.attributes.POSITION);
        const count = pos.length / 3;
        const idx = prim.indices !== undefined ? accessor(prim.indices) : Array.from({ length: count }, (_, i) => i);
        const factor = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor;
        const color = factor ? [factor[0], factor[1], factor[2]] : null;
        const tri = [];
        if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) tri.push(idx[i], idx[i + 1], idx[i + 2]);
        else if (mode === 5) for (let i = 0; i + 2 < idx.length; i++) tri.push(...(i % 2 ? [idx[i + 1], idx[i], idx[i + 2]] : [idx[i], idx[i + 1], idx[i + 2]]));
        else for (let i = 1; i + 1 < idx.length; i++) tri.push(idx[0], idx[i], idx[i + 1]);
        for (const i of tri) pushPoint(soup, m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], color);
      }
    }
    function visit(index, parent, depth) {
      if (depth > 64) return;
      const node = json.nodes[index];
      const m = mul(parent, local(node));
      if (node.mesh !== undefined) drawMesh(json.meshes[node.mesh], isIdentity(m) ? null : m);
      for (const child of node.children || []) visit(child, m, depth + 1);
    }
    const scene = json.scenes?.[json.scene ?? 0];
    if (scene) for (const n of scene.nodes || []) visit(n, IDENTITY, 0);
    else for (const mesh of json.meshes || []) drawMesh(mesh, null);
    return soup.done();
  }

  /* ---------- 3MF (a ZIP of XML) ---------- */
  async function unzip(buffer) {
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) fail('Not a 3MF (ZIP) file.');
    const entries = new Map();
    let o = view.getUint32(eocd + 16, true);
    const total = view.getUint16(eocd + 10, true);
    for (let n = 0; n < total; n++) {
      if (view.getUint32(o, true) !== 0x02014b50) break;
      const method = view.getUint16(o + 10, true), compressed = view.getUint32(o + 20, true);
      const nameLength = view.getUint16(o + 28, true), extra = view.getUint16(o + 30, true), comment = view.getUint16(o + 32, true);
      const localOffset = view.getUint32(o + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buffer, o + 46, nameLength));
      entries.set(name.replace(/^\/+/, ''), { method, compressed, localOffset });
      o += 46 + nameLength + extra + comment;
    }
    return {
      names: [...entries.keys()],
      async text(name) {
        const e = entries.get(name.replace(/^\/+/, ''));
        if (!e) return null;
        const start = e.localOffset + 30 + view.getUint16(e.localOffset + 26, true) + view.getUint16(e.localOffset + 28, true);
        const data = new Uint8Array(buffer, start, e.compressed);
        if (e.method === 0) return new TextDecoder().decode(data);
        if (e.method !== 8) fail('Unsupported compression in the 3MF file.');
        if (typeof DecompressionStream === 'undefined') fail('This browser cannot open 3MF files. Use STL or GLB.');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).text();
      },
    };
  }
  async function parse3MF(buffer) {
    const zip = await unzip(buffer);
    const files = new Map();
    for (const name of zip.names.filter(n => /\.model$/i.test(n))) files.set(`/${name}`, new DOMParser().parseFromString(await zip.text(name), 'application/xml'));
    if (!files.size) fail('The 3MF file has no model.');
    const root = files.has('/3D/3dmodel.model') ? '/3D/3dmodel.model' : [...files.keys()][0];
    const all = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
    const pathOf = el => [...el.attributes].find(a => a.localName === 'path')?.value;
    const transform = value => {
      if (!value) return IDENTITY;
      const t = value.trim().split(/\s+/).map(Number);
      return [t[0], t[1], t[2], 0, t[3], t[4], t[5], 0, t[6], t[7], t[8], 0, t[9], t[10], t[11], 1];
    };
    const soup = Soup();
    function object(file, id, m, depth) {
      const doc = files.get(file);
      if (!doc || depth > 32) return;
      const obj = all(doc, 'object').find(o => o.getAttribute('id') === id);
      if (!obj) return;
      const mesh = all(obj, 'mesh')[0];
      if (mesh) {
        const v = all(mesh, 'vertex').map(x => [+x.getAttribute('x'), +x.getAttribute('y'), +x.getAttribute('z')]);
        const mm = isIdentity(m) ? null : m;
        for (const t of all(mesh, 'triangle')) for (const k of ['v1', 'v2', 'v3']) {
          const p = v[+t.getAttribute(k)]; if (p) pushPoint(soup, mm, p[0], p[1], p[2]);
        }
      }
      for (const c of all(obj, 'component')) object(pathOf(c) || file, c.getAttribute('objectid'), mul(m, transform(c.getAttribute('transform'))), depth + 1);
    }
    const items = all(files.get(root), 'item');
    for (const item of items) object(pathOf(item) || root, item.getAttribute('objectid'), transform(item.getAttribute('transform')), 0);
    return soup.done();
  }

  async function parseModel(name, buffer) {
    switch (ext(name)) {
      case 'stl': return parseSTL(buffer);
      case 'obj': return parseOBJ(buffer);
      case 'ply': return parsePLY(buffer);
      case 'glb': return parseGLTF(buffer, true);
      case 'gltf': return parseGLTF(buffer, false);
      case '3mf': return parse3MF(buffer);
      default: fail('Unsupported 3D format.');
    }
  }

  /* ---------- renderer ---------- */
  const VS = `attribute vec3 aPos;attribute vec3 aNormal;attribute vec3 aColor;
uniform mat4 uProj;uniform mat4 uView;varying vec3 vNormal;varying vec3 vColor;
void main(){vNormal=mat3(uView)*aNormal;vColor=aColor;gl_Position=uProj*uView*vec4(aPos,1.0);}`;
  const FS = `precision mediump float;varying vec3 vNormal;varying vec3 vColor;uniform float uUnlit;
void main(){vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;
float key=max(dot(n,normalize(vec3(0.35,0.55,0.75))),0.0);float fill=max(dot(n,normalize(vec3(-0.6,-0.2,0.4))),0.0);
float light=0.32+0.62*key+0.18*fill;gl_FragColor=vec4(mix(vColor*light,vColor,uUnlit),1.0);}`;

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(eye, target, up) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }

  function flatNormals(p) {
    const n = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 9) {
      const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
      const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
      let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
      const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
      for (let k = 0; k < 9; k += 3) { n[i + k] = x; n[i + k + 1] = y; n[i + k + 2] = z; }
    }
    return n;
  }

  /** Show a parsed model in `container`. Returns { destroy, info, setUp }. */
  function mountModel(container, model, { upAxis = 'z', dark = false } = {}) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab';
    container.append(canvas);
    const gl = canvas.getContext('webgl', { antialias: true }) || fail('WebGL is not available in this browser.');
    const uint = gl.getExtension('OES_element_index_uint'); void uint;
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) fail(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    gl.useProgram(prog);
    const loc = { pos: gl.getAttribLocation(prog, 'aPos'), normal: gl.getAttribLocation(prog, 'aNormal'), color: gl.getAttribLocation(prog, 'aColor'),
      proj: gl.getUniformLocation(prog, 'uProj'), view: gl.getUniformLocation(prog, 'uView'), unlit: gl.getUniformLocation(prog, 'uUnlit') };

    const p = model.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const radius = Math.max(Math.hypot(...size) / 2, 1e-6);
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const base = dark ? [0.62, 0.68, 0.84] : [0.55, 0.62, 0.8];
    let colors = model.colors;
    if (!colors) { colors = new Float32Array(p.length); for (let i = 0; i < p.length; i += 3) colors.set(base, i); }
    const buffer = data => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const mesh = { pos: buffer(p), normal: buffer(flatNormals(p)), color: buffer(colors), count: p.length / 3 };
    let grid = null;
    function buildGrid() {
      // A grid under the model, on the plane perpendicular to the up axis.
      const up = upAxis === 'z' ? 2 : 1, a = 0, b = up === 2 ? 1 : 2;
      const span = Math.max(size[a], size[b]) * 1.6 || 1;
      const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
      const lines = Math.ceil(span / step / 2);
      const pts = [], col = [];
      const shade = dark ? [0.3, 0.3, 0.3] : [0.8, 0.8, 0.78];
      for (let i = -lines; i <= lines; i++) for (const [u, v] of [[[i * step, -lines * step], [i * step, lines * step]], [[-lines * step, i * step], [lines * step, i * step]]]) {
        for (const q of [u, v]) {
          const pt = [0, 0, 0]; pt[a] = center[a] + q[0]; pt[b] = center[b] + q[1]; pt[up] = min[up];
          pts.push(...pt); col.push(...shade);
        }
      }
      if (grid) { gl.deleteBuffer(grid.pos); gl.deleteBuffer(grid.normal); gl.deleteBuffer(grid.color); }
      grid = { pos: buffer(new Float32Array(pts)), normal: buffer(new Float32Array(pts.length)), color: buffer(new Float32Array(col)), count: pts.length / 3 };
    }
    buildGrid();

    let yaw, pitch, dist, target;
    function reset() { yaw = -0.7; pitch = 0.45; dist = radius * 2.6; target = center.slice(); }
    reset();
    function eye() {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const o = upAxis === 'z' ? [cp * Math.cos(yaw), cp * Math.sin(yaw), sp] : [cp * Math.sin(yaw), sp, cp * Math.cos(yaw)];
      return [target[0] + o[0] * dist, target[1] + o[1] * dist, target[2] + o[2] * dist];
    }
    const upVector = () => (upAxis === 'z' ? [0, 0, 1] : [0, 1, 0]);

    let frame = 0;
    function draw() {
      frame = 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      const bg = dark ? [0.11, 0.11, 0.105] : [0.97, 0.97, 0.96];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.uniformMatrix4fv(loc.proj, false, perspective(0.75, w / h, dist / 200, dist + radius * 20));
      gl.uniformMatrix4fv(loc.view, false, lookAt(eye(), target, upVector()));
      for (const [item, mode, unlit] of [[grid, gl.LINES, 1], [mesh, gl.TRIANGLES, 0]]) {
        gl.uniform1f(loc.unlit, unlit);
        for (const [b, l] of [[item.pos, loc.pos], [item.normal, loc.normal], [item.color, loc.color]]) {
          gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 0, 0);
        }
        gl.drawArrays(mode, 0, item.count);
      }
    }
    const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

    // Left drag orbits; right drag or Shift+drag pans; the wheel zooms; double-click resets.
    let drag = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
    canvas.addEventListener('pointerup', () => { drag = null; canvas.style.cursor = 'grab'; });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const v = lookAt(eye(), target, upVector());
        const scale = dist / canvas.clientHeight;
        for (let k = 0; k < 3; k++) target[k] += (-dx * v[k * 4] + dy * v[k * 4 + 1]) * scale;
      } else {
        yaw -= dx * 0.008;
        pitch = Math.max(-1.55, Math.min(1.55, pitch + dy * 0.008));
      }
      redraw();
    });
    canvas.addEventListener('wheel', e => { e.preventDefault(); dist = Math.max(radius * 0.05, Math.min(radius * 40, dist * Math.exp(e.deltaY * 0.0012))); redraw(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { reset(); redraw(); });
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    redraw();
    return {
      info: { triangles: mesh.count / 3, size },
      setUp(axis) { upAxis = axis; buildGrid(); reset(); redraw(); },
      destroy() { observer.disconnect(); if (frame) cancelAnimationFrame(frame); gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); },
    };
  }

  window.BridgeViewer = { parseModel, mountModel, defaultUp: name => (['glb', 'gltf', 'obj'].includes(ext(name)) ? 'y' : 'z') };
})();
