import { readJson, writeJson } from './store.js';

const FILE = 'memory.json';
const MAX_HISTORY_TURNS = 10;

const load = () => readJson(FILE, { facts: [], history: [] });

export const getFacts = () => load().facts;
export const getHistory = () => load().history;

export function addTurn(user, assistant) {
  const memory = load();
  memory.history.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
  memory.history = memory.history.slice(-MAX_HISTORY_TURNS * 2);
  writeJson(FILE, memory);
}

export function clearHistory() {
  writeJson(FILE, { ...load(), history: [] });
}

export const memoryTools = [
  {
    name: 'remember',
    description: 'Save a lasting fact about the user, such as their name, a preference or an ongoing project.',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact, as one short sentence' } },
      required: ['fact'],
    },
    run: ({ fact }) => {
      const memory = load();
      const clean = String(fact).trim();
      if (!memory.facts.includes(clean)) memory.facts.push(clean);
      writeJson(FILE, memory);
      return `Remembered: ${clean}`;
    },
  },
  {
    name: 'forget',
    description: 'Delete saved facts that contain the given text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to match' } },
      required: ['text'],
    },
    run: ({ text }) => {
      const needle = String(text).trim().toLowerCase();
      if (!needle) throw new Error('Say which fact to forget.');
      const memory = load();
      const kept = memory.facts.filter((f) => !f.toLowerCase().includes(needle));
      const removed = memory.facts.length - kept.length;
      writeJson(FILE, { ...memory, facts: kept });
      return removed ? `Forgot ${removed} fact(s).` : 'No saved fact matched that.';
    },
  },
];
