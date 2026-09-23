# claude-openrouter

Point Claude Code — the CLI **and** the VSCode extension — at OpenRouter models.

One command. It installs everything it needs, including Node.

**Windows** — PowerShell:

```powershell
$env:OPENROUTER_API_KEY="sk-or-v1-..."; irm https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.ps1 | iex
```

**macOS / Linux** — Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.sh | sh -s -- --key sk-or-v1-...
```

That is the whole install on a machine with nothing on it. Get a key first at
<https://openrouter.ai/keys> and put a few dollars of credit on it.

<details>
<summary>Already have Node 18+? There is a shorter way.</summary>

```sh
npx --allow-git=root github:djerok/claude-openrouter --key sk-or-v1-...
```

`--allow-git=root` is needed on npm 11+, where git-backed packages are blocked by default
(`EALLOWGIT`). It allows only the package you named and still blocks git-backed
dependencies. Older npm ignores the flag with a warning.

</details>

Node >= 18 (installed for you if missing), no npm dependencies, Windows / macOS / Linux.

New to all of this? → **[GETTING-STARTED.md](GETTING-STARTED.md)**, written from a blank machine.

## How it works

OpenRouter serves the **Anthropic Messages API natively** at
`https://openrouter.ai/api/v1/messages`. Claude Code already speaks that. So the whole
integration is a handful of environment variables in `~/.claude/settings.json`:

```jsonc
"env": {
  "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
  "ANTHROPIC_AUTH_TOKEN": "sk-or-v1-...",
  "ANTHROPIC_MODEL": "xiaomi/mimo-v2.6-pro",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "openai/gpt-6-luna"
}
```

**There is no proxy, no daemon, no port and nothing to keep running.**

Claude Code applies its `env` block to every session it starts, which is why one file
covers the terminal and the VSCode extension. Shell aliases — the usual advice — silently
miss the extension.

