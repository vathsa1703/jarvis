// All model, web and email text goes on the page through textContent, never
// innerHTML, so nothing in a reply or a fetched page can run as code.

import { isFiller, isGoodbye, isStopPhrase, parseWake, speechText, splitSentences } from './speech.js';

const $ = (id) => document.getElementById(id);
const orb = $('orb');
const stateLabel = $('state');
const heardLine = $('heard');
const log = $('log');
const input = $('input');
const sendButton = $('send');
const stopButton = $('stop');
const micButton = $('mic');
const handsFreeButton = $('wake');
const voiceButton = $('voice');

const CONVERSATION_MS = 20_000;
const WATCHDOG_MS = 1000;

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
let bootId = null;
let busy = false;
let currentBubble = null;
let pendingConfirms = 0;

// Reply speech
let voiceOn = store.get('jarvis.voice') !== 'off';
let speechQueue = [];
let currentUtterance = null; // Held on purpose: Chrome can lose the end event of one it garbage-collects.
let utteranceStartedAt = 0;
let replyBuffer = '';
let spokeThisReply = false;
let saidWaiting = false;

// Listening
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let handsFree = false;
let conversationUntil = 0;
let recognition = null;
let listenFailures = 0;
let retryAt = 0;
let toldAboutFailure = false;

// ---- State shown on screen

function setState(name, label) {
  orb.className = `orb ${name}`;
  stateLabel.textContent = label;
}

const inConversation = () => Date.now() < conversationUntil;
const isSpeaking = () => currentUtterance !== null || speechQueue.length > 0;

