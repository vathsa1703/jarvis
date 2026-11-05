import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { tempDir } from './helpers.js';

process.env.JARVIS_DATA_DIR = tempDir();
process.env.JARVIS_FILES_DIR = tempDir();

let files, web, portfolio, email, claude, llm;
before(async () => {
  files = await import('../server/tools/files.js');
  web = await import('../server/tools/web.js');
  portfolio = await import('../server/tools/portfolio.js');
  email = await import('../server/tools/email.js');
  claude = await import('../server/tools/claudeCode.js');
  llm = await import('../server/llm.js');
});

test('paths resolve anywhere on the PC', async () => {
  const os = await import('node:os');
  assert.equal(files.resolvePath('C:\\Windows\\win.ini'), 'C:\\Windows\\win.ini');
  assert.equal(files.resolvePath('~/Desktop'), path.join(os.homedir(), 'Desktop'));
  assert.equal(files.resolvePath('~'), os.homedir());
  assert.equal(files.resolvePath('notes.txt'), path.join(process.env.JARVIS_FILES_DIR, 'notes.txt'));
});

test('secrets are recognised as sensitive, and ordinary files are not', async () => {
  const home = 'C:\\Users\\someone';
  for (const file of [
    `${home}\\.ssh\\id_ed25519`,
    `${home}\\.ssh\\config`,
    `${home}\\.aws\\credentials`,
    `${home}\\project\\.env`,
    `${home}\\project\\.ENV.local`,
    `${home}\\project\\.env::$DATA`,
    `${home}\\project\\.env.`,
    `${home}\\certs\\server.pem`,
    `${home}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data`,
    `${home}\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies`,
    `${home}\\AppData\\Roaming\\gh\\hosts.yml`,
    `${home}\\.claude\\.credentials.json`,
    path.join(process.env.JARVIS_DATA_DIR, 'token.json'),
  ]) {
    assert.equal(await files.isSensitive(file), true, file);
  }
  for (const file of [
    `${home}\\Desktop\\resume.txt`,
    `${home}\\project\\.env.example`,
    `${home}\\project\\environment.md`,
    `${home}\\Documents\\monkey.txt`,
  ]) {
    assert.equal(await files.isSensitive(file), false, file);
  }
});

test('a link cannot disguise a sensitive folder', async (t) => {
  const outside = tempDir();
  const ssh = path.join(outside, '.ssh');
  fs.mkdirSync(ssh);
  fs.writeFileSync(path.join(ssh, 'notes.txt'), 'secret');
  const link = path.join(process.env.JARVIS_FILES_DIR, 'innocent');
  try {
    fs.symlinkSync(ssh, link, 'junction');
  } catch (err) {
    return t.skip(`Can't create a link here: ${err.code}`);
  }
  assert.equal(await files.isSensitive(path.join(link, 'notes.txt')), true);
});

test('finds files by name, skipping noise folders', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'work', 'old'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'work', 'old', 'My-Resume.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'resume.js'), 'x');
  fs.writeFileSync(path.join(root, 'other.txt'), 'x');
  const { matches } = await files.findFiles('resume', root);
  assert.deepEqual(matches, [path.join(root, 'work', 'old', 'My-Resume.pdf')]);
});

test('the wake phrase survives mishearing without firing on ordinary talk', async () => {
  const { parseWake } = await import('../client/wake.js');
  assert.deepEqual(parseWake('hey Jarvis what time is it'), { command: 'what time is it' });
  assert.deepEqual(parseWake('Hey Jarvis, what time is it?'), { command: 'what time is it?' });
  assert.deepEqual(parseWake('Jarvis'), { command: '' });
  assert.deepEqual(parseWake('hey jarvis'), { command: '' });
  assert.deepEqual(parseWake('ok so hey jarvis open notepad'), { command: 'open notepad' });
  assert.deepEqual(parseWake('hey jervis open notepad'), { command: 'open notepad' });
  assert.deepEqual(parseWake('hey Travis open notepad'), { command: 'open notepad' });
  assert.equal(parseWake('I saw Travis Scott yesterday'), null);
  assert.equal(parseWake('what a nice day'), null);
  assert.equal(parseWake('the davis cup is on'), null);
});

test('installed apps open without asking, and anything else still asks', async () => {
  const system = await import('../server/tools/system.js');
  const openApp = system.default.find((t) => t.name === 'open_app');

  const menu = tempDir();
  fs.mkdirSync(path.join(menu, 'Vendor'));
  fs.writeFileSync(path.join(menu, 'Vendor', 'Some App.lnk'), '');
  fs.writeFileSync(path.join(menu, 'Vendor', 'Uninstall Some App.lnk'), '');
  assert.equal(system.findStartMenuApp('some app', [menu]), path.join(menu, 'Vendor', 'Some App.lnk'));
  assert.equal(system.findStartMenuApp('Uninstall Some App', [menu]), null);
  assert.equal(system.findStartMenuApp('app', [menu]), null, 'names must match exactly');
  assert.equal(system.findStartMenuApp('..\\Vendor\\Some App', [menu]), null);

  assert.equal(openApp.confirm({ name: 'Excel' }), null);
  assert.equal(openApp.confirm({ name: 'word' }), null);
  assert.ok(openApp.confirm({ name: 'C:\\Users\\Public\\payload.exe' }), 'an unknown program must ask');
  assert.ok(openApp.confirm({ name: 'totally-unknown-program' }), 'an unknown name must ask');
});