> **Earlier versions of this routed through [Claude Code Router](https://github.com/musistudio/claude-code-router).**
> That meant a native SQLite dependency, a background service, a port, and an autostart
> entry, and every one of those was a way for the install to fail on someone's machine.
> CCR 3.x also moved its config into a SQLite database, so the JSON config written by older
> versions of this script stopped being read at all. None of it was needed. The repo was
> called `ccr-openrouter` while that was true; GitHub redirects the old URL.

## Models

| slot | model | when |
|---|---|---|
| default, background | `xiaomi/mimo-v2.6-pro` | everything |
| `/model opus` | `openai/gpt-6-luna` | the alternative |

The default is **not** the cheaper one. MiMo is $0.435/M in, $0.87/M out; Luna is $0.10/M
in, $0.50/M out (2026-09-22). Slot `a` in the `WANTED` table is the default by choice, and
price only decides which the installer labels cheap. Both accept images.

`--reliable` still means "make the pricier model the default", which with these two is
already the case. `--cheap` is accepted and does nothing, so scripts written for earlier
defaults still work.

**Known rough edge on the previous default.** Everything below was measured on
`deepseek/deepseek-v4-flash-0731`, the default before 2026-09-22. It has not been measured
on MiMo or Luna yet. DeepSeek occasionally ended a tool-using turn in Claude Code with
no text at all — the tool runs, the turn ends normally, nothing is printed. Claude Code's
debug log shows it exactly:

```
[Stall] tool_dispatch_end tool=Bash outcome=ok durationMs=1074
[engine] turn 1 end (turns=3 ... stop=end_turn resultLen=0)
```

A normal stop, zero characters of output, after a tool call that succeeded.

| measurement | result |
|---|---|
| through Claude Code, tool-using turns | roughly 1 in 10 (small sample) |
| direct API, two-step tool exchange, 60 trials | **0/60** |
| `z-ai/glm-5.3-flash` through Claude Code | 0/6 |

It does not reproduce against the API at all, so whatever triggers it needs the larger and
more complex exchange Claude Code really sends. Re-asking worked.

**This number has been wrong twice in this file, in both directions.** It was first
published as 4 in 10, measured while a hook shipped by this project was failing on every
turn because the generated file was not valid JavaScript. It was then published as 2% at
the API, which was a bug in the measurement: the probe answered only the first tool call
when the model had made two, leaving a malformed conversation the model quite reasonably
kept trying to resolve. With every tool call answered, the API figure is 0/60.

Two candidate fixes were tested and rejected rather than shipped on a hunch:

- **Instructing the model always to answer.** A system-prompt line saying never to end a
  turn without text: 1/20 with it, 1/20 without.
- **Blaming one upstream provider.** OpenRouter's response carries a `provider` field, so
  failures can be attributed. Every trial on this key was served by the same provider, so
  there is no bad backend to route around.

Extended thinking is disabled (`MAX_THINKING_TOKENS=0`), which makes the empty-answer case
markedly rarer: OpenRouter returns thinking blocks with an empty signature, and once one is
echoed back in the history the model stops emitting text. It is also a large saving — in a
measured request 57 of 63 output tokens were thinking.

Edit the `WANTED` table at the top of `setup.js` for different models.

### Images and screenshots

Both current models accept images. If you put a text-only model in the `WANTED` table, this
is the part that catches people out: **one image anywhere in the conversation breaks every later turn**, not
just the turn it was pasted into. Claude Code resends the whole history each turn, so once
an image is in there the request keeps failing even when your latest message is plain text.

Measured against `deepseek/deepseek-v4-flash-0731`, the text-only previous default:

| request | result |
|---|---|
| text only, no image anywhere | HTTP 200 |
| image in this turn | HTTP 404 `No endpoints found that support image input` |
| image in an **earlier** turn, this turn text | HTTP 404 — same failure |
| image inside a tool result | HTTP 404 — same failure |

If you hit it, `/clear` gets you working again, because it drops the history holding the
image.

`API Error 400: "Could not process image"` is a **different** error and does not come from
OpenRouter. Its image failures read differently — `Invalid image data URL in
messages[].content[].image_url.url` for undecodable data, `Received 404 status code when
fetching image from URL` for an unreachable one. A 400 with that wording is raised before
the request leaves the client, so it points at the image itself: too large, or in a format
Claude Code could not encode.

### Caching

Nothing to configure for Luna. Per OpenRouter's docs, *"Prompt caching with OpenAI is
automated and does not require any additional configuration."* The same page does not
mention Xiaomi, so whether MiMo caches has not been confirmed — the statusline's cache hit
rate is the way to check. `cache_control` breakpoints are only needed for Anthropic, Qwen
and Gemini models, which this never routes to.

## What the installer does

1. Installs Claude Code if it is missing.
2. Resolves both model slugs against the **live** catalogue, so a retired model fails at
   install time instead of on your first prompt.
3. Puts `WANTED.a` in the default slot and `WANTED.b` in the opus slot.
4. Writes `~/.claude/settings.json` (backing up whatever was there).
5. Writes a statusline that names the model actually in use.
6. Writes a plain-language `~/.claude/CLAUDE.md` — see below.
7. Sends one real request and shows you the reply. A config that writes but does not work
   is a failed install, and you should learn that now.

## Manual setup, without the script

Everything the installer does to route Claude Code is a block of environment variables. If
you would rather do it by hand, or need the values for another tool, this is all of it.

**Endpoint**

| | |
|---|---|
| host | `openrouter.ai` |
| base URL | `https://openrouter.ai/api` |
| messages endpoint | `https://openrouter.ai/api/v1/messages` |
| models endpoint | `https://openrouter.ai/api/v1/models` |
| key / usage endpoint | `https://openrouter.ai/api/v1/key` |
| protocol | the Anthropic Messages API, natively — no translation layer |
| auth header | `Authorization: Bearer sk-or-v1-...` |
| version header | `anthropic-version: 2023-06-01` |

Claude Code appends `/v1/messages` itself, so `ANTHROPIC_BASE_URL` must be the **base**
(`https://openrouter.ai/api`) and not the full messages URL.

**Settings file**

| OS | path |
|---|---|
| Windows | `C:\Users\<you>\.claude\settings.json` |
| macOS | `/Users/<you>/.claude/settings.json` |
| Linux | `/home/<you>/.claude/settings.json` |

Paste this in, replacing the key. Claude Code applies `env` to every session it starts,
which is why one file covers the CLI and the VSCode extension at once:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": "sk-or-v1-REPLACE-ME",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_MODEL": "xiaomi/mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_MODEL": "xiaomi/mimo-v2.6-pro",
    "ANTHROPIC_SMALL_FAST_MODEL": "xiaomi/mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "xiaomi/mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "xiaomi/mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "openai/gpt-6-luna",
    "CLAUDE_CODE_SUBAGENT_MODEL": "xiaomi/mimo-v2.6-pro",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576",
    "MAX_THINKING_TOKENS": "0",
    "API_TIMEOUT_MS": "600000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Then open a **new** terminal, or reload the VSCode window.

**Why the non-obvious ones are there**

- **Several model variables, not one.** The name of the small/background model has changed
  across Claude Code versions, and an unrecognised variable is ignored. Setting all of them
  is what stops a later upgrade quietly falling back to a Claude model your key cannot buy.
- **`ANTHROPIC_API_KEY` is an empty string, not absent.** If it holds a real Anthropic key
  it takes precedence and you are billed by Anthropic instead.
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`.** Claude Code only knows the context window of models
  in its own catalogue. Without this it assumes 200k and auto-compacts a 1.3M-token model at
  a sixth of its real window. Use the model's `context_length` from the models endpoint.
- **`MAX_THINKING_TOKENS: "0"`.** OpenRouter returns thinking blocks with an empty
  signature, and it removes a large cost: in a measured request 57 of 63 output tokens were
  thinking.

**Check it by hand**

```sh
curl https://openrouter.ai/api/v1/messages \
  -H "Authorization: Bearer sk-or-v1-..." \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"xiaomi/mimo-v2.6-pro","max_tokens":64,
       "messages":[{"role":"user","content":"say routed"}]}'
