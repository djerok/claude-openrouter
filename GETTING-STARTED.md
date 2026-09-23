# Getting started, from nothing

This guide assumes **nothing is installed** and that you may never have used a terminal
before. Follow it top to bottom. Every command is meant to be copied and pasted exactly.

Total time: about 15 minutes, most of it waiting for downloads. The install itself is a
single command — most of this guide is getting your machine ready to run it.

---

## What you are building

Claude Code is a coding assistant that runs in your terminal and in VSCode. Normally it
talks to Anthropic's servers and bills your Anthropic account. After this guide it will
talk to **OpenRouter** instead, which lets you use models like MiMo and GPT-6 Luna and pay
per use.

Three pieces are involved:

```
  Claude Code  ──►  OpenRouter  ──►  the actual model
  (what you type)   (a website that   (MiMo, Luna, …)
                     resells models)
```

That is the whole thing. Nothing runs in the background. `setup.js` tells Claude Code to
send its questions to OpenRouter instead of to Anthropic, and that is all it does.

---

## Step 1 — Open a terminal

A terminal is a window where you type commands instead of clicking.

**Windows**
Press `Win` (the Windows key), type `powershell`, press `Enter`.
A dark blue window opens. That is your terminal.

**macOS**
Press `Cmd` + `Space`, type `terminal`, press `Enter`.

**Linux**
Press `Ctrl` + `Alt` + `T`.

> Keep this window open for the whole guide. If you close it by accident, just open it again.

To paste into a terminal: **Windows** right-click, or `Ctrl`+`V`. **macOS** `Cmd`+`V`.
**Linux** `Ctrl`+`Shift`+`V`.

---

## Step 2 — Get an OpenRouter API key

An API key is a long password that lets the script use models on your behalf.

1. Go to <https://openrouter.ai> and sign in (Google/GitHub sign-in works).
2. Add credit: <https://openrouter.ai/settings/credits>. **$5 is plenty to start.** The two
   models this sets up are inexpensive, but they are not free — without credit every request
   fails.
3. Create a key: <https://openrouter.ai/keys> → **Create Key** → give it any name → **Create**.
4. **Copy it now.** It looks like `sk-or-v1-` followed by a long string of letters and
   numbers. OpenRouter shows it exactly once; if you lose it, delete it and make another.

Paste it somewhere safe for the next two minutes. Treat it like a password — anyone who has
it can spend your credit.

---

## Step 3 — Run one command

This installs everything, Node included. Paste the line for your computer, with the key
you just copied.

**Windows**

```powershell
$env:OPENROUTER_API_KEY="sk-or-v1-YOUR-KEY-HERE"; irm https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.ps1 | iex
```

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.sh | sh -s -- --key sk-or-v1-YOUR-KEY-HERE
```

That is it. The next section shows what it prints.

Worked? Skip to **Step 5**. If it failed, Step 4 is the manual version of the same thing.

---

## Step 4 — Doing it by hand (only if Step 3 failed)

### Install Node.js

Node.js is the program that runs `setup.js`. Check whether you already have it — paste this
and press `Enter`:

```sh
node --version
```

- If you see something like `v22.11.0` and the number after `v` is **18 or higher**, skip
  ahead to "Then run the setup".
- If you see `command not found` or `'node' is not recognized`, install it:

**Windows**

```powershell
winget install OpenJS.NodeJS.LTS
```

Then **close the terminal window and open a new one** — this is required, the new program is
not visible to the old window. Run `node --version` again to confirm.

> If `winget` is not available, download the LTS installer from <https://nodejs.org> and
> click through it with all the default options.

**macOS**

```sh
brew install node
```

> If `brew` is not found, either install Homebrew from <https://brew.sh>, or just download
> the macOS installer from <https://nodejs.org>.

**Linux (Debian/Ubuntu)**

```sh
sudo apt update && sudo apt install -y nodejs npm
```

> If that gives you a version below 18, use the official instructions at
> <https://github.com/nodesource/distributions>.

---

### Then run the setup

There is nothing to download. Replace `sk-or-v1-YOUR-KEY-HERE` with the key you copied in
Step 3, then paste this and press `Enter`:

```sh
npx --allow-git=root github:djerok/claude-openrouter --key sk-or-v1-YOUR-KEY-HERE
```

`npx` comes with Node, and fetches the program straight from GitHub each time you run it.
The first time it may ask `Ok to proceed? (y)` — type `y` and press `Enter`.

> **Why the `--allow-git=root` part?** Newer versions of npm refuse to fetch anything from a
> git host unless you say so. That flag says "the one thing I named is fine" — it does not
> switch the protection off for anything else. Leave it in. On older npm it is harmlessly
> ignored.

This takes a few minutes. It prints numbered steps as it goes. It will:

1. check your Node version
2. install Claude Code if you do not have it (this is the slow part)
3. look up the models on OpenRouter to make sure they still exist
4. write its settings file, backing up anything already there
5. **send one real test message** and show you the reply

Success looks like this at the end:

```
Done.

  CLI:     open a NEW terminal and run  claude
  VSCode:  reload the window (Ctrl+Shift+P → "Developer: Reload Window")
