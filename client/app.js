// All model, web and email text goes on the page through textContent, never
// innerHTML, so nothing in a reply or a fetched page can run as code.

import { parseWake } from './wake.js';

const $ = (id) => document.getElementById(id);
const orb = $('orb');
const stateLabel = $('state');
const log = $('log');
const input = $('input');
const sendButton = $('send');
const stopButton = $('stop');
const micButton = $('mic');
const wakeButton = $('wake');
const voiceButton = $('voice');

const STATE_TEXT = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  attention: 'Needs your approval',
};

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* A convenience only. */ }
  },
};

let socket = null;
let reconnectDelay = 500;
let busy = false;
let currentBubble = null;
let pendingConfirms = 0;

function setState(name, label) {
  orb.className = `orb ${name}`;
  stateLabel.textContent = label || STATE_TEXT[name];
}

function refreshState() {
  if (pendingConfirms > 0) setState('attention');
  else if (busy) setState('thinking');
  else if (speechSynthesis.speaking) setState('speaking');
  else if (micActive || armed) setState('listening');
  else if (wakeOn) setState('idle', 'Say "hey Jarvis"');
  else setState('idle');
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  stopButton.hidden = !value;
  refreshState();
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

function addMessage(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  log.append(el);
  scrollDown();
  return el;
}

function addChip(text) {
  const el = document.createElement('div');
  el.className = 'chip';
  el.textContent = text;
  log.append(el);
  scrollDown();
}

// ---- Approval cards. Click only: a voice "yes" could be the TV, or Jarvis itself.

const confirmCards = new Map();

function addConfirm({ id, title, details }) {
  const card = document.createElement('section');
  card.className = 'confirm';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const body = document.createElement('pre');
  body.textContent = details;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const approve = document.createElement('button');
  approve.className = 'approve';
  approve.type = 'button';
  approve.textContent = 'Approve';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = 'Deny';

  const settle = (message) => {
    actions.replaceChildren();
    const result = document.createElement('span');
    result.className = 'result';
    result.textContent = message;
    actions.append(result);
    confirmCards.delete(id);
    pendingConfirms--;
    refreshState();
  };
  const answer = (approved) => {
    sendEvent({ type: 'confirm', id, approved });
    settle(approved ? 'Approved' : 'Denied');
  };
  approve.addEventListener('click', () => answer(true));
  deny.addEventListener('click', () => answer(false));
  confirmCards.set(id, settle);

  actions.append(approve, deny);
  card.append(heading, body, actions);
  log.append(card);
  pendingConfirms++;
  currentBubble = null;
  refreshState();
  scrollDown();
  if (voiceOn) speak('I need your approval on screen.');
}

function settleAllConfirms(message) {
  [...confirmCards.values()].forEach((settle) => settle(message));
}

// ---- Socket

function sendEvent(event) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
    return true;
  }
  return false;
}

function handleJob(event) {
  if (event.state === 'progress') return;
  const card = document.createElement('section');
  card.className = `job ${event.state}`;
  const label = document.createElement('strong');
  label.textContent = event.state === 'done' ? `Claude Code finished in ${event.folder}` : `Claude Code failed in ${event.folder}`;
  card.append(label, document.createTextNode(event.text));
  log.append(card);
  scrollDown();
  if (voiceOn) speak(event.state === 'done' ? 'Claude Code has finished. The summary is on screen.' : 'Claude Code ran into a problem. The details are on screen.');
}

