import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, FILES_DIR } from '../config.js';
import { startDetached } from '../powershell.js';

const READ_LIMIT = 100_000;
const SEARCH_RESULTS = 30;
const SEARCH_TIMEOUT_MS = 15_000;

// Jarvis can reach every file on the PC. These are the ones a web page or email
// would most want to trick it into reading, so they take a click first.
const SENSITIVE_PATTERNS = [
  /\/\.(ssh|aws|azure|gnupg|kube)\//,
  /\/(google\/chrome|microsoft\/edge|bravesoftware\/brave-browser)\/user data\//,
  /\/mozilla\/firefox\/profiles\//,
  /\/appdata\/roaming\/gh\//,
  /\/\.claude\/\.credentials/,
  /\/windows\/system32\/config\//,
  /\/\.env(\.(?!example$)[^/]*)?$/,
  /\.(pem|key|pfx|p12|ppk|kdbx)$/,
  /\/(id_rsa|id_ed25519|id_ecdsa|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials|credentials\.json|secrets\.json|token\.json|wallet\.dat)$/,
];

// New files go straight through, unless they could run by themselves later:
// startup items, app settings and hooks, or programs and scripts.
const RISKY_TO_CREATE =
  /\/appdata\/roaming\/|\/\.(claude|vscode|git)\/|\.(exe|bat|cmd|ps1|psm1|vbs|vbe|wsf|hta|scr|lnk|msi|reg)$/;

// Skipped when searching, because they're huge and full of files nobody means.
const SKIP_FOLDERS = new Set([
  'node_modules', '.git', 'appdata', '$recycle.bin', 'windows',
  'program files', 'program files (x86)', 'programdata', 'system volume information',
]);

// Documents and media open straight away. Anything else could be a program, so it asks.
const SAFE_TO_OPEN = new Set([
  '.pdf', '.txt', '.md', '.rtf', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp3', '.wav', '.m4a', '.mp4', '.mkv', '.mov', '.avi',
]);

// Relative paths start from the home folder, and ~ means the home folder.
export function resolvePath(input = '.') {
  const value = String(input).trim();
  const expanded = value === '~' || /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(FILES_DIR, expanded);
}