function refreshState() {
  micButton.classList.toggle('active', inConversation());
  if (pendingConfirms > 0) setState('attention', 'Needs your approval');
  else if (busy) setState('thinking', 'Thinking');
  else if (isSpeaking()) setState('speaking', 'Speaking');
  else if (inConversation()) setState('listening', 'Listening, go ahead');
  else if (handsFree) setState('idle', 'Say "hey Jarvis"');
  else setState('idle', 'Standing by');
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

function addCard(className, label, text) {
  const card = document.createElement('section');
  card.className = className;
  if (label) {
    const heading = document.createElement('strong');
    heading.textContent = label;
    card.append(heading);
  }
  card.append(document.createTextNode(text));
  log.append(card);
  currentBubble = null;
  scrollDown();
}

// What the mic picked up goes on screen only. The log records events, never words.
function report(text) {
  console.debug(`[jarvis] ${text}`);
  sendEvent({ type: 'client_log', text });
}

function showHeard(text) {
  heardLine.textContent = text ? `Heard: ${text.trim()}` : '';
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
  speak('I need your approval on screen.');
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
  const done = event.state === 'done';
  addCard(`job ${event.state}`, `Claude Code ${done ? 'finished' : 'failed'} in ${event.folder}`, event.text);
  speak(done ? 'Claude Code has finished. The summary is on screen.' : 'Claude Code ran into a problem. The details are on screen.');
}

function speakFinishedSentences() {
  const { sentences, rest } = splitSentences(replyBuffer);
  replyBuffer = rest;
  sentences.forEach((sentence) => {
    spokeThisReply = true;
    speak(sentence);
  });
}

function flushReplySpeech() {
  speakFinishedSentences();
  if (replyBuffer.trim()) {
    spokeThisReply = true;
    speak(replyBuffer);
  }
  replyBuffer = '';
}

function handleEvent(event) {
  switch (event.type) {
    case 'status':
      // A new server means new code, so pick it up without anyone pressing reload.
      if (bootId && event.boot && event.boot !== bootId) location.reload();
      bootId = event.boot ?? bootId;
      $('brain').textContent = `${event.provider} / ${event.model}`;
      break;
    case 'delta':
      if (!currentBubble) currentBubble = addMessage('jarvis', '');
      currentBubble.textContent += event.text;
      replyBuffer += event.text;
      speakFinishedSentences();
      scrollDown();
      break;
    case 'tool':
      flushReplySpeech();
      addChip(event.name.replaceAll('_', ' '));
      currentBubble = null;
      if (event.name === 'waiting_for_the_free_limit' && !saidWaiting) {
        saidWaiting = true;
        speak('Give me a few seconds.');
      }
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
    case 'notice':
      // A record of anything that went through without an approval card.
      addCard('job', null, event.text);
      break;
    case 'done':
      // Replace the streamed text with the final answer, which drops any
      // "let me check" text the model wrote on the way there.
      if (currentBubble) currentBubble.textContent = event.text;
      else addMessage('jarvis', event.text);
      currentBubble = null;
      flushReplySpeech();
      if (!spokeThisReply) speak(event.text);
      setBusy(false);
      keepConversationOpen();
      break;
    case 'error':
      addMessage('error', event.message);
      currentBubble = null;
      replyBuffer = '';
      if (inConversation()) speak('I hit a problem. The details are on screen.');
      setBusy(false);
      keepConversationOpen();
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
  stopSpeaking();
  if (!sendEvent({ type: 'chat', text: clean })) {
    addMessage('error', "Can't reach the Jarvis server. Is it running?");
    return;
  }
  addMessage('user', clean);
  currentBubble = null;
  spokeThisReply = false;
  saidWaiting = false;
  setBusy(true);
}

// ---- Speaking

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
  const clean = speechText(text || '');
  if (!clean || !voiceOn) return;
  speechQueue.push(clean);
  // Stop listening while talking, or Jarvis would transcribe itself.
  recognition?.abort();
  if (!currentUtterance) speakNext();
}

function speakNext() {
  const text = speechQueue.shift();
  if (text === undefined) {
    currentUtterance = null;
    keepConversationOpen();
    refreshState();
    ensureListening();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  const finished = () => {
    if (currentUtterance === utterance) speakNext();
  };
  utterance.onend = finished;
  utterance.onerror = finished;
  currentUtterance = utterance;
  utteranceStartedAt = Date.now();
  speechSynthesis.speak(utterance);
  refreshState();
}

function stopSpeaking() {
  speechQueue = [];
  currentUtterance = null;
  replyBuffer = '';
  speechSynthesis.cancel();
  refreshState();
}

// ---- Conversation

function chime() {
  try {
    const audio = new AudioContext();
    [660, 880].forEach((frequency, i) => {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      gain.gain.value = 0.05;
      tone.frequency.value = frequency;
      tone.connect(gain).connect(audio.destination);
      tone.start(audio.currentTime + i * 0.08);
      tone.stop(audio.currentTime + i * 0.08 + 0.07);
    });
    setTimeout(() => audio.close(), 500);
  } catch {
    // The chime is only a nicety.
  }
}

function startConversation() {
  if (!inConversation()) {
    report('conversation started');
    chime();
  }
  conversationUntil = Date.now() + CONVERSATION_MS;
  ensureListening();
  refreshState();
}

function keepConversationOpen() {
  if (conversationUntil) conversationUntil = Date.now() + CONVERSATION_MS;
}

function endConversation() {
  conversationUntil = 0;
  showHeard('');
  report('conversation ended');
  ensureListening();
  refreshState();
}

function handleInterim(text) {
  showHeard(text);
  if (inConversation()) keepConversationOpen();
  else if (parseWake(text)) startConversation(); // React before the sentence is even finished.
}

function handleFinal(text) {
  showHeard(text);
  const wake = parseWake(text);
  if (!wake && !inConversation()) return;
  report('speech recognised');
  if (wake) startConversation();
  const said = wake ? wake.command : text.trim();
  if (!said || isFiller(said)) return;

  if (busy || pendingConfirms > 0) {
    if (isStopPhrase(said)) stopEverything();
    return;
  }
  if (isGoodbye(said)) {
    endConversation();
    speak('Anytime.');
    return;
  }
  if (isStopPhrase(said)) {
    stopSpeaking();
    return;
  }
  keepConversationOpen();
  submit(said);
}

function stopEverything() {
  sendEvent({ type: 'stop' });
  stopSpeaking();
  settleAllConfirms('Stopped');
  currentBubble = null;
  setBusy(false);
}

// ---- Listening

function recognitionLanguage() {
  // Browsers report either name for the same timezone.
  if (['Asia/Kolkata', 'Asia/Calcutta'].includes(Intl.DateTimeFormat().resolvedOptions().timeZone)) return 'en-IN';
  return navigator.language || 'en-US';
}

const shouldListen = () => (handsFree || inConversation()) && !isSpeaking();

// The one place that decides whether the mic is on. Everything calls this, and so
// does the watchdog, so no lost browser event can leave Jarvis deaf.
function ensureListening() {
  if (!Recognition) return;
  if (!shouldListen()) {
    recognition?.abort();
    return;
  }
  if (recognition || Date.now() < retryAt) return;
  startRecognizer();
}

function startRecognizer() {
  const rec = new Recognition();
  rec.lang = recognitionLanguage();
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (event) => {
    listenFailures = 0;
    retryAt = 0;
    toldAboutFailure = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const { transcript } = event.results[i][0];
      if (event.results[i].isFinal) handleFinal(transcript);
      else handleInterim(transcript);
    }
  };
  rec.onerror = (event) => {
    // no-speech happens every few seconds of silence, and aborted is usually Jarvis itself.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    report(`recognition error: ${event.error}, page ${document.visibilityState}`);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      addMessage('error', 'Microphone access is blocked. Allow it in the browser and try again.');
      conversationUntil = 0;
      setHandsFree(false);
      return;
    }
    // Keep trying with growing gaps, so a Wi-Fi blip doesn't switch voice off for good.
    listenFailures++;
    retryAt = Date.now() + Math.min(1000 * 2 ** listenFailures, 15_000);
    if (listenFailures >= 3 && !toldAboutFailure) {
      toldAboutFailure = true;
      addMessage('error', event.error === 'audio-capture'
        ? "Chrome can't get audio from your microphone. Check it isn't muted or in use by another app."
        : `Voice keeps failing (${event.error}). It needs an internet connection. I'll keep trying.`);
    }
  };
  rec.onend = () => {
    // An old recognizer ending must not wipe out its replacement.
    if (recognition === rec) recognition = null;
    ensureListening();
  };
  recognition = rec;
  try {
    rec.start();
  } catch {
    recognition = null;
    retryAt = Date.now() + 1000;
  }
}

