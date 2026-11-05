import fs from 'node:fs';
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
export const FILES_DIR = path.resolve(process.env.JARVIS_FILES_DIR || path.join(DATA_DIR, 'workspace'));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

export const dataPath = (name) => path.join(DATA_DIR, name);
