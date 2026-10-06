# Orca Deck

A Stream Deck plugin (built for the **Stream Deck Neo**): one key per [Orca](https://www.onorca.dev) worktree, with its agent's status live.

| Gesture | Effect |
|---|---|
| Press a worktree | Brings its agent terminal to the front in Orca (starts the agent if nothing is running). A **Done** worktree turns **Idle** once pressed. |
| Press `+` | Opens Orca's **Create worktree** dialog (⌘N) so you name the task; the worktree you create lands on this key |
| Hold a worktree (0.7 s) | Same dialog; once the new worktree exists it takes this key and the old one **leaves the deck** (it stays in Orca). Cancel the dialog and nothing changes. |
| Orca closed | Any key launches Orca |

The deck never deletes or creates worktrees by itself: it shows a selection of your Orca worktrees and opens Orca's dialog to create new ones (`+`, long press). A worktree taken off the deck comes back as soon as its agent changes state.

**Thick border = status** (it "breathes", except when idle):
🟠 working · 🟡 background (pure yellow: turn over, a background task it started is still running, Orca's "Monitoring background tasks") · 🔵 input (only when the agent actually needs you: a question, a permission, a plan to approve) · 🟢 done (breathes until seen) · 🔴 error · 🟣 review · ⚫ idle (grey, static)

**Key name**: the agent's conversation title (e.g. "Fix login redirect"), on up to 3 lines; the font shrinks instead of scrolling. Falls back to a name you set in Orca, then the branch Orca auto-renamed from the work, then the generated name.

**Neo infobar**:
- line 1: when the worktree shown in Orca is on the deck, **its context window** (`ctx` gauge, % and tokens, like Claude Code's status line); otherwise the agent status counters `ask / work / done / idle`, plus `+N` worktrees without a key;
- line 2: always **token usage**: 5-hour and weekly gauges, or the monthly spend cap (`mo` gauge + "$36 / $100") on organization plans.

Usage is read like Claude Code's `/usage`: the plugin reads Claude Code's login token (macOS Keychain item "Claude Code-credentials", or `~/.claude/.credentials.json`) and asks Anthropic's usage endpoint, at most every 5 minutes. The token is only read and only sent to `api.anthropic.com`; it is never stored, refreshed or logged. The first time, macOS asks to allow access to that Keychain item. If it's unavailable, the plugin falls back to what Orca reports (`orca account list`).
Context comes from the session's transcript (`~/.claude/projects/…/<session>.jsonl`, found through `~/.claude/sessions/`).

**Instant statuses** rely on the agent status hooks Orca installs in each agent's config (e.g. `~/.claude/settings.json`); without them Orca can only read the terminal screen, so a question only turns the key blue once the terminal is displayed. The plugin checks them every 5 minutes, reinstalls them once (`orca agent hooks on`) if they're missing, and otherwise shows a warning in the infobar.

**Full deck**: a new worktree (or one that gets back to work) takes the key of the least recently active idle worktree; that one stays in Orca and gets a key back when one frees up. If no worktree is idle, it waits.

## Install (any machine)

Requires the **Stream Deck app ≥ 7.6** (macOS or Windows) and **Orca**.

1. Download `dev.orcadeck.streamDeckPlugin` from [Releases](https://github.com/Koringer/orca-deck/releases) and double-click it.
2. The plugin installs and activates the **Orca Deck** profile on the Neo (8 Worktree keys + infobar). Nothing to drag.
3. The first time you press `+`, macOS asks to grant **Accessibility** to *Orca Computer Use* (Orca's helper that sends ⌘N to open its dialog). Allow it, then press again.
4. (Optional) settings in the property inspector: agent started when pressing a worktree with no terminal (`claude` by default), long-press duration, CLI path.

The `orca` CLI is detected automatically (PATH, `/Applications/Orca.app`, `%LOCALAPPDATA%\Programs\Orca`).
For a second Neo page, set `Neo page = 2` on its keys: they show worktrees 9 to 16.

### Other Stream Deck models

The **Worktree** key works on every model with LCD keys (Mini, MK.2, XL, +, Studio, Mobile); key positions adapt to the device size. The infobar and the bundled profile are Neo-only: on other models, drag the Worktree action onto the keys yourself.

## Development

```bash
npm install
npm run build      # bundle → dev.orcadeck.sdPlugin/bin/plugin.js + Neo profile
npm run link       # install the folder in the Stream Deck app (dev mode)
npm run dev        # rebuild on change (then `npx streamdeck restart dev.orcadeck`)
npm test
npm run pack       # → dist/dev.orcadeck.streamDeckPlugin
```

Data: `orca worktree ps --json` and `orca terminal list --json` (every 1.5 s), `orca account list --json` (rate limits, every 60 s).
Actions: `orca terminal list|switch|create`, `orca computer hotkey --key CmdOrCtrl+N` (opens Orca's Create worktree dialog).

## License

[MIT](LICENSE)