function handleEvent(event) {
  switch (event.type) {
    case 'status':
      $('brain').textContent = `${event.provider} / ${event.model}`;
      break;
    case 'delta':
      if (!currentBubble) currentBubble = addMessage('jarvis', '');
      currentBubble.textContent += event.text;
      scrollDown();
      break;
    case 'tool':
      addChip(event.name.replaceAll('_', ' '));
      currentBubble = null;
      break;
    case 'confirm':
      addConfirm(event);
      break;
    case 'confirm_expired':
      confirmCards.get(event.id)?.('No answer, so this was cancelled');
      break;
    case 'job':
      handleJob(event);
      break;
    case 'notice': {
      // A record of anything that went through without an approval card.
      const card = document.createElement('section');
      card.className = 'job';
      card.textContent = event.text;
      log.append(card);
      currentBubble = null;
      scrollDown();
      break;
    }
    case 'done':
      // Replace the streamed text with the final answer, which drops any
      // "let me check" text the model wrote on the way there.
      if (currentBubble) currentBubble.textContent = event.text;
      else addMessage('jarvis', event.text);
      currentBubble = null;
      setBusy(false);
      if (voiceOn) speak(event.text);
      break;
    case 'error':
      addMessage('error', event.message);
      currentBubble = null;
      setBusy(false);
      break;
  }
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener('open', () => {
    reconnectDelay = 500;
  });
  socket.addEventListener('message', (message) => handleEvent(JSON.parse(message.data)));
  socket.addEventListener('close', () => {
    $('brain').textContent = 'offline, reconnecting…';
    // The server denies open approvals when a socket drops, so the cards must say so too.
    settleAllConfirms('Connection lost, so this was cancelled');
    setBusy(false);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });
}

function submit(text) {
  const clean = text.trim();
  if (!clean || busy) return;
  speechSynthesis.cancel();
  if (!sendEvent({ type: 'chat', text: clean })) {
    addMessage('error', "Can't reach the Jarvis server. Is it running?");
    return;
  }
  addMessage('user', clean);
  currentBubble = null;
  setBusy(true);
}

// ---- Speaking

let voiceOn = store.get('jarvis.voice') !== 'off';

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const english = voices.filter((v) => v.lang?.startsWith('en'));
  return (
    english.find((v) => /ryan|george|daniel|guy|david/i.test(v.name) && /GB|natural/i.test(`${v.lang} ${v.name}`)) ||
    english.find((v) => /en-GB/i.test(v.lang)) ||
    english[0] ||
    null
  );
}

function speak(text) {
  if (!text) return;
  // Stop listening while talking, or Jarvis would transcribe itself.
  pauseRecognition();
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  utterance.onstart = refreshState;
  const finished = () => {
    refreshState();
    resumeRecognition();
  };
  utterance.onend = finished;
  utterance.onerror = finished;
  speechSynthesis.speak(utterance);
}

// ---- Listening

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const ARM_WINDOW_MS = 8000;
const heardLine = $('heard');

// What the mic picked up goes on screen only. The log records events, never words.
function report(text) {
  console.debug(`[jarvis] ${text}`);
  sendEvent({ type: 'client_log', text });
}

function showHeard(text) {
  heardLine.textContent = text ? `Heard: ${text.trim()}` : '';
}

function recognitionLanguage() {
  // Browsers report either name for the same timezone.
  if (['Asia/Kolkata', 'Asia/Calcutta'].includes(Intl.DateTimeFormat().resolvedOptions().timeZone)) return 'en-IN';
  return navigator.language || 'en-US';
}

let recognition = null;
let micActive = false;   // one-shot, from the mic button
let wakeOn = false;      // continuous, listening for the wake phrase
let armed = false;       // heard "jarvis", waiting for the actual request
let armTimer = null;
let wakeFailures = 0;

function setArmed(value) {
  armed = value;
  clearTimeout(armTimer);
  if (value) armTimer = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
  refreshState();
}

function handleTranscript(text) {
  if (micActive) {
    stopRecognition();
    submit(text);
    return;
  }
  const wake = parseWake(text);
  if (wake) {
    report('wake phrase detected');
    if (wake.command) {
      setArmed(false);
      submit(wake.command);
    } else {
      setArmed(true);
    }
  } else if (armed) {
    setArmed(false);
    submit(text);
  }
}

