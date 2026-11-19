#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultStateDir, withStateLock } from '../lib/store.mjs';
import { defaultStatePath } from '../lib/state-directory.mjs';
import { legacyEnvironmentWarnings } from '../lib/legacy-environment.mjs';
import { validateSshHostAlias } from '../lib/codex-ssh.mjs';
import { codexHome } from '../lib/codex-settings.mjs';
import { resolveCodexExecutable } from '../lib/codex-binary.mjs';
import { PLUGIN_NAME, COMMON_RUNTIME_FILES, NATIVE_RUNTIME_FILES, checkManifests, compatibilityFiles } from './manifests.mjs';

export { PLUGIN_NAME };
export const CLAUDE_MARKETPLACE = 'claude-codex-local';
const LEGACY_PLUGIN = 'codex-claude-desktop-bridge';
const LEGACY_LOCAL = 'codex-claude-desktop-local';
const LEGACY_MARKETPLACE = 'keeveeg-desktop-bridge';
const LEGACY_PREFIX = `mcp__plugin_${LEGACY_PLUGIN}_${LEGACY_PLUGIN}`;
const TOOL_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}`;

function checkEnvironment(env) {
  const warnings = legacyEnvironmentWarnings(env);
  if (warnings.length) throw new Error(warnings.join('\n'));
}
// Claude scopes plugin MCP tools by plugin name and server name. Marketplace
// names and cache versions are not part of this permission identifier.
export const CLAUDE_SEND_PERMISSION = `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}__send_to_codex`;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = NATIVE_RUNTIME_FILES;
export { runtimeFiles as RUNTIME_FILES };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const timestamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '');
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

// Windows scanners and sync clients can briefly hold handles to freshly copied
// plugin files. Keep each move atomic and retry the same source/destination;
// never restage files or repeat application installation after sharing errors.
function renameDirectoryWithRetry(source, destination) {
  const until = Date.now() + 1000;
  for (;;) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      const remaining = until - Date.now();
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
      Atomics.wait(sleepBuffer, 0, 0, Math.min(25, remaining));
    }
  }
}

function readRawIfPresent(filename) {
  try { return fs.readFileSync(filename, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

function optionalJson(filename) {
  try { return readJson(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read valid JSON from ${filename}: ${error.message}`);
  }
}

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Only completed backups with the timestamp and UUID format emitted above qualify.
const backupSuffix = /^[0-9]{17}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function pruneBackups(homeDir, parts, prefix, latest, directories) {
  let directory = path.resolve(homeDir);
  for (const part of ['', ...parts]) {
    directory = path.join(directory, part);
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  }
  const backups = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.name.startsWith(prefix) && backupSuffix.test(entry.name.slice(prefix.length)) &&
      !entry.isSymbolicLink() && (directories ? entry.isDirectory() : entry.isFile()))
    .map(entry => path.join(directory, entry.name)).sort().reverse();
  const keep = backups.includes(latest) ? latest : backups[0];
  for (const filename of backups) {
    if (filename === keep) continue;
    if (!contained(directory, filename)) throw new Error('Invalid installer backup path.');
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !(directories ? stat.isDirectory() : stat.isFile())) continue;
    // Recursive removal unlinks nested links without traversing their targets.
    fs.rmSync(filename, { recursive: directories });
  }
}

function pruneInstallationBackups(prepared, homeDir) {
  pruneBackups(homeDir, ['plugins'], `.${PLUGIN_NAME}.backup-`, prepared.backupDirectory, true);
  pruneBackups(homeDir, ['.agents', 'plugins'], 'marketplace.json.backup-', prepared.marketplaceBackup, false);
}

