import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));

export const say = (text) => ({ text });
export const callTool = (name, args) => ({ tool: { name, args } });

// A scripted stand-in for an OpenAI-compatible server. It streams like the real
// thing, including tool-call arguments split across chunks.
export async function startFakeLlm() {
  const script = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const step = script.shift() ?? say('(script finished)');
      if (step.status) {
        res.writeHead(step.status, { 'Content-Type': 'application/json', ...step.headers });
        res.end(JSON.stringify(step.body));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      if (step.text) {
        for (const piece of step.text.match(/.{1,5}/gs)) emit({ content: piece });
      }
      if (step.tool) {
        const json = JSON.stringify(step.tool.args);
        const middle = Math.floor(json.length / 2);
        const id = `call_${requests.length}`;
        emit({ tool_calls: [{ index: 0, id, type: 'function', function: { name: step.tool.name, arguments: json.slice(0, middle) } }] });
        emit({ tool_calls: [{ index: 0, function: { arguments: json.slice(middle) } }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    script,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

export async function startJarvis(env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, CLAUDECODE: undefined, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let log = '';
    const onData = (data) => {
      log += data;
      if (log.includes('Jarvis is online')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`Jarvis exited with code ${code}: ${log}`)));
    setTimeout(() => reject(new Error(`Jarvis didn't start: ${log}`)), 10_000).unref();
  });
  child.removeAllListeners('exit');
  return {
    stop: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

// A WebSocket client with a simple "wait for the next event of this type".
export function connect(port, { origin = `http://localhost:${port}`, host } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { ...(origin ? { Origin: origin } : {}), Host: host ?? `localhost:${port}` },
    });
    const events = [];
    const waiters = [];
    const pump = () => {
      for (let i = 0; i < waiters.length; i++) {
        const index = events.findIndex(waiters[i].match);
        if (index >= 0) {
          waiters[i].resolve(events.splice(index, 1)[0]);
          waiters.splice(i--, 1);
        }
      }
    };
    socket.on('message', (raw) => {
      events.push(JSON.parse(raw));
      pump();
    });
    socket.once('error', reject);
    socket.once('open', () =>
      resolve({
        send: (event) => socket.send(JSON.stringify(event)),
        chat: (text) => socket.send(JSON.stringify({ type: 'chat', text })),
        next: (types, timeoutMs = 15_000) =>
          new Promise((res, rej) => {
            const wanted = [].concat(types);
            const timer = setTimeout(() => rej(new Error(`Timed out waiting for ${wanted}`)), timeoutMs);
            waiters.push({
              match: (e) => wanted.includes(e.type),
              resolve: (e) => {
                clearTimeout(timer);
                res(e);
              },
            });
            pump();
          }),
        close: () => socket.close(),
      })
    );
  });
}