function startRecognition(continuous) {
  if (!Recognition || recognition) return;
  const rec = new Recognition();
  rec.lang = recognitionLanguage();
  rec.continuous = continuous;
  rec.interimResults = true;
  rec.onstart = () => report(`listening (${continuous ? 'wake word' : 'mic button'}, ${rec.lang}, page ${document.visibilityState})`);
  rec.onresult = (event) => {
    wakeFailures = 0;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const { transcript } = event.results[i][0];
      showHeard(transcript);
      if (event.results[i].isFinal) {
        report('speech recognised');
        handleTranscript(transcript);
      } else if (parseWake(transcript)) {
        setState('listening'); // Instant feedback, before the sentence is finished.
      }
    }
  };
  rec.onerror = (event) => {
    report(`recognition error: ${event.error}, page ${document.visibilityState}`);
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    wakeFailures++;
    if (event.error === 'audio-capture') {
      addMessage('error', "Chrome can't get audio from your microphone. Check that it isn't muted or in use by another app.");
      setWake(false);
      return;
    }
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      addMessage('error', 'Microphone access is blocked. Allow it in the browser and try again.');
      setWake(false);
    } else if (wakeFailures >= 3) {
      addMessage('error', `Speech recognition keeps failing (${event.error}). It needs Chrome or Edge and an internet connection.`);
      setWake(false);
    }
  };
  rec.onend = () => {
    report(`stopped listening, page ${document.visibilityState}`);
    recognition = null;
    if (micActive) {
      micActive = false;
      micButton.classList.remove('active');
    }
    refreshState();
    resumeRecognition();
  };
  recognition = rec;
  try {
    rec.start();
  } catch {
    recognition = null;
  }
}

function stopRecognition() {
  micActive = false;
  micButton.classList.remove('active');
  recognition?.stop();
  refreshState();
}

function pauseRecognition() {
  recognition?.abort();
}

function resumeRecognition() {
  // The browser ends recognition by itself every so often. Keep it going in wake mode.
  if (wakeOn && !recognition && !micActive && !speechSynthesis.speaking) {
    setTimeout(() => {
      if (wakeOn && !recognition && !speechSynthesis.speaking) startRecognition(true);
    }, 250 * (wakeFailures + 1));
  }
}

function setWake(value) {
  wakeOn = value;
  wakeButton.setAttribute('aria-pressed', String(value));
  store.set('jarvis.wake', value ? 'on' : 'off');
  if (value) startRecognition(true);
  else {
    setArmed(false);
    recognition?.abort();
  }
  refreshState();
}

// ---- Controls

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(input.value);
  input.value = '';
  input.focus();
});

stopButton.addEventListener('click', () => {
  sendEvent({ type: 'stop' });
  speechSynthesis.cancel();
  settleAllConfirms('Stopped');
  currentBubble = null;
  setBusy(false);
});

micButton.addEventListener('click', () => {
  if (micActive) return stopRecognition();
  speechSynthesis.cancel();
  // The recognizer in use may be the wake-word one; swap it for a one-shot.
  recognition?.abort();
  recognition = null;
  micActive = true;
  micButton.classList.add('active');
  refreshState();
  startRecognition(false);
});

wakeButton.addEventListener('click', () => setWake(!wakeOn));

voiceButton.setAttribute('aria-pressed', String(voiceOn));
voiceButton.addEventListener('click', () => {
  voiceOn = !voiceOn;
  voiceButton.setAttribute('aria-pressed', String(voiceOn));
  store.set('jarvis.voice', voiceOn ? 'on' : 'off');
  if (!voiceOn) speechSynthesis.cancel();
});

$('clear').addEventListener('click', () => {
  sendEvent({ type: 'clear' });
  log.replaceChildren();
  currentBubble = null;
});

if (!Recognition) {
  micButton.disabled = true;
  wakeButton.disabled = true;
  micButton.title = wakeButton.title = 'Voice input needs Chrome or Edge';
} else if (store.get('jarvis.wake') === 'on') {
  setWake(true);
}

document.addEventListener('visibilitychange', () => report(`page ${document.visibilityState}`));

speechSynthesis.getVoices(); // Voices load lazily in some browsers.
refreshState();
connect();
input.focus();