```

A working setup returns `"type": "message"` with a `content` array. Spend and remaining
credit come from `https://openrouter.ai/api/v1/key` with the same auth header.

## Token-saving setup (optional)

```sh
npx --allow-git=root github:djerok/claude-openrouter --key sk-or-v1-... --efficient
```

That installs the reply-compression hook and the plain-language rules, which cut output
tokens without touching code, commands or error strings. It also points you at `--trim`,
which is the larger saving if you have MCP servers enabled.

Worth understanding what actually costs you money first. A short session can bill millions
of input tokens while the display shows a few thousand, and that is not a bug: the display
is the *current context*, while billing counts every turn resending the whole conversation
plus the system prompt plus every tool schema. Twenty turns over a 40k context bills roughly
800k input by itself. `--usage` shows how much of that the provider's cache absorbed and how
much fixed overhead each turn carries.

## What it writes to CLAUDE.md

A default install adds one marked block, seven lines, and nothing else:

```markdown
<!-- BEGIN claude-openrouter: language -->
# Language

Always write your replies in English, whatever language you reason in.
<!-- END claude-openrouter: language -->
```

It is there because both models come from Chinese labs and occasionally answer an English
question in Chinese. No request parameter controls that, so an instruction is the only lever.
It is written only when the configured model is from a family that drifts, `--no-language-hint`
skips it, and `--uninstall` removes it.

**No style or tone rules are written.** An earlier version added a long "write like you are
explaining to a smart 10-year-old" section; it is gone, and installing now *removes* it from
any machine that received it. Anything you wrote in `CLAUDE.md` yourself is left alone —
only the marked blocks are touched.

That matters for cost as well as taste: `CLAUDE.md` is in context on every request whatever
you are doing, and Anthropic's guidance is to keep it under 200 lines.

## Prompt extras — off by default

`--extras` (or `--efficient`) installs the bundled reply-compression hook, and rtk if you
have supplied a source for it. It no longer writes anything to `CLAUDE.md`.

Installing without it removes the hook again: unregistered from `settings.json`, and the
files deleted only when byte-identical to the bundled copies, so a version you edited
yourself is left on disk untouched.

