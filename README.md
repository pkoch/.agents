# .agents

Reusable agent harness shared across Codex, Claude, and any which use `AGENTS.md`. Shared skills live at the repo root.

## Setup

Install all Node-based tools from the repo root using pnpm:

```bash
pnpm install
```

## Layout

```
AGENTS.md              Shared base instructions (symlinked into each agent folder)
bin/sync               Symlink everything into Codex and Claude config dirs
skills/                Skill source of truth (SKILL.md + optional scripts/assets)
```

## Syncing

`AGENTS.md` is symlinked into each agent config. Skills are symlinked to Claude, while Codex auto-discovers them from `~/.agents/skills`.

| Content      | Codex (and generic)  | Claude                |
| ------------ | -------------------- | --------------------- |
| Instructions | `~/.codex/AGENTS.md` | `~/.claude/CLAUDE.md` |
| Skills       | `~/.agents/skills`   | `~/.claude/skills/`   |

```bash
~/.agents/bin/sync --prune
```