function refuseLink(filename) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`Refusing to replace a symbolic link: ${filename}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeNewFile(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content, { flag: 'wx' });
}

/** Preserve the prior JSON as a sibling backup, then atomically replace its contents. */
export function writeJsonAtomic(filename, value, options) {
  return writeTextAtomic(filename, jsonText(value), options);
}

function writeTextAtomic(filename, next, { expectedPrevious, label = 'marketplace' } = {}) {
  refuseLink(filename);
  const previous = readRawIfPresent(filename);
  if (expectedPrevious !== undefined && previous !== expectedPrevious) {
    throw new Error(`The ${label} changed during installation. No replacement was made; retry from the updated file.`);
  }
  if (previous === next) return null;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const suffix = `${timestamp()}-${randomUUID()}`;
  const temporary = `${filename}.tmp-${suffix}`;
  const backup = previous === null ? null : `${filename}.backup-${suffix}`;
  try {
    writeNewFile(temporary, next);
    if (backup) {
      const backupTemporary = `${backup}.tmp`;
      writeNewFile(backupTemporary, previous);
      fs.renameSync(backupTemporary, backup);
    }
    if (readRawIfPresent(filename) !== previous) {
      throw new Error(`The ${label} changed before replacement. The newer file was preserved; retry installation.`);
    }
    if (previous === null) {
      // Same-directory hard linking creates a complete new file without overwriting
      // a catalog concurrently created by a writer that does not use our lock.
      fs.linkSync(temporary, filename);
    } else {
      fs.renameSync(temporary, filename);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return backup;
}

function permissionRuleMatches(rule, toolName) {
  if (typeof rule !== 'string' || rule.includes('(')) return false;
  if (rule === toolName || toolName.startsWith(`${rule}__`)) return true;
  if (!rule.includes('*')) return false;
  const pattern = rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`).test(toolName);
}