// The real location, so a link or short 8.3 name can't disguise it. A new file has
// no real path yet, so this resolves the deepest part that exists.
async function realLocation(target) {
  let existing = target;
  const missing = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), ...missing);
    } catch (err) {
      const parent = path.dirname(existing);
      if ((err.code !== 'ENOENT' && err.code !== 'ENOTDIR') || parent === existing) return target;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

const normalize = (p) => p.replaceAll('\\', '/').toLowerCase().replace(/[. ]+$/, '');

export async function isSensitive(target) {
  // A second colon is an NTFS alternate stream, such as .env::$DATA.
  if (target.slice(2).includes(':')) return true;
  const real = normalize(await realLocation(target));
  const data = `${normalize(await realLocation(DATA_DIR))}/`;
  return real.startsWith(data) || SENSITIVE_PATTERNS.some((pattern) => pattern.test(real));
}

async function readText(target) {
  const handle = await fs.open(target, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(READ_LIMIT), 0, READ_LIMIT, 0);
    const content = buffer.subarray(0, bytesRead);
    if (content.subarray(0, 8000).includes(0)) {
      throw new Error(`${path.basename(target)} is a binary file, so it can't be read as text. Try open_file instead.`);
    }
    return content.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function findFiles(name, folder) {
  const needle = String(name).trim().toLowerCase();
  if (!needle) throw new Error('Say what file name to look for.');
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const queue = [resolvePath(folder ?? '~')];
  const matches = [];
  for (let i = 0; i < queue.length && matches.length < SEARCH_RESULTS; i++) {
    if (Date.now() > deadline) return { matches, note: 'Stopped after 15 seconds, so this may be incomplete.' };
    let entries;
    try {
      entries = await fs.readdir(queue[i], { withFileTypes: true });
    } catch {
      continue; // No permission for this folder. Keep searching the rest.
    }
    for (const entry of entries) {
      const full = path.join(queue[i], entry.name);
      if (entry.name.toLowerCase().includes(needle) && matches.length < SEARCH_RESULTS) matches.push(full);
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_FOLDERS.has(entry.name.toLowerCase())) queue.push(full);
    }
  }
  return { matches };
}

export default [
  {
    name: 'list_files',
    description: 'List the contents of any folder on this PC. Accepts a full path like D:\\Projects, or a path relative to the home folder like Desktop.',
    parameters: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Folder path. Omit for the home folder.' } },
    },
    run: async ({ folder }) => {
      const target = resolvePath(folder);
      const entries = await fs.readdir(target, { withFileTypes: true });
      if (!entries.length) return `${target} is empty.`;
      return `${target}\n${entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n')}`;
    },
    untrusted: true,
    outsideContent: false, // Only names, so "find my resume and mail Rahul" stays one step.
  },
  {
    name: 'find_files',
    description: 'Find files or folders anywhere on this PC by part of their name. Searches the home folder unless given another folder or drive.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Part of the file name, such as "resume"' },
        folder: { type: 'string', description: 'Where to search, such as D:\\. Omit for the home folder.' },
      },
      required: ['name'],
    },
    run: ({ name, folder }) => findFiles(name, folder),
    untrusted: true,
    outsideContent: false,
  },
  {
    name: 'read_file',
    description: 'Read a text file anywhere on this PC. Files that may hold passwords or keys need the user\'s approval.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Full path, or a path relative to the home folder' } },
      required: ['path'],
    },
    confirm: async ({ path: file }) => {
      const target = resolvePath(file);
      if (!(await isSensitive(target))) return null;
      return {
        title: 'This file may hold passwords or keys. Let Jarvis read it?',
        details: `${target}\n\nIts contents will go to your AI provider.`,
      };
    },
    run: ({ path: file }) => readText(resolvePath(file)),
    untrusted: true,
  },
  {
    name: 'write_file',
    description: 'Create a text file anywhere on this PC, or overwrite one. Changing an existing file needs the user\'s approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path, or a path relative to the home folder' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
    },
    confirm: async ({ path: file, content }, ctx) => {
      const target = resolvePath(file);
      const details = `${target}\n\n${content}`;
      const exists = await fs.stat(target).then(() => true, () => false);
      if (exists) return { title: 'Change this existing file?', details };
      const risky = (await isSensitive(target)) || RISKY_TO_CREATE.test(normalize(await realLocation(target)));
      if (risky) return { title: 'This file could run by itself or hold secrets. Create it?', details };
      if (ctx.readOutsideContent) return { title: 'Jarvis read outside content for this request. Create this file?', details };
      return null;
    },
    run: async ({ path: file, content }, ctx) => {
      const target = resolvePath(file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Unapproved writes can only create. "wx" fails rather than overwrite a file
      // that appeared after the check above.
      await fs.writeFile(target, content, { flag: ctx.approved ? 'w' : 'wx' });
      ctx.notice?.(`Saved ${target}`);
      return `Wrote ${target}.`;
    },
  },
  {
    name: 'create_folder',
    description: 'Create a folder anywhere on this PC, including any parent folders it needs. Always use this rather than run_shell to make a folder.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Full path, or a path relative to the home folder' } },
      required: ['path'],
    },
    // No approval, even after reading outside content: an empty folder can't do anything.
    run: async ({ path: folder }, ctx) => {
      const target = resolvePath(folder);
      await fs.mkdir(target, { recursive: true });
      ctx.notice?.(`Created folder ${target}`);
      return `Created ${target}.`;
    },
  },
  {
    name: 'open_file',
    description: 'Open a file on this PC in its default app, such as a PDF, photo or Word document.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Full path, or a path relative to the home folder' } },
      required: ['path'],
    },
    confirm: ({ path: file }) => {
      const target = resolvePath(file);
      if (SAFE_TO_OPEN.has(path.extname(target).toLowerCase())) return null;
      return { title: 'This could run a program. Open it?', details: target };
    },
    run: async ({ path: file }) => {
      const target = resolvePath(file);
      await fs.stat(target);
      await startDetached(target);
      return `Opened ${target}.`;
    },
  },
];
