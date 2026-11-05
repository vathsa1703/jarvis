# Jarvis

A personal, voice-driven assistant for your Windows PC that costs nothing to run. Talk to it, and it checks the news and your stocks, handles your email, opens things, and hands real coding work to [Claude Code](https://claude.com/claude-code).

## What it can do

| Say something like | What happens |
| --- | --- |
| "What's the latest news?" | Reads headlines from RSS feeds |
| "How's my portfolio doing?" | Live prices, gain or loss and day change, from Yahoo Finance |
| "Look up the best budget laptops" | Searches the web and summarizes |
| "Read my latest emails" | Reads your Gmail |
| "Mail Rahul that I'll be late" | Sends it and shows you a copy |
| "Open my website folder in VS Code and ask Claude to add dark mode" | Opens VS Code and starts Claude Code on the task, connected to VS Code |
| "Find my resume and open it" | Searches your PC and opens the file |
| "What's in my Downloads folder?" | Lists any folder on your PC |
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

Open http://localhost:3000. Press the mic button and start talking, or turn on **Hands-free** and say "hey Jarvis".

## Always on

To have Jarvis waiting whenever you log in or unlock your laptop:

```powershell
npm run autostart
```

This adds a scheduled task for your Windows user, with no admin rights needed. At every login and unlock it starts the server in the background if it isn't running, then opens the Jarvis window or brings it to the front.

In the Jarvis window, click **Hands-free** and allow the microphone. It stays on from then on. While it's on, the browser sends what the mic hears to its speech service (Google, in Chrome) to find the phrase.

## Talking to it

Say "hey Jarvis", then just talk. You don't need the wake word again or any button, because Jarvis keeps listening for 20 seconds after each reply. Say "thanks" or "bye" to end the conversation, or just stop talking. Say "stop" while it's working to cancel.

Prefer not to leave Hands-free on? Press the mic button once to start a conversation in the same way.

It pauses listening while it speaks, so it won't hear you talk over it. Use the **Stop** button, which shows up while it's working, to cut it off.

To undo all of this and close Jarvis:

```powershell
npm run autostart:off
```

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

- **VS Code (default):** opens the folder in VS Code, then starts Claude Code in a terminal connected to it. Claude Code still asks its own permission questions in that terminal, and asks you to trust a folder it hasn't seen before.
- **Visible:** opens only a terminal window you can watch and steer.
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

- **Risky actions need your click.** Running commands, changing existing files, opening unknown programs and removing holdings all show exactly what will happen first. Voice can't approve them, and no answer within 5 minutes counts as no.
- **Everyday actions go straight through, with one exception.** Sending email, creating new files and launching Claude Code don't ask, unless Jarvis read a web page, email, file or command output in that same request. That's when hidden instructions could be steering it, so it shows you first. Sent emails appear on screen as a record. New files that could run by themselves, such as scripts or startup items, always ask.
- **Web, email and file content is labelled as untrusted** when it reaches the model. This lowers the risk but can't remove it, so read approval cards before you click.
- **It only listens on your own machine**, and refuses connections from other websites.
- **File tools reach your whole PC.** Browsing, searching and reading are immediate, but changing a file needs a click, and so does reading anything likely to hold secrets: SSH and cloud keys, browser profiles, `.env` files, credential files and Jarvis's own data. Files Jarvis reads go to your AI provider unless you use `ollama`.
- **Web fetching can't reach private addresses**, such as your router.

Everything personal lives in `data/`, which git ignores: memory, portfolio, contacts and your Gmail token. These files aren't encrypted, so anything running as your Windows user can read them.

## Known limits

- **Groq's free tier is tight.** It allows 8,000 tokens a minute and each request uses about 2,000, so busy moments can pause for several seconds. Jarvis waits and retries by itself, and tells you if the wait would be long. There's also a limit of 1,000 requests a day. Groq retires models from time to time; if yours disappears, change `GROQ_MODEL` in `.env`.
- **Web search can get rate limited.** It scrapes DuckDuckGo's free HTML page, which blocked automated use after a few searches in quick succession during testing. Wait a minute if that happens.
- **Stock prices** come from an unofficial Yahoo Finance endpoint. They can be delayed, and the endpoint could change without notice.
- **Voice input** uses the browser's speech service, so it needs Chrome or Edge, internet access and the window open. If it misses you while another window covers Jarvis, try it with Jarvis visible, and check the **Heard** line under the orb to see what it picked up.
- **Windows only** for now, because the PC tools use PowerShell.

## Tests

```powershell
npm test
```

The tests run the real server against a scripted fake LLM, so they need no API key.

## Roadmap

- [ ] Global hotkey and tray icon
- [ ] Offline voice: Whisper and Piper
- [ ] A more reliable free search provider
- [ ] Morning briefing, reminders, and media and system controls
