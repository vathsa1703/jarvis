# Jarvis

A personal, voice-driven assistant for your Windows PC that costs nothing to run. Talk to it, and it checks the news and your stocks, handles your email, opens things, and hands real coding work to [Claude Code](https://claude.com/claude-code).

## What it can do

| Say something like | What happens |
| --- | --- |
| "What's the latest news?" | Reads headlines from RSS feeds |
| "How's my portfolio doing?" | Live prices, gain or loss and day change, from Yahoo Finance |
| "Look up the best budget laptops" | Searches the web and summarizes |
| "Read my latest emails" | Reads your Gmail |
| "Mail Rahul that I'll be late" | Drafts it and shows you. It sends only after you approve |
| "Open my website folder and ask Claude to add dark mode" | Launches Claude Code in that folder, after you approve |
| "Open Notepad" / "Open youtube.com" | Opens it |
| "Run git status in PowerShell" | Runs it, after you approve |
| "Remember that I prefer short answers" | Remembers it across restarts |

## Setup

You need [Node.js](https://nodejs.org) 22 or newer, and Chrome or Edge for voice.

```powershell
npm install
copy .env.example .env
```

Get a free key at [console.groq.com/keys](https://console.groq.com/keys) and paste it into `.env` as `GROQ_API_KEY`. Then:

```powershell
npm start
```

Open http://localhost:3000. Use the mic button to talk, or turn on **Wake word** and say "hey Jarvis".

## Choosing a brain

Set `LLM_PROVIDER` in `.env` and restart.

| Provider | Cost | Good for | Trade-off |
| --- | --- | --- | --- |
| `groq` (default) | Free tier | Speed and quality | Your messages and tool results go to Groq, within its rate limits |
| `gemini` | Free tier | A backup | Low free limits; your data goes to Google |
| `ollama` | Free | Privacy and offline use | Needs [Ollama](https://ollama.com) and a decent PC. On 8 GB of RAM with no GPU, use `qwen2.5:3b` and expect slow replies |

**Privacy:** with a cloud provider, whatever Jarvis reads to answer you goes to that provider, including emails, portfolio figures and saved facts. Use `ollama` if that matters for what you're asking.

## Handing work to Claude Code

This needs the [Claude Code](https://claude.com/claude-code) CLI installed and signed in. Usage counts against your own Claude plan, so this one feature isn't free beyond what your plan includes.

- **Visible (default):** opens a terminal window you can watch and steer.
- **Background:** runs out of sight and reports back when it's finished. By default it can't edit files, because nobody is there to approve the prompts. Set `CLAUDE_HEADLESS_PERMISSION_MODE=acceptEdits` in `.env` to let it.

Say "save D:\projects\site as my website" to give a folder a short name.

## Connecting Gmail (optional)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Gmail API**.
2. Set up the **OAuth consent screen** as External, and add your own address as a test user.
3. Create an **OAuth client ID** of type **Web application**, with this redirect URI: `http://localhost:3000/auth/google/callback`
4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart.
5. Open http://localhost:3000/auth/google and sign in.

While the Google app stays in "Testing" status, Google expires the sign-in after 7 days. Repeat step 5 when that happens.

## Stocks

Tell Jarvis "add 10 TCS at 3000", or edit `data/portfolio.json`. Symbols follow Yahoo Finance: `TCS.NS` for NSE India, `AAPL` for US stocks. Totals are kept separate per currency.

## Safety

Jarvis reads web pages and emails, and any of those could contain text trying to trick it. So:

- **Risky actions need your click.** Sending email, running commands, writing files, launching Claude Code, opening unknown programs and removing holdings all show exactly what will happen first. Voice can't approve them, and no answer within 5 minutes counts as no.
- **Web, email and file content is labelled as untrusted** when it reaches the model. This lowers the risk but can't remove it, so read approval cards before you click.
- **It only listens on your own machine**, and refuses connections from other websites.
- **File tools can't leave one folder** (`data/workspace`, or `JARVIS_FILES_DIR`).
- **Web fetching can't reach private addresses**, such as your router.

Everything personal lives in `data/`, which git ignores: memory, portfolio, contacts and your Gmail token. These files aren't encrypted, so anything running as your Windows user can read them.

## Known limits

- **Web search can get rate limited.** It scrapes DuckDuckGo's free HTML page, which blocked automated use after a few searches in quick succession during testing. Wait a minute if that happens.
- **Stock prices** come from an unofficial Yahoo Finance endpoint. They can be delayed, and the endpoint could change without notice.
- **Voice input** uses the browser's speech service, so it needs Chrome or Edge, internet access and the tab open.
- **Windows only** for now, because the PC tools use PowerShell.

## Tests

```powershell
npm test
```

The tests run the real server against a scripted fake LLM, so they need no API key.

## Roadmap

- [ ] Always-on: tray app, start at login, global hotkey
- [ ] Offline voice: Whisper and Piper
- [ ] A more reliable free search provider
- [ ] Morning briefing, reminders, and media and system controls