## It starts itself, and keeps itself current

When the install finishes it **launches Claude Code for you** — one pasted line takes you
from a blank machine to a working session, with no "now open a new terminal" homework. It
also prints the resolved path of the `claude` executable and of your settings file, so you
always know exactly what was configured and where. Pass `--no-launch` to stay at the shell.

It also installs a **SessionStart hook that keeps itself up to date**. Every time you start
Claude Code it checks — at most once every six hours — whether this repo has a newer commit,
and if so reapplies the setup in the background. The hook itself does almost nothing: it
rate-limits, detaches a child process and returns immediately, so it can never slow down or
break the session you are starting. Every path swallows its own errors by design. The
result lands on your next session, and a log of what happened is at
`~/.claude/openrouter-autoupdate.log`. Pass `--no-autoupdate` to skip it.

## Version, on every launch

The statusline ends with the installed version — the commit of this repo that is actually
on your machine:

```
● mimo-v2.6-pro (default) | my-project | main | $0.0031 | v20d0269
```

When the session-start check finds a newer commit, it turns yellow immediately, whether or
not the update itself succeeds:

```
... | v20d0269 (update pending)
```

To compare directly against GitHub:

```sh
node setup.js --version
```

```
installed:  20d0269
github:     20d0269

Up to date — installed matches djerok/claude-openrouter@main.
```

## Cutting the per-request cost

The largest avoidable cost is not what you type, it is what is prepended to every request.
Each enabled MCP server sends its tool schemas on **every** call, whatever you asked —
"write snake.py" pays for your database tooling too.

```sh
node setup.js --trim              # list what is enabled
node setup.js --trim obsidian     # keep only obsidian
node setup.js --trim --none       # disable all of them
node setup.js --untrim            # put them all back
```

`~/.claude.json` is backed up first and the removed entries are stashed, so `--untrim` is
exact.

**The installer does not do this for you.** It reports what is enabled and leaves the choice
alone: quietly disabling someone's notes or database access to save tokens is not a trade a
setup script should make on its own.

`--usage` tells you whether it is worth doing — it reports input tokens per turn and what
share of them the provider's cache absorbed.

## Usage logging

Every assistant turn appends one line to `~/.claude/openrouter-usage.jsonl`. This is a
plain Stop hook — a small Node function reading the hook payload and writing a file. **No
model is involved and it costs nothing**; it is accounting, not analysis.

```sh
node setup.js --usage
```

shows live spend straight from OpenRouter (total, today, this week, this month, credit
remaining — the authoritative numbers) and the local totals per turn and per model.

The hook does not hard-code field names. It walks the payload and keeps anything that looks
like a token count, a cost or a duration, so it keeps working if the payload shape changes
and an unfamiliar field shows up in the log rather than being silently dropped.

`--no-usagelog` skips it. `--uninstall` removes the hook but **keeps the log** — it is your
data.

## Modes

```sh
npx --allow-git=root github:djerok/claude-openrouter --key sk-or-v1-...  # install
npx --allow-git=root github:djerok/claude-openrouter --status            # what is configured
npx --allow-git=root github:djerok/claude-openrouter --doctor            # diagnose, change nothing
npx --allow-git=root github:djerok/claude-openrouter --off               # back to your Anthropic account
npx --allow-git=root github:djerok/claude-openrouter --on                # back to OpenRouter
npx --allow-git=root github:djerok/claude-openrouter --uninstall         # restore the newest backup
npx --allow-git=root github:djerok/claude-openrouter --no-verify         # skip the live test
npx --allow-git=root github:djerok/claude-openrouter --no-extras         # skip CLAUDE.md, caveman, rtk
npx --allow-git=root github:djerok/claude-openrouter --no-launch         # do not start Claude Code at the end
npx --allow-git=root github:djerok/claude-openrouter --no-autoupdate     # do not self-update on session start
npx --allow-git=root github:djerok/claude-openrouter --usage             # token and spend totals
npx --allow-git=root github:djerok/claude-openrouter --no-usagelog       # do not log per-turn usage
npx --allow-git=root github:djerok/claude-openrouter --version           # installed version vs GitHub
npx --allow-git=root github:djerok/claude-openrouter --trim              # see/disable MCP servers
```

