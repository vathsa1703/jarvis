import dns from 'node:dns/promises';
import net from 'node:net';
import { parseWebUrl } from './system.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE_LIMIT = 8_000;
const MAX_REDIRECTS = 5;

const DEFAULT_FEEDS = [
  'https://feeds.bbci.co.uk/news/rss.xml',
  'https://www.thehindu.com/news/national/feeder/default.rss',
  'https://techcrunch.com/feed/',
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function htmlToText(html) {
  return stripTags(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' ')
  );
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    if (net.isIPv4(mapped)) return isPrivateAddress(mapped);
    // new URL() rewrites ::ffff:127.0.0.1 to the hex form ::ffff:7f00:1.
    const groups = mapped.split(':').map((g) => parseInt(g, 16));
    if (groups.length !== 2 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return true;
    const [high, low] = groups;
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

// The model chooses these URLs, possibly on instruction from a page it just read.
// Blocking private addresses keeps it away from your router and local services.
export async function assertPublicUrl(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`Refusing to fetch ${url.hostname}: it's a private network address.`);
  }
}

async function fetchPublic(rawUrl, options = {}) {
  let url = parseWebUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': USER_AGENT, ...options.headers },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = parseWebUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw new Error(`${url.hostname} returned HTTP ${res.status}.`);
    return res;
  }
  throw new Error('Too many redirects.');
}

export function parseSearchResults(html) {
  const results = [];
  const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetPattern)].map((m) => stripTags(m[1]));
  let i = 0;
  for (const [, href, title] of html.matchAll(linkPattern)) {
    let url = decodeEntities(href);
    if (url.startsWith('//')) url = `https:${url}`;
    try {
      const parsed = new URL(url);
      // DuckDuckGo wraps results in a redirect, with the real URL in "uddg". Its
      // sponsored results go through a separate y.js path, so those are skipped.
      if (parsed.hostname.endsWith('duckduckgo.com')) {
        const real = parsed.searchParams.get('uddg');
        if (!real) { i++; continue; }
        url = real;
      }
    } catch {
      i++;
      continue;
    }
    results.push({ title: stripTags(title), url, snippet: snippets[i] || '' });
    i++;
  }
  return results;
}

export function parseFeed(xml, limit) {
  const field = (block, tag) => {
    const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!match) return '';
    return stripTags(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  };
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, limit).map(([block]) => ({
    title: field(block, 'title'),
    link: field(block, 'link'),
    published: field(block, 'pubDate'),
    summary: field(block, 'description').slice(0, 200),
  }));
}

async function searchRequest(suffix, options = {}) {
  const res = await fetch(`https://html.duckduckgo.com/html/${suffix}`, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}.`);
  return res.text();
}

function configuredFeeds() {
  const custom = process.env.NEWS_FEEDS?.split(',').map((f) => f.trim()).filter(Boolean);
  return custom?.length ? custom : DEFAULT_FEEDS;
}

export default [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and snippets. Use fetch_page to read a result in full.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
    untrusted: true,
    run: async ({ query }) => {
      // DuckDuckGo sometimes answers one request style with a bot challenge
      // (HTTP 202 and no results) while the other still works.
      const attempts = [
        () => searchRequest(`?${new URLSearchParams({ q: query })}`),
        () => searchRequest('', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: query }) }),
      ];
      for (const attempt of attempts) {
        const results = parseSearchResults(await attempt()).slice(0, 6);
        if (results.length) return results;
      }
      throw new Error('DuckDuckGo gave no results, possibly a temporary block on automated searches. Try again in a minute.');
    },
  },
  {
    name: 'fetch_page',
    description: 'Fetch a public web page and return its text.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http or https URL' } },
      required: ['url'],
    },
    untrusted: true,
    run: async ({ url }) => {
      const res = await fetchPublic(url);
      const type = res.headers.get('content-type') || '';
      if (!/text|html|json|xml/i.test(type)) throw new Error(`Can't read this content type: ${type || 'unknown'}.`);
      return htmlToText(await res.text()).slice(0, PAGE_LIMIT);
    },
  },
  {
    name: 'get_news',
    description: 'Get the latest news headlines from the configured RSS feeds.',
    parameters: {
      type: 'object',
      properties: { per_feed: { type: 'integer', description: 'Headlines per feed, default 5' } },
    },
    untrusted: true,
    run: async ({ per_feed }) => {
      const limit = Math.min(Math.max(Number(per_feed) || 5, 1), 15);
      const feeds = configuredFeeds();
      const settled = await Promise.allSettled(
        feeds.map(async (feed) => parseFeed(await (await fetchPublic(feed)).text(), limit))
      );
      const output = settled.map((result, i) => ({
        feed: new URL(feeds[i]).hostname,
        ...(result.status === 'fulfilled' ? { items: result.value } : { error: result.reason.message }),
      }));
      if (output.every((o) => o.error)) throw new Error(`All news feeds failed: ${output[0].error}`);
      return output;
    },
  },
];
