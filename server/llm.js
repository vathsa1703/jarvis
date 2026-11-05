// Groq, Gemini and Ollama all expose the OpenAI chat-completions API, so one
// client covers every provider. Switching brains is a single .env value.

import { setTimeout as sleep } from 'node:timers/promises';

export class LlmError extends Error {}

// Free tiers count tokens per minute, so a short wait usually clears the limit.
// Anything longer, like a used-up daily allowance, is reported instead.
const MAX_RATE_LIMIT_WAIT_SECONDS = 30;
const MAX_RATE_LIMIT_RETRIES = 3;

function retryDelaySeconds(res, body) {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return header;
  const match = body.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!match) return null;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return seconds > 0 ? seconds : null;
}

function describeWait(seconds) {
  if (seconds == null) return 'Wait a little';
  if (seconds < 90) return `Try again in ${Math.ceil(seconds)} seconds`;
  return `Try again in about ${Math.ceil(seconds / 60)} minutes`;
}

function providers() {
  const env = process.env;
  return {
    groq: {
      baseUrl: 'https://api.groq.com/openai/v1',
      keyName: 'GROQ_API_KEY',
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    },
    gemini: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyName: 'GEMINI_API_KEY',
      key: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
    },
    ollama: {
      baseUrl: env.OLLAMA_URL || 'http://localhost:11434/v1',
      model: env.OLLAMA_MODEL || 'qwen2.5:3b',
    },
    custom: {
      baseUrl: env.LLM_BASE_URL,
      key: env.LLM_API_KEY,
      model: env.LLM_MODEL,
    },
  };
}

export function getProvider() {
  const name = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
  const provider = providers()[name];
  if (!provider) {
    throw new LlmError(`Unknown LLM_PROVIDER "${name}". Use groq, gemini, ollama or custom.`);
  }
  return { name, ...provider };
}

function assertUsable(provider) {
  if (provider.keyName && !provider.key) {
    throw new LlmError(
      `${provider.keyName} isn't set. Copy jarvis/.env.example to jarvis/.env, add your free key, and restart Jarvis.`
    );
  }
  if (!provider.baseUrl || !provider.model) {
    throw new LlmError('LLM_PROVIDER=custom needs LLM_BASE_URL and LLM_MODEL in .env.');
  }
}

function describeHttpError(provider, status, body, waitSeconds) {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) return `${provider.name} rejected the API key. Check it in .env.`;
  if (status === 429) return `${provider.name}'s free limit was hit. ${describeWait(waitSeconds)}, or switch LLM_PROVIDER in .env.`;
  if (status === 404) {
    const hint = provider.name === 'ollama' ? `Run: ollama pull ${provider.model}` : 'Change the model name in .env.';
    return `${provider.name} doesn't have the model "${provider.model}". ${hint}`;
  }
  return `${provider.name} returned HTTP ${status}: ${detail}`;
}

// Yields each parsed JSON event from a server-sent-events response.
async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data);
    }
  }
}

function mergeToolCallDeltas(calls, deltas) {
  for (const delta of deltas) {
    let slot = calls[delta.index ?? calls.length];
    // Some servers send several complete calls that all claim index 0.
    if (slot && delta.id && slot.id && delta.id !== slot.id) slot = undefined;
    if (!slot) {
      slot = { id: delta.id, name: '', arguments: '' };
      calls[delta.index != null && !calls[delta.index] ? delta.index : calls.length] = slot;
    }
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) slot.name += delta.function.name;
    if (delta.function?.arguments) slot.arguments += delta.function.arguments;
  }
}

async function streamOnce(provider, { messages, tools, onDelta, signal }) {
  let res;
  try {
    res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        stream: true,
        temperature: 0.3,
      }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const hint = provider.name === 'ollama' ? ' Is Ollama installed and running?' : ' Check your internet connection.';
    throw new LlmError(`Couldn't reach ${provider.name}.${hint}`);
  }

  if (!res.ok) {
    const body = await res.text();
    const waitSeconds = res.status === 429 ? retryDelaySeconds(res, body) : null;
    const err = new LlmError(describeHttpError(provider, res.status, body, waitSeconds));
    err.retryable = body.includes('tool_use_failed');
    err.waitSeconds = waitSeconds;
    throw err;
  }

  let content = '';
  const calls = [];
  for await (const event of readEvents(res.body)) {
    if (event.error) {
      const err = new LlmError(`${provider.name} error: ${event.error.message || JSON.stringify(event.error)}`);
      err.retryable = JSON.stringify(event.error).includes('tool_use_failed');
      throw err;
    }
    const delta = event.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (delta.tool_calls) mergeToolCallDeltas(calls, delta.tool_calls);
  }

  const toolCalls = calls
    .filter(Boolean)
    .map((call, i) => ({ id: call.id || `call_${i}`, name: call.name, arguments: call.arguments }));
  return { content, toolCalls };
}

export async function chat({ messages, tools = [], onDelta, onWait, signal }) {
  const provider = getProvider();
  assertUsable(provider);
  let rateLimitRetries = 0;
  let malformedRetried = false;
  for (;;) {
    try {
      return await streamOnce(provider, { messages, tools, onDelta, signal });
    } catch (err) {
      const canWait =
        err.waitSeconds != null &&
        err.waitSeconds <= MAX_RATE_LIMIT_WAIT_SECONDS &&
        rateLimitRetries < MAX_RATE_LIMIT_RETRIES;
      if (canWait) {
        rateLimitRetries++;
        onWait?.(err.waitSeconds);
        await sleep((err.waitSeconds + 0.5) * 1000, undefined, { signal });
      } else if (err.retryable && !malformedRetried) {
        // Models on Groq sometimes write a malformed tool call. One retry usually clears it.
        malformedRetried = true;
      } else {
        throw err;
      }
    }
  }
}
