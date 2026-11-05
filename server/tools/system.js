import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from '../config.js';
import { runPowerShell, startDetached } from '../powershell.js';

// Installed apps open straight away. Anything else, such as an .exe path, asks first,
// because the model may be acting on a web page or email that's trying to trick it.
const KNOWN_APPS = {
  excel: 'excel.exe',
  'microsoft excel': 'excel.exe',
  word: 'winword.exe',
  'microsoft word': 'winword.exe',
  powerpoint: 'powerpnt.exe',
  'microsoft powerpoint': 'powerpnt.exe',
  outlook: 'outlook.exe',
  'microsoft outlook': 'outlook.exe',
  onenote: 'onenote.exe',
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  'file explorer': 'explorer.exe',
  chrome: 'chrome.exe',
  'google chrome': 'chrome.exe',
  edge: 'msedge.exe',
  'microsoft edge': 'msedge.exe',
  'vs code': 'code',
  vscode: 'code',
  'visual studio code': 'code',
  spotify: 'spotify:',
  settings: 'ms-settings:',
};

function startMenuFolders() {
  return [process.env.ProgramData, process.env.APPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
}

// Finds an installed app's Start Menu shortcut by its exact name. Launching one
// passes no arguments, so a shortcut can only start the app as you'd start it yourself.
export function findStartMenuApp(name, folders = startMenuFolders()) {
  const wanted = `${String(name).trim().toLowerCase()}.lnk`;
  if (wanted.startsWith('uninstall')) return null;
  for (const folder of folders) {
    let entries;
    try {
      entries = fs.readdirSync(folder, { recursive: true, withFileTypes: true });
    } catch {
      continue; // This Start Menu folder doesn't exist or can't be read.
    }
    const match = entries.find((e) => e.isFile() && e.name.toLowerCase() === wanted);
    if (match) return path.join(match.parentPath, match.name);
  }
  return null;
}

const knownApp = (name) => KNOWN_APPS[name.trim().toLowerCase()] || findStartMenuApp(name);

export function parseWebUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" isn't a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed.');
  }
  return url;
}

export default [
  {
    name: 'get_time',
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {} },
    run: () =>
      new Date().toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }),
  },
  {
    name: 'open_app',
    description: 'Open an application on this PC by name, such as notepad, calculator, chrome or spotify.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name' } },
      required: ['name'],
    },
    confirm: ({ name }) =>
      knownApp(name) ? null : { title: 'Open this program?', details: name },
    run: async ({ name }) => {
      await startDetached(knownApp(name) || name);
      return `Opened ${name}.`;
    },
  },
  {
    name: 'open_url',
    description: 'Open a web page in the default browser.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http or https URL' } },
      required: ['url'],
    },
    run: async ({ url }) => {
      const parsed = parseWebUrl(url);
      await startDetached(parsed.href);
      return `Opened ${parsed.href}.`;
    },
  },
  {
    name: 'run_shell',
    description:
      'Run a PowerShell command on this PC and return its output. The user must click to approve every command, which interrupts them, so this is a last resort. Never use it for anything another tool can do: creating folders or files, listing or finding files, or opening apps, folders and URLs.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'PowerShell command' } },
      required: ['command'],
    },
    confirm: ({ command }) => ({ title: 'Run this command?', details: command }),
    run: async ({ command }) => {
      const { code, stdout, stderr, timedOut } = await runPowerShell(command, { cwd: FILES_DIR });
      if (timedOut) return `The command timed out after 60 seconds.\n${stdout}`;
      return `Exit code ${code}\n${stdout}${stderr ? `\nErrors:\n${stderr}` : ''}`.trim();
    },
    untrusted: true,
  },
];
