import fs from 'node:fs/promises';
import path from 'node:path';
import { FILES_DIR } from '../config.js';

const READ_LIMIT = 100_000;

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolves a path and refuses to leave FILES_DIR, including by following a symlink.
export async function safePath(relative = '.') {
  const root = await fs.realpath(FILES_DIR);
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) throw new Error(`"${relative}" is outside the Jarvis files folder.`);

  // A new file has no real path yet, so check the deepest part that does exist.
  let existing = target;
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      existing = path.dirname(existing);
    }
  }
  if (!isInside(root, existing)) throw new Error(`"${relative}" is outside the Jarvis files folder.`);
  return target;
}

export default [
  {
    name: 'list_files',
    description: 'List files in the Jarvis files folder or a subfolder of it.',
    parameters: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Relative subfolder. Omit for the top level.' } },
    },
    run: async ({ folder }) => {
      const entries = await fs.readdir(await safePath(folder), { withFileTypes: true });
      if (!entries.length) return 'The folder is empty.';
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the Jarvis files folder.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path' } },
      required: ['path'],
    },
    run: async ({ path: file }) => (await fs.readFile(await safePath(file), 'utf8')).slice(0, READ_LIMIT),
    untrusted: true,
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the Jarvis files folder. The user must approve it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
    },
    confirm: async ({ path: file, content }) => ({
      title: 'Write this file?',
      details: `${await safePath(file)}\n\n${content}`,
    }),
    run: async ({ path: file, content }) => {
      const target = await safePath(file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      return `Wrote ${target}.`;
    },
  },
];