From a clone, use `node setup.js` in place of the `npx` part.

To take it all back off, see [Undoing it](#undoing-it).

`--allow-git=root` is needed on npm 11+, where git-backed packages are blocked by default
(`EALLOWGIT`). `root` allows only the package you named and still blocks git-backed
dependencies. Older npm ignores the flag with a warning.

Key precedence: `--key` → `$OPENROUTER_API_KEY` → the key already in your settings.
No key is baked into the script.

## Undoing it

Everything here is reversible, and every file is backed up before it is touched.

### Switch back for a while

```sh
node setup.js --off     # Claude Code goes back to your Anthropic account
node setup.js --on      # and back to OpenRouter again
```

`--off` removes the routing variables from `~/.claude/settings.json`, restores any
`model` setting that was parked during the install, and stashes what it removed so `--on`
can put it back exactly. Open a new terminal, or reload the VSCode window, for either to
take effect.

### Remove it completely

```sh
node setup.js --uninstall
```

Or, without a copy of the repo on disk:

```sh
npx --allow-git=root github:djerok/claude-openrouter --uninstall
```

What that does, precisely:

| | |
|---|---|
| **Restores** | `~/.claude/settings.json` from the newest backup that is **not** routed. If every backup is routed, it strips the routing keys from the current file instead and puts back the parked `model`. |
| **Removes** | `~/.claude/statusline-openrouter.js`, `~/.claude/hooks/openrouter-usage.js`, `~/.claude/hooks/openrouter-autoupdate.js`, and the marked block in `~/.claude/CLAUDE.md` |
| **Keeps** | `~/.claude/openrouter-usage.jsonl` — your own data — and every `*.bak.*` file |
| **Never touches** | Claude Code itself, your Anthropic login, your projects, or any hook you configured yourself |

MCP servers disabled with `--trim` are separate, because you may want to keep that change:

```sh
node setup.js --untrim
```

### Put the caveman hooks back

Installing without `--extras` unregisters them. Files are deleted only when they are
byte-identical to the bundled copies, so a version you modified yourself is left on disk
and only unregistered. To re-enable:

```sh
node setup.js --key sk-or-v1-... --extras
```

### By hand, if the script is gone

Everything the installer does is a few edits you can reverse yourself.

**1. Edit `~/.claude/settings.json`** and delete these keys from `env`:

```
ANTHROPIC_BASE_URL              ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_AUTH_TOKEN            ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_API_KEY               ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_MODEL                 CLAUDE_CODE_SUBAGENT_MODEL
ANTHROPIC_DEFAULT_MODEL         CLAUDE_CODE_MAX_CONTEXT_TOKENS
ANTHROPIC_SMALL_FAST_MODEL      MAX_THINKING_TOKENS
API_TIMEOUT_MS                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
```

If there is a `__parkedModel` key, move its value back to `model` and delete it. Remove the
`statusLine` entry, and any `hooks` entry whose command mentions `openrouter-usage` or
`openrouter-autoupdate`.

Or simply overwrite the file with a backup — they are named
`settings.json.bak.<timestamp>`, and the oldest one is your original.

**2. Delete these files** (all optional, none of them matter to Claude Code):

```
~/.claude/statusline-openrouter.js
~/.claude/hooks/openrouter-usage.js
~/.claude/hooks/openrouter-autoupdate.js
~/.claude/openrouter-setup-state.json
~/.claude/openrouter-autoupdate.log
~/.claude/openrouter-usage.jsonl          (your usage data — keep it if you want it)
```

**3. In `~/.claude/CLAUDE.md`**, delete everything between and including:

```
<!-- BEGIN ccr-openrouter: plain language rules -->
<!-- END ccr-openrouter -->
```

**4. If you used `--trim`**, your MCP servers were moved out of `~/.claude.json` and stashed
under `trimmedMcp` in `~/.claude/openrouter-setup-state.json`. Copy them back into
`mcpServers`, or restore `~/.claude.json` from its `.bak.` file.

**5. Open a new terminal**, or reload the VSCode window.

Nothing runs in the background and nothing was installed as a service, so there is no
daemon to stop and no startup entry to remove.

### Stop it updating itself, without removing it

```sh
node setup.js --key sk-or-v1-... --no-autoupdate
```

That reinstalls without the session-start check. To disable it on a setup you already have,
delete `~/.claude/hooks/openrouter-autoupdate.js` and remove the matching `SessionStart`
hook from `settings.json`.

## Statusline

```
* gpt-6-luna (opus) | ctx 12% | cache 91% | high | my-project | main | $0.0312 | v59f677b
```

Every field comes from one Claude Code documents for status lines, not from
anything invented here:

| field | source | why it matters |
|---|---|---|
| model + tier | your settings | which of the two models answered |
| `ctx NN%` | `context_window.used_percentage` | what drives compaction; red past 90% |
| `cache NN%` | `prompt_cache.hit_ratio` | whether resending the conversation each turn is cheap. Red under 40%, and `cold` when the cached prefix has expired |
| effort | `effort.level` | live value, including mid-session `/effort` changes |
| cost | `cost.total_cost_usd` | session spend |
| `vNNNNNNN` | this project's installed commit | turns yellow with `up!` when a newer version is waiting |

Cache hit rate is the number to watch. Claude Code resends the whole
conversation every turn; whether that is billed at full price or at the cached
rate is the difference between a cheap session and an expensive one.

## Reducing tokens, by the official guidance

Anthropic documents what actually works in
[Manage costs effectively](https://code.claude.com/docs/en/costs). The useful
parts, and what this installer does about each:

| lever | status |
|---|---|
| `MAX_THINKING_TOKENS` to cut thinking spend | **set to 0 by the installer.** Thinking tokens bill as output, and the default budget can be tens of thousands per request |
| Watch context usage in the status line | **installed** — the `ctx` field above |
| `/clear` between unrelated tasks | yours to run. Stale context is billed on every later message |
| `/compact Focus on ...` with custom instructions | yours to run |
| `# Compact instructions` in CLAUDE.md | added by `--efficient` |
| `/context` to see what is consuming space | yours to run |
| Disable unused MCP servers with `/mcp` | `--trim` does it non-interactively |
| Prefer CLI tools (`gh`, `aws`) over MCP servers | yours to choose |
| Keep CLAUDE.md under 200 lines; move detail into skills | the block added by `--efficient` is short by design |
| Delegate verbose work to subagents | yours to choose |

**A correction to earlier advice in this file.** MCP tool definitions are
*deferred by default* — only tool names and server instructions enter context
until a tool is actually used. Disabling unused servers still helps, but far
less than claimed here previously. Run `/context` to see the real numbers before
trimming anything.

## When the machine fights back

| Situation | What happens |
|---|---|
| No Node at all | Use a bootstrapper above; it installs Node first |
| Node older than 18 | Refused up front, with the version it found |
| Node installed but invisible to the shell | `install.ps1` rebuilds `PATH` in-process |
| `npm` missing though Node is present | Caught before anything installs |
| Claude Code installed but not on `PATH` | Located via `npm prefix -g` and run by absolute path |
| A proxy serving an HTML error page | Downloads checked by size and content, not exit code |
| Model retired or renamed | Caught against the live catalogue at install time |
| No credit on the account | The 401 is reported plainly, not left to surface later |
| Old install still pointing at `127.0.0.1` | Detected and replaced, and `--status` warns about it |

Installer exit codes are trusted nowhere — `winget` reports success while installing
nothing, so every step is verified by running the program and reading its output.

## Notes

- Your OpenRouter key is written to `~/.claude/settings.json`, created with `0600`.
- `--off` and `--on` flip between OpenRouter and your Anthropic account without losing
  either configuration.
- `--uninstall` restores the newest settings backup and removes the statusline and the
  `CLAUDE.md` block.

## Licence

MIT
