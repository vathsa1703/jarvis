import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT, ROOT } from './config.js';
import { runAgent } from './agent.js';
import { getProvider, LlmError } from './llm.js';
import { clearHistory } from './memory.js';
import { googleAuthUrl, handleGoogleCallback } from './tools/email.js';

const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

const app = express();
app.disable('x-powered-by');

// Stops a malicious site reaching this server through DNS rebinding.
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host)) return res.status(403).send('Forbidden');
  next();
});

app.use(express.static(path.join(ROOT, 'client')));

app.get('/auth/google', (_req, res) => {
  try {
    res.redirect(googleAuthUrl());
  } catch (err) {
    res.status(400).type('text').send(err.message);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    await handleGoogleCallback(req.query);
    res.type('text').send('Gmail is connected. You can close this tab and go back to Jarvis.');
  } catch (err) {
    res.status(400).type('text').send(err.message);
  }
});

const server = http.createServer(app);

// Without the origin check, any website you visit could open a socket to this
// server and drive your PC. Browsers always send Origin and pages can't fake it.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }) => allowedHosts.has(req.headers.host) && allowedOrigins.has(req.headers.origin),
});

const send = (socket, event) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
};
const broadcast = (event) => wss.clients.forEach((client) => send(client, event));

function statusEvent() {
  try {
    const { name, model } = getProvider();
    return { type: 'status', provider: name, model };
  } catch (err) {
    return { type: 'error', message: err.message };
  }
}

wss.on('connection', (socket) => {
  const pending = new Map();
  let abort = null;

  send(socket, statusEvent());

  function confirm({ title, details }) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const settle = (approved) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(approved);
      };
      // No answer counts as no.
      const timer = setTimeout(() => {
        send(socket, { type: 'confirm_expired', id });
        settle(false);
      }, CONFIRM_TIMEOUT_MS);
      pending.set(id, settle);
      send(socket, { type: 'confirm', id, title, details });
    });
  }

  async function handleChat(text) {
    if (abort) return send(socket, { type: 'error', message: 'Still working on your last request.' });
    abort = new AbortController();
    try {
      const reply = await runAgent(text, {
        signal: abort.signal,
        confirm,
        notify: broadcast,
        onDelta: (delta) => send(socket, { type: 'delta', text: delta }),
        onTool: (name) => send(socket, { type: 'tool', name }),
      });
      send(socket, { type: 'done', text: reply });
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!(err instanceof LlmError)) console.error(err);
      send(socket, { type: 'error', message: err instanceof LlmError ? err.message : `Something broke: ${err.message}` });
    } finally {
      abort = null;
    }
  }

  socket.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.type === 'chat' && typeof event.text === 'string' && event.text.trim()) {
      handleChat(event.text.trim());
    } else if (event.type === 'confirm') {
      // Exact match on true: anything else is a no.
      pending.get(event.id)?.(event.approved === true);
    } else if (event.type === 'stop') {
      abort?.abort();
      [...pending.values()].forEach((settle) => settle(false));
    } else if (event.type === 'clear') {
      clearHistory();
    }
  });

  socket.on('close', () => {
    abort?.abort();
    [...pending.values()].forEach((settle) => settle(false));
  });
});

// 127.0.0.1 only: nothing else on your network can connect.
server.listen(PORT, '127.0.0.1', () => {
  const status = statusEvent();
  const brain = status.type === 'status' ? `brain: ${status.provider} / ${status.model}` : status.message;
  console.log(`Jarvis is online at http://localhost:${PORT} (${brain})`);
});
