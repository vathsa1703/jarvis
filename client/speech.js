// The parts of voice handling that are just text, kept separate so they can be tested.

// Speech recognition often mishears "Jarvis", especially across accents. Close
// spellings count on their own. Real words like "Travis" only count after "hey",
// so talking about someone called Travis doesn't set Jarvis off.
const GREETING = '(?:hey|hi|hay|ok|okay|yo)';
const CLOSE = '(?:jarvis|jarvish|jervis|jarves|jarwis|jarvas|javis|charvis)';
const LOOSE = '(?:travis|davis|harvis|garvis|jarvie)';
const WAKE_PATTERN = new RegExp(
  `\\b(?:(?:${GREETING}\\s+)?${CLOSE}|${GREETING}\\s+${LOOSE})\\b[\\s,.!?]*(.*)$`,
  'i'
);

// Returns null if the wake phrase wasn't said, otherwise whatever came after it.
export function parseWake(transcript) {
  const match = transcript.match(WAKE_PATTERN);
  return match ? { command: match[1].trim() } : null;
}

// These have to be the whole sentence, so "thanks, now open Excel" keeps going.
export const isGoodbye = (text) =>
  /^(?:ok(?:ay)?\s+)?(?:thanks|thank you|that's all|that is all|that's it|bye|goodbye|go to sleep|stop listening)(?:\s+jarvis)?[.!]?$/i.test(text.trim());

export const isStopPhrase = (text) => /^(?:stop|cancel|never ?mind)(?:\s+jarvis)?[.!]?$/i.test(text.trim());

export const isFiller = (text) => /^(?:u+m+|u+h+|h+m+|m+|a+h+|o+h+)[.!?]?$/i.test(text.trim());

// Makes model text sound right when read aloud.
export function speechText(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/[`*#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Splits streamed text into finished sentences plus whatever is still arriving. A
// boundary needs a space or line break after it, so "3.5" and "6:05" stay whole.
export function splitSentences(buffer) {
  const sentences = [];
  const boundary = /[.!?…]+["')\]]*\s+|\n+/g;
  let start = 0;
  let match;
  while ((match = boundary.exec(buffer))) {
    const end = match.index + match[0].length;
    const sentence = buffer.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  return { sentences, rest: buffer.slice(start) };
}