function watchdog() {
  // Chrome sometimes never reports that speech ended. Don't wait forever.
  if (currentUtterance && !speechSynthesis.speaking && !speechSynthesis.pending && Date.now() - utteranceStartedAt > 1000) {
    report('speech end event lost');
    speakNext();
  }
  if (busy || isSpeaking() || pendingConfirms > 0) keepConversationOpen();
  else if (conversationUntil && !inConversation()) endConversation();
  ensureListening();
  refreshState();
}

function setHandsFree(value) {
  handsFree = value;
  handsFreeButton.setAttribute('aria-pressed', String(value));
  store.set('jarvis.wake', value ? 'on' : 'off');
  report(`hands-free ${value ? 'on' : 'off'}`);
  ensureListening();
  refreshState();
}

// ---- Controls

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(input.value);
  input.value = '';
  input.focus();
});

stopButton.addEventListener('click', stopEverything);

// One press starts a whole conversation. There's nothing to press again.
micButton.addEventListener('click', () => {
  if (inConversation()) {
    stopSpeaking();
    endConversation();
  } else {
    stopSpeaking();
    startConversation();
  }
});

handsFreeButton.addEventListener('click', () => setHandsFree(!handsFree));

voiceButton.setAttribute('aria-pressed', String(voiceOn));
voiceButton.addEventListener('click', () => {
  voiceOn = !voiceOn;
  voiceButton.setAttribute('aria-pressed', String(voiceOn));
  store.set('jarvis.voice', voiceOn ? 'on' : 'off');
  if (!voiceOn) stopSpeaking();
});

$('clear').addEventListener('click', () => {
  sendEvent({ type: 'clear' });
  log.replaceChildren();
  currentBubble = null;
});

document.addEventListener('visibilitychange', () => report(`page ${document.visibilityState}`));

speechSynthesis.getVoices(); // Voices load lazily in some browsers.
connect();

if (!Recognition) {
  micButton.disabled = true;
  handsFreeButton.disabled = true;
  micButton.title = handsFreeButton.title = 'Voice input needs Chrome or Edge';
} else if (store.get('jarvis.wake') === 'on') {
  setHandsFree(true);
}

refreshState();
setInterval(watchdog, WATCHDOG_MS);
input.focus();
