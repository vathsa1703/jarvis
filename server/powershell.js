import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 200_000;

// Spawns PowerShell with an encoded script. Pass untrusted values through `env`
// and read them as $env:NAME inside the script: PowerShell treats an expanded
// variable as data, so its contents never get parsed as code.
export function spawnPowerShell(script, { env = {}, cwd } = {}) {
  const prelude = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    { env: { ...process.env, ...env }, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

export function runPowerShell(script, { env, cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPowerShell(script, { env, cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function startDetached(target) {
  const { code, stderr } = await runPowerShell('Start-Process -FilePath $env:JARVIS_TARGET', {
    env: { JARVIS_TARGET: target },
    timeoutMs: 15_000,
  });
  if (code !== 0) throw new Error(stderr.trim().split('\n')[0] || `Couldn't open ${target}`);
}