test('email headers cannot be injected', () => {
  const raw = email.buildRawMessage({
    to: 'a@example.com\r\nBcc: evil@example.com',
    subject: 'Hi\nBcc: evil@example.com',
    body: 'Hello',
  });
  const message = Buffer.from(raw, 'base64url').toString();
  const headers = message.split('\r\n\r\n')[0].split('\r\n');
  assert.equal(headers.filter((h) => /^bcc:/i.test(h)).length, 0);
  assert.equal(headers.filter((h) => /^to:/i.test(h)).length, 1);
});

test('email encodes non-ASCII subjects and bodies', () => {
  const raw = email.buildRawMessage({ to: 'a@example.com', subject: 'नमस्ते', body: 'Héllo' });
  const message = Buffer.from(raw, 'base64url').toString();
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  const body = message.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString(), 'Héllo');
});

test('an unknown contact is an error, not a guess', () => {
  assert.equal(email.resolveRecipient('a@example.com'), 'a@example.com');
  assert.throws(() => email.resolveRecipient('Rahul'), /No contact named/);
});

test('prompts for Claude cannot smuggle CLI flags', () => {
  assert.equal(claude.sanitizePrompt('fix "x" --dangerously-skip-permissions'), "fix 'x' --dangerously-skip-permissions");
  assert.equal(claude.sanitizePrompt('--dangerously-skip-permissions'), 'Task: --dangerously-skip-permissions');
  assert.equal(claude.sanitizePrompt('build in C:\\app\\'), 'build in C:\\app');
  assert.equal(claude.sanitizePrompt('one\r\ntwo'), 'one two');
  assert.throws(() => claude.sanitizePrompt('   '), /empty/);
});

test('folders must be saved projects or real absolute paths', () => {
  const folder = tempDir();
  assert.equal(claude.resolveFolder(folder), path.resolve(folder));
  assert.throws(() => claude.resolveFolder('some project'), /isn't a saved project/);
  assert.throws(() => claude.resolveFolder(path.join(folder, 'missing')), /doesn't exist/);
});

test('private addresses cannot be fetched', async () => {
  for (const url of ['http://127.0.0.1:3000/', 'http://localhost/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(web.assertPublicUrl(new URL(url)), /private network/, url);
  }
  await web.assertPublicUrl(new URL('http://8.8.8.8/'));
  await web.assertPublicUrl(new URL('http://[::ffff:8.8.8.8]/'));
});

test('RSS parsing handles CDATA and entities', () => {
  const xml = `<rss><channel><title>Feed</title>
    <item><title><![CDATA[Markets & more]]></title><link>https://x.test/1</link><pubDate>Today</pubDate><description>A &amp; B &#39;c&#39;</description></item>
    <item><title>Second</title><link>https://x.test/2</link></item>
    <item><title>Third</title></item></channel></rss>`;
  const items = web.parseFeed(xml, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Markets & more');
  assert.equal(items[0].link, 'https://x.test/1');
  assert.equal(items[0].summary, "A & B 'c'");
});

test('search parsing unwraps redirects and skips ads', () => {
  const html = `
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ad.test">Ad</a>
    <a class="result__snippet" href="#">Ad text</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fpage&amp;rut=abc">Real <b>page</b></a>
    <a class="result__snippet" href="#">Real <b>text</b></a>`;
  assert.deepEqual(web.parseSearchResults(html), [
    { title: 'Real page', url: 'https://real.test/page', snippet: 'Real text' },
  ]);
});

test('page text drops scripts and styles', () => {
  const text = web.htmlToText('<html><style>a{}</style><script>evil()</script><p>Hello &amp; welcome</p></html>');
  assert.equal(text, 'Hello & welcome');
});

test('portfolio maths, with totals kept per currency', () => {
  const result = portfolio.summarize(
    [
      { symbol: 'TCS.NS', quantity: 10, buyPrice: 100 },
      { symbol: 'AAPL', quantity: 2, buyPrice: 50 },
      { symbol: 'BAD', quantity: 1, buyPrice: 1 },
    ],
    {
      'TCS.NS': { price: 120, previousClose: 110, currency: 'INR' },
      AAPL: { price: 40, previousClose: 45, currency: 'USD' },
      BAD: { error: 'Unknown symbol BAD' },
    }
  );
  assert.deepEqual(result.totals.INR, { value: 1200, gain: 200, gainPercent: 20, dayChange: 100 });
  assert.deepEqual(result.totals.USD, { value: 80, gain: -20, gainPercent: -20, dayChange: -10 });
  assert.equal(result.best, 'TCS.NS');
  assert.equal(result.worst, 'AAPL');
  assert.deepEqual(result.failed, [{ symbol: 'BAD', error: 'Unknown symbol BAD' }]);
});

test('every provider is selectable with one setting', () => {
  const saved = process.env.LLM_PROVIDER;
  try {
    for (const [name, host] of [['groq', 'api.groq.com'], ['gemini', 'generativelanguage.googleapis.com'], ['ollama', 'localhost']]) {
      process.env.LLM_PROVIDER = name;
      assert.ok(llm.getProvider().baseUrl.includes(host), name);
    }
    process.env.LLM_PROVIDER = 'nonsense';
    assert.throws(() => llm.getProvider(), /Unknown LLM_PROVIDER/);
  } finally {
    if (saved === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = saved;
  }
});
