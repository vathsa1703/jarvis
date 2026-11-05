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

const APP_LIST_MAX_AGE_MS = 5 * 60_000;
const APP_LIST_RETRY_MS = 30_000;
let appList = { apps: [], fetchedAt: 0 };

// Everything in the Start menu, including Store apps like Teams that have no shortcut file.
async function fetchInstalledApps() {
  const { code, stdout } = await runPowerShell('Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress', { timeoutMs: 20_000 });
  if (code !== 0 || !stdout.trim()) return [];
  return [].concat(JSON.parse(stdout));
}

// An exact name wins. Otherwise "teams" finds "Microsoft Teams" as a whole word, and the
// shortest name wins, so "word" means "Word" and never "WordPad" or "Word Viewer Setup".
export function matchInstalledApp(name, apps) {
  const wanted = String(name).trim().toLowerCase();
  if (!wanted || /[\\/:]/.test(wanted) || wanted.startsWith('uninstall')) return null;
  const usable = apps.filter((app) => app.Name && app.AppID && !/uninstall/i.test(app.Name));
  const exact = usable.find((app) => app.Name.toLowerCase() === wanted);
  if (exact) return exact;
  const pattern = new RegExp(`(?:^|\\s)${wanted.replace(/[.*+?^${}()|[\]]/g, '\\$&')}(?:\\s|$)`, 'i');
  return usable.filter((app) => pattern.test(app.Name)).sort((a, b) => a.Name.length - b.Name.length)[0] ?? null;
}

async function findInstalledApp(name) {
  const age = Date.now() - appList.fetchedAt;
  if (age > APP_LIST_MAX_AGE_MS) appList = { apps: await fetchInstalledApps(), fetchedAt: Date.now() };
  let match = matchInstalledApp(name, appList.apps);
  // Not found in an older list, so it may have just been installed.
  if (!match && Date.now() - appList.fetchedAt > APP_LIST_RETRY_MS) {
    appList = { apps: await fetchInstalledApps(), fetchedAt: Date.now() };
    match = matchInstalledApp(name, appList.apps);
  }
  return match;
}

// Launching through the Start menu passes no arguments, so this can only start
// an installed app the way you'd start it yourself.
async function knownApp(name) {
  const installed = await findInstalledApp(name);
  if (installed) return `shell:AppsFolder\\${installed.AppID}`;
  return KNOWN_APPS[name.trim().toLowerCase()] ?? null;
}

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
    confirm: async ({ name }) =>
      (await knownApp(name)) ? null : { title: "This app isn't in your Start menu. Open it anyway?", details: name },
    run: async ({ name }) => {
      await startDetached((await knownApp(name)) || name);
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
