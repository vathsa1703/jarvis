import fs from 'node:fs';
import { dataPath } from './config.js';

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A corrupt file holds the user's data, so stop rather than overwrite it.
    throw new Error(`Could not read ${dataPath(name)}: ${err.message}`);
  }
}

// Write then rename, so a crash mid-write can't corrupt the file.
export function writeJson(name, value) {
  const target = dataPath(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}
