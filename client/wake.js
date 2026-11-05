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