```

If it stops with a red `fatal:` line, read it — it says what to do next. See
[Troubleshooting](#troubleshooting) below.

---

## Step 5 — Use it in the terminal

**Open a brand-new terminal window** (the settings do not apply to the one you just used),
then:

```sh
claude
```

The first time, Claude Code may ask you to pick a theme and accept its terms. Say yes.

Type a question and press `Enter`. At the bottom of the screen you will see a line like:

```
● mimo-v2.6-pro (default) | high | ccr-openrouter | main | $0.0002
```

That is the statusline, and it is telling you the truth about which model answered.

> **The top of the screen may still show a Claude name.** That part of the screen is not
> controlled by these settings. Trust the bottom line, not the top.

To leave, type `/exit` or press `Ctrl`+`C` twice.

---

## Step 6 — Use it in VSCode

1. Install VSCode from <https://code.visualstudio.com> if you do not have it.
2. Open VSCode, click the **Extensions** icon in the left bar (four squares), search for
   **Claude Code**, click **Install**.
3. Press `Ctrl`+`Shift`+`P` (`Cmd`+`Shift`+`P` on macOS), type `Developer: Reload Window`,
   press `Enter`. **This step matters** — without it the extension is still using the old
   settings.
4. Open the Claude Code panel and ask it something. The same statusline appears at the
   bottom.

Nothing else needs configuring. The extension reads the same settings file the terminal
does, which is why one setup covered both.

---

## Everyday commands

Same shape as the install — `npx` again, from any folder:

```sh
npx --allow-git=root github:djerok/claude-openrouter --status      # what is routed where, is the router running
npx --allow-git=root github:djerok/claude-openrouter --off         # switch back to your normal Anthropic account
npx --allow-git=root github:djerok/claude-openrouter --on          # switch back to OpenRouter
npx --allow-git=root github:djerok/claude-openrouter --uninstall   # undo everything, restore your original settings
```

After `--off` or `--on`, open a new terminal / reload VSCode for it to take effect.

Two models are set up. MiMo answers everything. When you want the other one, GPT-6 Luna,
type this inside Claude Code:

```
/model opus
```

That switches to Luna. `/model sonnet` puts you back on MiMo.

---

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `'node' is not recognized` / `command not found: node` | Node is not installed, or the terminal was open before you installed it | Close the terminal, open a new one, try again. Still failing → redo Step 2 |
| `Node vX is too old` | Node is installed but below version 18 | Install the LTS version from <https://nodejs.org> |
| `npx` asks `Ok to proceed? (y)` | Normal — it is confirming the download | Type `y`, press `Enter` |
| `npm error code EALLOWGIT` | You left out `--allow-git=root` | Re-run with the full command exactly as written above |
| `npm warn invalid config allow-git` | Your npm is older and does not know the flag | Harmless — it still ran. Ignore it |
| `npm install -g ... failed` on Windows | No permission to write to the global folder | Right-click PowerShell → **Run as Administrator**, then re-run the setup |
| The statusline is blank or garbled | Your terminal cannot draw the symbols | Harmless. Windows users: use **Windows Terminal** rather than the old console window |
| The header says "Sonnet" | Expected | Hardcoded in Claude Code. The bottom statusline is the real one |

### Ask the setup what is wrong

```sh
npx --allow-git=root github:djerok/claude-openrouter --doctor
```

It changes nothing. It prints your Node and npm versions, whether Claude Code and the
router are installed and actually runnable, which config files exist, whether the router is
listening, and whether OpenRouter is reachable from your network. **It prints no keys**, so
it is safe to paste into an issue.

Still stuck? Open an issue at
<https://github.com/djerok/claude-openrouter/issues> and paste the full output — but **delete
your API key from anything you paste.**

---

## The three operating systems, side by side

Everything above works on all three. This is the same information collected in one place.

| | **Windows** | **macOS** | **Linux** |
|---|---|---|---|
| Open a terminal | `Win` → type `powershell` → `Enter` | `Cmd`+`Space` → `terminal` → `Enter` | `Ctrl`+`Alt`+`T` |
| Paste | right-click, or `Ctrl`+`V` | `Cmd`+`V` | `Ctrl`+`Shift`+`V` |
| Install Node | `winget install OpenJS.NodeJS.LTS` | `brew install node` | `sudo apt install -y nodejs npm` |
| Node fallback | installer from <https://nodejs.org> | installer from <https://nodejs.org> | <https://github.com/nodesource/distributions> |
| Fix `npm -g` permission errors | reopen PowerShell as **Administrator** | prefix with `sudo` | prefix with `sudo` |
| Your home folder (`~`) | `C:\Users\YourName` | `/Users/YourName` | `/home/yourname` |
| VSCode reload | `Ctrl`+`Shift`+`P` → Developer: Reload Window | `Cmd`+`Shift`+`P` → same | `Ctrl`+`Shift`+`P` → same |
| Stop Claude Code | `Ctrl`+`C` twice, or `/exit` | `Ctrl`+`C` twice, or `/exit` | `Ctrl`+`C` twice, or `/exit` |

**No background service.** Nothing has to be running for this to work, on any of the three
systems. If something looks wrong, ask the setup to check itself:

```sh
npx --allow-git=root github:djerok/claude-openrouter --doctor
```

---

## Where things ended up

| File | Purpose |
|---|---|
| `<file>.bak.<timestamp>` | A backup of anything the setup replaced |

`~` means your home folder: `C:\Users\YourName` on Windows, `/Users/YourName` on macOS,
`/home/yourname` on Linux.

## One safety note

Your OpenRouter key is stored in `~/.claude/settings.json` on your own computer.
That is normal — it has to live somewhere for the router to use it. But:

- **Never** paste that file, or your key, into a chat, a screenshot, or a GitHub issue.
- If you think it leaked, delete the key at <https://openrouter.ai/keys> and make a new one.
  A leaked key costs you money until you do.
