import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Real environment variables win over .env, which lets tests override anything.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env yet. The chat explains what's missing on first use.
}

export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = path.resolve(process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data'));
// Where relative file paths and shell commands start. Not a limit on what's reachable.
export const FILES_DIR = path.resolve(process.env.JARVIS_FILES_DIR || os.homedir());

fs.mkdirSync(DATA_DIR, { recursive: true });

export const dataPath = (name) => path.join(DATA_DIR, name);
