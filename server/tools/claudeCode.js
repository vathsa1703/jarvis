import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../store.js';
import { runPowerShell, spawnPowerShell } from '../powershell.js';

const PROJECTS_FILE = 'projects.json';
const JOB_TIMEOUT_MS = 30 * 60_000;
const VALID_MODES = new Set(['default', 'acceptEdits', 'plan']);

const loadProjects = () => readJson(PROJECTS_FILE, {});

// Accepts a saved project name or a real path. Always returns an existing folder.
export function resolveFolder(nameOrPath) {
  const value = String(nameOrPath).trim();
  const projects = loadProjects();
  const key = Object.keys(projects).find((k) => k.toLowerCase() === value.toLowerCase());
  const folder = key ? projects[key] : value;
  if (!path.isAbsolute(folder)) {
    throw new Error(`"${value}" isn't a saved project or a full folder path. Ask the user for the path.`);
  }
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The folder ${folder} doesn't exist.`);
  }
  return path.resolve(folder);
}

// Windows PowerShell 5.1 mangles embedded double quotes when it calls a program,
// so text after one could arrive as extra CLI flags such as a permission override.
// Removing quotes and trailing backslashes, and never starting with "-", means the
// prompt always reaches Claude as one positional argument.
export function sanitizePrompt(prompt) {
  const clean = String(prompt)
    .replace(/"/g, "'")
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/\\+\s*$/, '')
    .trim();
  if (!clean) throw new Error('The prompt for Claude is empty.');
  return clean.startsWith('-') ? `Task: ${clean}` : clean;
}

function childEnv(folder, prompt) {
  // Without this, a Jarvis started from inside Claude Code would be refused as a nested session.
  return { JARVIS_CWD: folder, JARVIS_PROMPT: prompt, CLAUDECODE: undefined };
}

async function launchVisible(folder, prompt) {
  // The single quotes matter: the new window is the one that expands $env:JARVIS_PROMPT.
  const script =
    "Start-Process powershell.exe -WorkingDirectory $env:JARVIS_CWD -ArgumentList '-NoExit','-Command','claude $env:JARVIS_PROMPT'";
  const { code, stderr } = await runPowerShell(script, { env: childEnv(folder, prompt), timeoutMs: 15_000 });
  if (code !== 0) throw new Error(`Couldn't open a Claude window: ${stderr.trim()}`);
  return `Opened a Claude Code window in ${folder}. It's working on the task there.`;
}

function startHeadless(folder, prompt, notify) {
  const mode = process.env.CLAUDE_HEADLESS_PERMISSION_MODE || 'default';
  if (!VALID_MODES.has(mode)) throw new Error(`CLAUDE_HEADLESS_PERMISSION_MODE can't be "${mode}".`);
  const id = randomUUID().slice(0, 8);
  const child = spawnPowerShell(`claude -p $env:JARVIS_PROMPT --permission-mode ${mode}`, {
    env: childEnv(folder, prompt),
    cwd: folder,
  });

  let output = '';
  let errors = '';
  const timer = setTimeout(() => child.kill(), JOB_TIMEOUT_MS);
  child.stdout.on('data', (data) => {
    output += data;
    notify({ type: 'job', id, state: 'progress', text: String(data) });
  });
  child.stderr.on('data', (data) => {
    errors += data;
  });
  const finish = (ok, text) => {
    clearTimeout(timer);
    notify({ type: 'job', id, state: ok ? 'done' : 'failed', folder, text });
  };
  child.on('error', (err) => finish(false, err.message));
  child.on('close', (code) => {
    if (code === 0) finish(true, output.trim() || 'Claude finished without any output.');
    else finish(false, (errors || output).trim().slice(-800) || `Claude exited with code ${code}.`);
  });
  return `Started Claude Code in the background on ${folder} (job ${id}). I'll report back when it's done.`;
}

export default [
  {
    name: 'open_folder',
    description: 'Open a folder on this PC in File Explorer or VS Code. Accepts a saved project name or a full path.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Saved project name or full path' },
        app: { type: 'string', enum: ['explorer', 'vscode'], description: 'Default explorer' },
      },
      required: ['folder'],
    },
    run: async ({ folder, app }) => {
      const target = resolveFolder(folder);
      const script = app === 'vscode' ? 'code $env:JARVIS_CWD' : 'Start-Process explorer.exe -ArgumentList $env:JARVIS_CWD';
      const { code, stderr } = await runPowerShell(script, { env: { JARVIS_CWD: target }, timeoutMs: 20_000 });
      if (code !== 0) throw new Error(stderr.trim() || `Couldn't open ${target}.`);
      return `Opened ${target}.`;
    },
  },
  {
    name: 'ask_claude',
    description:
      'Hand a coding or build task to Claude Code, working in a folder on this PC. Pass the user\'s request in full. ' +
      'mode "visible" (the default) opens a terminal window the user can watch and steer. ' +
      'mode "headless" runs in the background and reports back when finished.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Saved project name or full path' },
        prompt: { type: 'string', description: 'What Claude Code should do' },
        mode: { type: 'string', enum: ['visible', 'headless'] },
      },
      required: ['folder', 'prompt'],
    },
    confirm: ({ folder, prompt, mode }) => ({
      title: 'Ask Claude Code to do this?',
      details: `Folder: ${resolveFolder(folder)}\nMode: ${mode === 'headless' ? 'background' : 'visible window'}\n\n${sanitizePrompt(prompt)}`,
    }),
    run: async ({ folder, prompt, mode }, ctx) => {
      const target = resolveFolder(folder);
      const clean = sanitizePrompt(prompt);
      return mode === 'headless' ? startHeadless(target, clean, ctx.notify) : launchVisible(target, clean);
    },
  },
  {
    name: 'list_projects',
    description: 'List the saved project names and their folders.',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const projects = loadProjects();
      return Object.keys(projects).length ? projects : 'No projects saved yet.';
    },
  },
  {
    name: 'save_project',
    description: 'Save a short name for a folder, so "my website" can stand in for the full path.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string', description: 'Full folder path' } },
      required: ['name', 'path'],
    },
    confirm: ({ name, path: folder }) => ({ title: 'Save this project?', details: `${name} = ${folder}` }),
    run: ({ name, path: folder }) => {
      const target = resolveFolder(folder);
      writeJson(PROJECTS_FILE, { ...loadProjects(), [String(name).trim()]: target });
      return `Saved "${name}" as ${target}.`;
    },
  },
];
