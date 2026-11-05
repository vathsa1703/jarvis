import { readJson, writeJson } from '../store.js';

const FILE = 'portfolio.json';
const round = (n) => Math.round(n * 100) / 100;

const loadHoldings = () => readJson(FILE, { holdings: [] }).holdings;
const saveHoldings = (holdings) => writeJson(FILE, { holdings });

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`Unknown symbol ${symbol}`);
  if (!res.ok) throw new Error(`Yahoo Finance returned HTTP ${res.status}`);
  const meta = (await res.json()).chart?.result?.[0]?.meta;
  if (meta?.regularMarketPrice == null) throw new Error(`No price for ${symbol}`);
  return {
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency || 'unknown',
  };
}

// Pure so it can be tested. Totals stay per currency, because adding rupees to
// dollars would produce a meaningless number.
export function summarize(holdings, quotes) {
  const rows = [];
  const failed = [];
  const totals = {};
  for (const h of holdings) {
    const quote = quotes[h.symbol];
    if (!quote || quote.error) {
      failed.push({ symbol: h.symbol, error: quote?.error || 'No quote' });
      continue;
    }
    const value = quote.price * h.quantity;
    const cost = h.buyPrice * h.quantity;
    const dayChange = quote.previousClose == null ? null : (quote.price - quote.previousClose) * h.quantity;
    rows.push({
      symbol: h.symbol,
      quantity: h.quantity,
      buyPrice: h.buyPrice,
      price: round(quote.price),
      currency: quote.currency,
      value: round(value),
      gain: round(value - cost),
      gainPercent: cost ? round(((value - cost) / cost) * 100) : null,
      dayChange: dayChange == null ? null : round(dayChange),
    });
    const total = (totals[quote.currency] ??= { value: 0, cost: 0, dayChange: 0 });
    total.value += value;
    total.cost += cost;
    total.dayChange += dayChange ?? 0;
  }
  const byGain = rows.filter((r) => r.gainPercent != null).sort((a, b) => b.gainPercent - a.gainPercent);
  return {
    holdings: rows,
    totals: Object.fromEntries(
      Object.entries(totals).map(([currency, t]) => [
        currency,
        {
          value: round(t.value),
          gain: round(t.value - t.cost),
          gainPercent: t.cost ? round(((t.value - t.cost) / t.cost) * 100) : null,
          dayChange: round(t.dayChange),
        },
      ])
    ),
    best: byGain[0]?.symbol ?? null,
    worst: byGain.at(-1)?.symbol ?? null,
    failed,
  };
}

export default [
  {
    name: 'portfolio_summary',
    description:
      'Get live prices, value, gain or loss, and day change for the stock portfolio. Prices come from Yahoo Finance and can be delayed.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const holdings = loadHoldings();
      if (!holdings.length) return 'The portfolio is empty. Add holdings first.';
      const symbols = [...new Set(holdings.map((h) => h.symbol))];
      const settled = await Promise.allSettled(symbols.map(fetchQuote));
      const quotes = Object.fromEntries(
        symbols.map((symbol, i) => [
          symbol,
          settled[i].status === 'fulfilled' ? settled[i].value : { error: settled[i].reason.message },
        ])
      );
      return summarize(holdings, quotes);
    },
  },
  {
    name: 'portfolio_add',
    description:
      'Add a stock holding. Use Yahoo Finance symbols: RELIANCE.NS or TCS.NS for NSE India, AAPL for US stocks.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        quantity: { type: 'number' },
        buy_price: { type: 'number', description: 'Price paid per share' },
      },
      required: ['symbol', 'quantity', 'buy_price'],
    },
    run: async ({ symbol, quantity, buy_price }) => {
      const qty = Number(quantity);
      const price = Number(buy_price);
      if (!(qty > 0) || !(price >= 0)) throw new Error('Quantity must be above 0 and the price cannot be negative.');
      const clean = String(symbol).trim().toUpperCase();
      await fetchQuote(clean); // Catches a misheard symbol before it's saved.
      saveHoldings([...loadHoldings(), { symbol: clean, quantity: qty, buyPrice: price }]);
      return `Added ${qty} ${clean} at ${price}.`;
    },
  },
  {
    name: 'portfolio_remove',
    description: 'Remove every holding of a stock from the portfolio. The user must approve it.',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
    confirm: ({ symbol }) => {
      const clean = String(symbol).trim().toUpperCase();
      const matches = loadHoldings().filter((h) => h.symbol === clean);
      if (!matches.length) return null; // Nothing to remove; run() reports that.
      return {
        title: 'Remove from portfolio?',
        details: matches.map((h) => `${h.quantity} ${h.symbol} bought at ${h.buyPrice}`).join('\n'),
      };
    },
    run: ({ symbol }) => {
      const clean = String(symbol).trim().toUpperCase();
      const holdings = loadHoldings();
      const remaining = holdings.filter((h) => h.symbol !== clean);
      if (remaining.length === holdings.length) return `${clean} isn't in the portfolio.`;
      saveHoldings(remaining);
      return `Removed ${clean}.`;
    },
  },
];
