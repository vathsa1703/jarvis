import crypto from 'node:crypto';
import { PORT } from '../config.js';
import { readJson, writeJson } from '../store.js';

const TOKEN_FILE = 'token.json';
const CONTACTS_FILE = 'contacts.json';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

const redirectUri = () => `http://localhost:${PORT}/auth/google/callback`;
const EMAIL_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// ---- OAuth ------------------------------------------------------------

let pendingState = null;

function credentials() {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) {
    throw new Error('Gmail isn\'t set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see the README).');
  }
  return { id, secret };
}

export function googleAuthUrl() {
  const { id } = credentials();
  pendingState = crypto.randomBytes(24).toString('hex');
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: pendingState,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function requestToken(params) {
  const { id, secret } = credentials();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
  return body;
}

export async function handleGoogleCallback({ code, state, error }) {
  if (error) throw new Error(`Google sign-in was cancelled: ${error}`);
  if (!state || state !== pendingState) throw new Error('This sign-in link is stale. Start again from /auth/google.');
  pendingState = null;
  const token = await requestToken({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  writeJson(TOKEN_FILE, { ...token, expires_at: Date.now() + token.expires_in * 1000 });
}

async function accessToken() {
  credentials();
  const token = readJson(TOKEN_FILE, null);
  if (!token) throw new Error(`Gmail isn't connected yet. Open http://localhost:${PORT}/auth/google to connect it.`);
  if (Date.now() < token.expires_at - 60_000) return token.access_token;
  if (!token.refresh_token) {
    throw new Error(`Gmail sign-in expired. Open http://localhost:${PORT}/auth/google to reconnect.`);
  }
  const fresh = await requestToken({ refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  writeJson(TOKEN_FILE, { ...token, ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 });
  return fresh.access_token;
}

async function gmail(path, options = {}) {
  const res = await fetch(`${GMAIL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...options.headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gmail returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- Messages ---------------------------------------------------------

// A line break in a header would let text add extra headers, such as a hidden Bcc.
const singleLine = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();

const encodeHeader = (value) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

export function buildRawMessage({ to, subject, body }) {
  const lines = [
    `To: ${singleLine(to)}`,
    `Subject: ${encodeHeader(singleLine(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const text = extractText(part);
    if (text) return text;
  }
  return '';
}

async function listMessages(query, max) {
  const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(Number(max) || 5, 1), 20)) });
  if (query) params.set('q', query);
  const { messages = [] } = await gmail(`/messages?${params}`);
  return Promise.all(
    messages.map(async ({ id }) => {
      const m = await gmail(`/messages/${id}?format=full`);
      const header = (name) =>
        m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
      return {
        from: header('from'),
        subject: header('subject'),
        date: header('date'),
        snippet: m.snippet,
        body: extractText(m.payload).slice(0, 1500),
      };
    })
  );
}

// ---- Contacts ---------------------------------------------------------

const loadContacts = () => readJson(CONTACTS_FILE, {});

export function resolveRecipient(nameOrAddress) {
  const value = singleLine(nameOrAddress);
  if (EMAIL_PATTERN.test(value)) return value;
  const contacts = loadContacts();
  const key = Object.keys(contacts).find((k) => k.toLowerCase() === value.toLowerCase());
  if (!key) throw new Error(`No contact named "${value}". Ask the user for the email address.`);
  return contacts[key];
}

export default [
  {
    name: 'send_email',
    description: 'Send an email from the user\'s Gmail. The user sees the draft and must approve it.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email address, or the name of a saved contact' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    confirm: ({ to, subject, body }) => ({
      title: 'Send this email?',
      details: `To: ${resolveRecipient(to)}\nSubject: ${singleLine(subject)}\n\n${body}`,
    }),
    run: async ({ to, subject, body }) => {
      const address = resolveRecipient(to);
      await gmail('/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: buildRawMessage({ to: address, subject, body }) }),
      });
      return `Email sent to ${address}.`;
    },
  },
  {
    name: 'read_inbox',
    description: 'Read the most recent emails in the Gmail inbox.',
    parameters: {
      type: 'object',
      properties: { max: { type: 'integer', description: 'How many, default 5' } },
    },
    untrusted: true,
    run: ({ max }) => listMessages('in:inbox', max),
  },
  {
    name: 'search_mail',
    description: 'Search Gmail using Gmail search syntax, such as "from:rahul invoice".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max: { type: 'integer', description: 'How many, default 5' },
      },
      required: ['query'],
    },
    untrusted: true,
    run: ({ query, max }) => listMessages(query, max),
  },
  {
    name: 'save_contact',
    description: 'Save a contact\'s name and email address so the user can email them by name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    },
    confirm: ({ name, email }) => ({ title: 'Save this contact?', details: `${name} = ${email}` }),
    run: ({ name, email }) => {
      const address = singleLine(email);
      if (!EMAIL_PATTERN.test(address)) throw new Error(`"${email}" isn't a valid email address.`);
      writeJson(CONTACTS_FILE, { ...loadContacts(), [singleLine(name)]: address });
      return `Saved ${name}.`;
    },
  },
];