/** Explicit, narrow user-level grant for Claude's outbound bridge tool. */
export function grantClaudeSendPermission({ homeDir = os.homedir(), env = process.env } = {}) {
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'));
  const settingsPath = path.join(configDir, 'settings.json');
  const lockDirectory = path.join(configDir, `.${PLUGIN_NAME}-permissions-lock`);
  return withStateLock(lockDirectory, () => {
    const previous = readRawIfPresent(settingsPath);
    let settings;
    try { settings = previous === null ? {} : JSON.parse(previous.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Claude settings.json is not valid JSON. No permission was added.'); }
    if (!object(settings) || (settings.permissions !== undefined && !object(settings.permissions))) {
      throw new Error('Claude settings.json must contain an object with optional object permissions. No permission was added.');
    }
    const permissions = settings.permissions || {};
    for (const field of ['allow', 'ask', 'deny']) {
      if (permissions[field] !== undefined && (!Array.isArray(permissions[field]) ||
          permissions[field].some(rule => typeof rule !== 'string'))) {
        throw new Error(`Claude permissions.${field} must be an array of strings. No permission was added.`);
      }
    }
    for (const field of ['deny', 'ask']) {
      if (permissions[field]?.some(rule => permissionRuleMatches(rule, CLAUDE_SEND_PERMISSION))) {
        throw new Error(`Claude permissions.${field} already matches the outbound bridge tool. Resolve that rule in Claude before granting access.`);
      }
    }
    if (permissions.allow?.includes(CLAUDE_SEND_PERMISSION)) {
      return { settingsPath, rule: CLAUDE_SEND_PERMISSION, added: false, backup: null };
    }
    settings.permissions = { ...permissions, allow: [...(permissions.allow || []), CLAUDE_SEND_PERMISSION] };
    const backup = writeJsonAtomic(settingsPath, settings, { expectedPrevious: previous, label: 'Claude settings' });
    return { settingsPath, rule: CLAUDE_SEND_PERMISSION, added: true, backup };
  });
}

/** Migrate user choices before applying the normal narrow send grant. */
function migrateClaudeSettings({ homeDir, env, log }) {
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'));
  const filename = path.join(configDir, 'settings.json');
  if (!fs.existsSync(filename)) return;
  withStateLock(path.join(configDir, `.${PLUGIN_NAME}-permissions-lock`), () => {
    const previous = readRawIfPresent(filename);
    const settings = JSON.parse(previous.replace(/^\uFEFF/, ''));
    if (!object(settings)) throw new Error('Claude settings.json must contain an object. No migration was made.');
    let changed = false;
    for (const field of ['allow', 'ask', 'deny']) {
      const rules = settings.permissions?.[field];
      if (!Array.isArray(rules)) continue;
      settings.permissions[field] = rules.map(rule => {
        if (typeof rule !== 'string' || !rule.startsWith(LEGACY_PREFIX)) return rule;
        changed = true;
        return TOOL_PREFIX + rule.slice(LEGACY_PREFIX.length);
      });
    }
    if (object(settings.enabledPlugins)) {
      for (const id of Object.keys(settings.enabledPlugins)) {
        if (id === LEGACY_PLUGIN || id.startsWith(`${LEGACY_PLUGIN}@`)) {
          delete settings.enabledPlugins[id]; changed = true;
        }
      }
    }
    if (!changed) return;
    const backup = writeJsonAtomic(filename, settings, { expectedPrevious: previous, label: 'Claude settings' });
    log(`Migrated Claude bridge permission rules and enabled-plugin entries in ${filename}`);
    if (backup) log(`Previous Claude settings backup: ${backup}`);
  });
}

const isLegacyPlugin = id => typeof id === 'string' && (id === LEGACY_PLUGIN || id.startsWith(`${LEGACY_PLUGIN}@`));

const codexConfigPath = ({ homeDir, env }) => path.join(codexHome({ env, homeDir }), 'config.toml');

/** The `[plugins.<id>]` or `[marketplaces.<name>]` table a Codex configuration line opens. */
function codexTable(line) {
  const match = line.trim().match(/^\[(plugins|marketplaces)\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\]\s*(?:#.*)?$/);
  return match && { kind: match[1], name: match[2] ?? match[3] ?? match[4] };
}

/** Plugin IDs and marketplace names recorded as tables in Codex's own configuration. */
function codexConfigTables({ homeDir, env }) {
  const tables = { plugins: [], marketplaces: [] };
  for (const line of (readRawIfPresent(codexConfigPath({ homeDir, env })) ?? '').split(/\r?\n/)) {
    const table = codexTable(line);
    if (table) tables[table.kind].push(table.name);
  }
  return tables;
}

/** Set `enabled = false` in one plugin's Codex table, keeping the previous file as a backup. */
function disableCodexPlugin({ homeDir, env, id }) {
  const filename = codexConfigPath({ homeDir, env });
  const previous = readRawIfPresent(filename) ?? '';
  const lines = previous.split(/(?<=\n)/);
  const start = lines.findIndex(line => { const table = codexTable(line); return table?.kind === 'plugins' && table.name === id; });
  if (start < 0) return null;
  const eol = previous.includes('\r\n') ? '\r\n' : '\n';
  if (!lines[start].endsWith('\n')) lines[start] += eol;
  let end = lines.findIndex((line, index) => index > start && line.trimStart().startsWith('['));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((line, index) => index > start && index < end && /^\s*enabled\s*=/.test(line));
  if (at < 0) lines.splice(start + 1, 0, `enabled = false${eol}`);
  else lines[at] = `enabled = false${lines[at].match(/\r?\n$/)?.[0] ?? ''}`;
  return writeTextAtomic(filename, lines.join(''), { expectedPrevious: previous, label: 'Codex configuration' });
}

/** Whether a catalog outside this run may still install from the old staged files; unreadable counts as yes. */
function catalogListsLegacy(filename, lists) {
  try { return Boolean(lists(readJson(filename))); } catch (error) { return error.code !== 'ENOENT'; }
}

/** Remove released legacy registrations through supported non-interactive CLIs only. */
export function migrateLegacyInstallation({ homeDir = os.homedir(), env = process.env,
  execute = run, log = console.log, claude = true, codex = true } = {}) {
  checkEnvironment(env);
  // Find everything before removing anything, so a missing CLI or a failed listing leaves the earlier installation intact.
  for (const app of ['claude', 'codex']) if (app === 'claude' ? claude : codex) execute(app, ['--version']);
  const removals = [];
  const marketplace = (app, name) => ({ app, args: ['plugin', 'marketplace', 'remove', name, '--json'], done: `Removed ${app} marketplace ${name}` });
  if (claude) {
    for (const entry of readList(execute('claude', ['plugin', 'list', '--json']), 'plugins')) {
      const selector = entry.id || (entry.name?.includes('@') || !entry.marketplace ? entry.name : `${entry.name}@${entry.marketplace}`);
      if (!isLegacyPlugin(selector)) continue;
      const scope = entry.scope || 'user';
      removals.push({ app: 'claude', args: ['plugin', 'uninstall', selector, '--scope', scope, '--json'],
        options: entry.projectPath ? { cwd: entry.projectPath } : undefined, done: `Removed claude plugin ${selector} (${scope})` });
    }
    for (const entry of readList(execute('claude', ['plugin', 'marketplace', 'list', '--json']), 'marketplaces')) {
      if (entry.name === LEGACY_MARKETPLACE || entry.name === LEGACY_LOCAL) removals.push(marketplace('claude', entry.name));
    }
  }
  if (codex) {
    // Codex refuses to list plugins while any configured marketplace is unreadable, even an
    // unrelated one, but still adds and removes them. Its configuration records both.
    const tables = codexConfigTables({ homeDir, env });
    for (const id of tables.plugins.filter(isLegacyPlugin)) {
      removals.push({ app: 'codex', args: ['plugin', 'remove', id, '--json'], done: `Removed codex plugin ${id}`,
        // A running Codex keeps the old plugin's files open, so Codex cannot delete them yet.
        // Turned off, the plugin no longer starts, and the next installer run removes it.
        fallback(error) {
          const backup = disableCodexPlugin({ homeDir, env, id });
          log(`Turned off codex plugin ${id}: Codex could not remove it now (${error.message.trim().split('\n').at(-1).trim()}). After restarting Codex, run the installer again to remove it.`);
          if (backup) log(`Previous Codex configuration backup: ${backup}`);
        } });
    }
    if (tables.marketplaces.includes(LEGACY_MARKETPLACE)) removals.push(marketplace('codex', LEGACY_MARKETPLACE));
  }
  for (const { app, args, options, done, fallback } of removals) {
    try { execute(app, args, options); log(done); } catch (error) {
      if (!fallback) throw error;
      fallback(error);
    }
  }
  if (claude) migrateClaudeSettings({ homeDir, env, log });
  const pluginsDir = path.resolve(homeDir, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    refuseLink(pluginsDir);
    // An application outside this run keeps installing from the old staged files until its own migration.
    const pending = (!codex && catalogListsLegacy(path.resolve(homeDir, '.agents', 'plugins', 'marketplace.json'),
      catalog => catalog.plugins?.some?.(entry => entry?.name === LEGACY_PLUGIN)) && 'Codex')
      || (!claude && catalogListsLegacy(path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'plugins', 'known_marketplaces.json'),
        registry => registry?.[LEGACY_LOCAL]) && 'Claude');
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (entry.name !== LEGACY_PLUGIN && !entry.name.startsWith(`.${LEGACY_PLUGIN}.backup-`)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const filename = path.join(pluginsDir, entry.name);
      if (entry.name === LEGACY_PLUGIN && pending) {
        log(`Kept old staged bridge files for ${pending}: ${filename}. Run the installer for ${pending} to finish the update.`);
        continue;
      }
      // A still-running application can hold the old files open. They are no longer
      // registered anywhere, so a failed removal must not stop the new installation.
      try {
        fs.rmSync(filename, { recursive: true, maxRetries: 3 });
        log(`Removed old staged bridge files: ${filename}`);
      } catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
        log(`Could not remove old staged bridge files now (${error.code}); delete ${filename} after restarting the applications.`);
      }
    }
  }
  return defaultStateDir({ homeDir, env, log });
}

function codexMarketplacePlan(filename, content = readRawIfPresent(filename)) {
  const marketplace = (content === null ? null : JSON.parse(content.replace(/^\uFEFF/, ''))) ?? {
    name: 'personal', interface: { displayName: 'Personal' }, plugins: [],
  };
  if (!object(marketplace) || typeof marketplace.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(marketplace.name) || !Array.isArray(marketplace.plugins)) {
    throw new Error('The existing personal marketplace must have a valid name and plugins array.');
  }
  marketplace.plugins = marketplace.plugins.filter(entry => entry?.name !== LEGACY_PLUGIN);
  const matches = marketplace.plugins.filter(entry => entry?.name === PLUGIN_NAME);
  if (matches.length > 1) throw new Error('The personal marketplace contains duplicate entries for this plugin.');
  const source = { source: 'local', path: `./plugins/${PLUGIN_NAME}` };
  if (matches.length) {
    if (matches[0].source?.source !== source.source || matches[0].source?.path !== source.path) {
      throw new Error('The personal marketplace already has this plugin name with a different source. Resolve the conflict before installing.');
    }
    // Preserve existing policy choices, metadata, order, and unrelated entries.
    matches[0].policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL', ...(matches[0].policy ?? {}) };
    matches[0].category ??= 'Productivity';
  } else {
    marketplace.plugins.push({ name: PLUGIN_NAME, source,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
  }
  return marketplace;
}

function checkedSource(root, relative) {
  const filename = path.join(root, relative);
  if (!contained(root, filename) || !contained(root, fs.realpathSync(filename)) || !fs.lstatSync(filename).isFile()) {
    throw new Error(`Runtime file must be a regular file inside the source tree: ${relative}`);
  }
  return filename;
}

/** Prepare local files only. This function never runs an application command. */
export function prepareInstallation({ sourceRoot = projectRoot, homeDir = os.homedir(), env = process.env, codex = true, claude = true, log = console.log } = {}) {
  checkEnvironment(env);
  if (!codex && !claude) throw new Error('Select Claude, Codex, or both.');
  const root = fs.realpathSync(sourceRoot);
  const bundle = checkManifests(root, { checkNative: false });
  const sshAlias = env.CLAUDE_CODEX_BRIDGE_SSH_HOST === undefined ? undefined
    : validateSshHostAlias(env.CLAUDE_CODEX_BRIDGE_SSH_HOST);
  const pluginsDir = path.resolve(homeDir, 'plugins');
  const destination = path.join(pluginsDir, PLUGIN_NAME);
  const stateDir = path.resolve(defaultStateDir({ homeDir, env, log }));
  const marketplacePath = path.resolve(homeDir, '.agents', 'plugins', 'marketplace.json');
  let marketplace = codex ? codexMarketplacePlan(marketplacePath) : null;
  const publisherName = bundle.manifest.author?.name;
  if (typeof publisherName !== 'string' || !publisherName.trim()) {
    throw new Error('The Claude plugin manifest must declare the actual publisher name before installation.');
  }
  const portableMcp = structuredClone(bundle.mcp);
  const portableServer = portableMcp.mcpServers[PLUGIN_NAME];
  // Preserve the shared home-profile state despite application-specific MSIX
  // environments. Regenerate both native adapters from this pinned source.
  portableServer.env = { ...(portableServer.env ?? {}), CLAUDE_CODEX_BRIDGE_STATE_DIR: path.resolve(env.CLAUDE_CODEX_BRIDGE_STATE_DIR || defaultStatePath(homeDir)) };
  if (sshAlias !== undefined) portableServer.env.CLAUDE_CODEX_BRIDGE_SSH_HOST = sshAlias;
  const sources = COMMON_RUNTIME_FILES.map(relative => ({ relative, filename: checkedSource(root, relative) }));
  refuseLink(pluginsDir);
  refuseLink(destination);
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (!contained(pluginsDir, destination) || path.resolve(destination) === path.resolve(root)) {
    throw new Error('The staging destination must be separate from the source repository.');
  }
  if (fs.existsSync(destination)) {
    const existing = optionalJson(path.join(destination, '.codex-plugin', 'plugin.json'));
    if (!existing || existing.name !== PLUGIN_NAME) throw new Error('The staging destination belongs to another directory or plugin.');
  }
  const build = timestamp();
  const temporary = path.join(pluginsDir, `.${PLUGIN_NAME}.stage-${build}-${randomUUID()}`);
  let backupDirectory = null;
  try {
    fs.mkdirSync(temporary);
    for (const { relative, filename } of sources) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL);
    }
    const manifest = { ...bundle.manifest, version: `${bundle.manifest.version.split('+')[0]}+codex.${build}` };
    const stagedFiles = {
      'config/plugin-source.json': manifest,
      'config/mcp-source.json': portableMcp,
      ...compatibilityFiles(manifest, portableMcp),
      'package.json': { ...bundle.packageJson, version: manifest.version },
    };
    for (const [relative, content] of Object.entries(stagedFiles)) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, jsonText(content));
    }
    fs.writeFileSync(path.join(temporary, '.claude-plugin', 'marketplace.json'), jsonText({
      name: CLAUDE_MARKETPLACE,
      owner: { name: publisherName },
      plugins: [{ name: PLUGIN_NAME, source: './', description: 'Asynchronous two-way messaging between Claude Code and Codex conversations.' }],
    }));
    if (fs.existsSync(destination)) {
      backupDirectory = path.join(pluginsDir, `.${PLUGIN_NAME}.backup-${build}-${randomUUID()}`);
      // Both move targets are resolved, fixed children of this installer-owned plugins directory.
      if (!contained(pluginsDir, backupDirectory)) throw new Error('Invalid staging backup path.');
      renameDirectoryWithRetry(destination, backupDirectory);
    }
    try { renameDirectoryWithRetry(temporary, destination); } catch (error) {
      if (backupDirectory && !fs.existsSync(destination)) renameDirectoryWithRetry(backupDirectory, destination);
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) {
      const resolved = fs.realpathSync(temporary);
      if (!contained(fs.realpathSync(pluginsDir), resolved) || path.basename(temporary).indexOf(`.${PLUGIN_NAME}.stage-`) !== 0) {
        throw new Error('Refusing cleanup outside the staging directory.');
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  let marketplaceBackup = null;
  if (codex) {
    const lockDirectory = path.join(path.dirname(marketplacePath), `.${PLUGIN_NAME}-marketplace-lock`);
    withStateLock(lockDirectory, () => {
      // Staging may take time: merge into the latest catalog under a short lock.
      // The final comparison also detects changes from non-cooperating writers
      // before the replacement, rather than reusing the pre-staging snapshot.
      const expectedPrevious = readRawIfPresent(marketplacePath);
      marketplace = codexMarketplacePlan(marketplacePath, expectedPrevious);
      marketplaceBackup = writeJsonAtomic(marketplacePath, marketplace, { expectedPrevious });
      if (expectedPrevious && JSON.parse(expectedPrevious.replace(/^\uFEFF/, '')).plugins.some(entry => entry?.name === LEGACY_PLUGIN)) {
        log(`Removed old bridge entry from ${marketplacePath}`);
      }
    });
  }
  return { destination, stateDir, marketplacePath: marketplace ? marketplacePath : null,
    marketplaceName: marketplace?.name ?? null, claudeMarketplace: CLAUDE_MARKETPLACE,
    build, backupDirectory, marketplaceBackup, codex, claude };
}

function cliExecutable(command) {
  if (process.platform !== 'win32') return command;
  // An npm, pnpm, yarn, or Volta install puts only a codex.cmd shim on PATH, which cannot be spawned
  // without a shell; resolve the vendored codex.exe it launches (or CLAUDE_CODEX_BRIDGE_CODEX_BIN).
  if (command === 'codex') return resolveCodexExecutable() ?? 'codex.exe';
  return `${command}.exe`;
}

const CLI_HINTS = {
  codex: 'Install the Codex CLI (for example `npm install -g @openai/codex`, then `codex login`), or set CLAUDE_CODEX_BRIDGE_CODEX_BIN to the full path of codex.exe. To install only the Claude side now, run `node scripts/install.mjs --claude`.',
  claude: 'Install Claude Code so that `claude` works in this terminal (https://docs.claude.com/en/docs/claude-code), or run `node scripts/install.mjs --codex` to install only the Codex side now.',
};

function run(command, args, { cwd } = {}) {
  const executable = cliExecutable(command);
  const result = spawnSync(executable, args, {
    cwd, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}${result.error.code === 'ENOENT' && CLI_HINTS[command] ? `\n${CLI_HINTS[command]}` : ''}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 6000);
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status ?? result.signal}).${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function readList(output, key) {
  const parsed = JSON.parse(output);
  const list = Array.isArray(parsed) ? parsed : parsed?.[key];
  if (!Array.isArray(list)) throw new Error(`The application CLI returned an unsupported ${key} listing.`);
  return list;
}

function registeredPath(entry) {
  const source = entry?.source;
  if (object(source) && !['directory', 'local', undefined].includes(source.source)) return null;
  const candidates = [source?.path, typeof source === 'string' ? source : null,
    entry?.path, entry?.installLocation, entry?.location];
  return candidates.find(value => typeof value === 'string' && path.isAbsolute(value)) ?? null;
}

function samePath(left, right) {
  const normalize = filename => {
    let resolved = path.resolve(filename);
    try { resolved = fs.realpathSync(resolved); } catch {}
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function installApplications(prepared, { execute = run, homeDir = os.homedir(), env = process.env,
  log = console.log, grantPermission = grantClaudeSendPermission } = {}) {
  if (prepared.codex) {
    execute('codex', ['plugin', 'add', `${PLUGIN_NAME}@${prepared.marketplaceName}`, '--json']);
    log('Codex plugin installed or updated.');
  }
  if (prepared.claude) {
    const marketplaces = readList(execute('claude', ['plugin', 'marketplace', 'list', '--json']), 'marketplaces');
    const registered = marketplaces.filter(entry => entry.name === CLAUDE_MARKETPLACE);
    if (registered.length > 1) throw new Error('Claude reports duplicate local bridge marketplaces.');
    if (registered.length) {
      let location = registeredPath(registered[0]);
      if (!location) {
        const registry = optionalJson(path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'plugins', 'known_marketplaces.json'));
        location = registeredPath(registry?.[CLAUDE_MARKETPLACE]);
      }
      if (!location || !samePath(location, prepared.destination)) {
        throw new Error('Claude already has this marketplace name with a different or unverifiable source. Resolve the conflict before installing.');
      }
    } else {
      execute('claude', ['plugin', 'marketplace', 'add', prepared.destination, '--scope', 'user']);
    }
    const selector = `${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}`;
    const plugins = readList(execute('claude', ['plugin', 'list', '--json']), 'plugins');
    const installed = plugins.some(entry => (entry.id === selector || entry.name === selector ||
      (entry.name === PLUGIN_NAME && entry.marketplace === CLAUDE_MARKETPLACE)) &&
      (entry.scope === undefined || entry.scope === 'user'));
    execute('claude', ['plugin', installed ? 'update' : 'install', selector, '--scope', 'user', '--json']);
    log(`Claude plugin ${installed ? 'updated' : 'installed'}.`);
    const granted = grantPermission({ homeDir, env });
    log(granted.added ? `Allowed Claude outbound bridge tool: ${granted.rule}` : `Claude outbound bridge tool was already allowed: ${granted.rule}`);
    if (granted.backup) log(`Previous Claude settings backup: ${granted.backup}`);
  }
}

export async function main(args = process.argv.slice(2), { homeDir = os.homedir(), env = process.env,
  execute = run, log = console.log } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    log('Usage: node scripts/install.mjs [--all | --claude | --codex] [--prepare-only]\nDefault: install for both apps. A normal Claude installation grants only its send_to_codex MCP tool in user permissions.allow. --prepare-only stages files and local catalogs without invoking either app CLI or changing tool permissions.');
    return;
  }
  for (const arg of args) if (!['--all', '--codex', '--claude', '--prepare-only'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  const selected = args.filter(arg => ['--all', '--codex', '--claude'].includes(arg));
  if (selected.length > 1) throw new Error('Choose exactly one of --all, --claude, or --codex.');
  checkEnvironment(env);
  const target = selected[0] ?? '--all';
  const selection = { codex: target !== '--claude', claude: target !== '--codex' };
  // Refuse an invalid source or route before removing a working legacy install.
  checkManifests(projectRoot, { checkNative: false });
  if (env.CLAUDE_CODEX_BRIDGE_SSH_HOST !== undefined) validateSshHostAlias(env.CLAUDE_CODEX_BRIDGE_SSH_HOST);
  if (!args.includes('--prepare-only')) migrateLegacyInstallation({ homeDir, env, execute, log, ...selection });
  const prepared = prepareInstallation({ homeDir, env, log, ...selection });
  log(`Prepared ${PLUGIN_NAME} in ${prepared.destination}`);
  if (prepared.backupDirectory) log(`Previous staged files: ${prepared.backupDirectory}`);
  if (prepared.marketplaceBackup) log(`Personal marketplace backup: ${prepared.marketplaceBackup}`);
  if (args.includes('--prepare-only')) {
    log('Preparation complete. No application plugin commands were run.');
    return prepared;
  }
  installApplications(prepared, { homeDir, env, execute, log });
  if (env.CODEX_APP_TOOLS_PIPE_PATH && env.CODEX_THREAD_ID && !env.CLAUDE_CODE_MESSAGING_SOCKET) {
    const { publishCodexHost } = await import('../lib/codex-host.mjs');
    publishCodexHost({ stateDir: prepared.stateDir,
      pipePath: env.CODEX_APP_TOOLS_PIPE_PATH, threadId: env.CODEX_THREAD_ID });
    log('Registered this Codex Desktop host for local conversation discovery.');
  }
  if (prepared.claude) log('In Claude CLI, run /reload-plugins and check /mcp. If it warns that the conversation would be re-read, the reload is held: run /reload-plugins --force. In Claude Desktop, fully quit and reopen the app when convenient so its MCP process loads this version.');
  if (prepared.codex) log('Fully quit Codex Desktop, not only its window, and reopen it: until then new tasks still start the old version. Restart terminal Codex sessions when convenient to load updated tools.');
  log(`Apps were not restarted.${prepared.claude ? ' Only the exact Claude send_to_codex tool received a user-level allow rule.' : ' Claude tool permissions were not changed.'}`);
  pruneInstallationBackups(prepared, homeDir);
  return prepared;
}

// Node resolves the entry module through links (macOS /tmp is /private/tmp), so compare real paths.
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(`Installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
