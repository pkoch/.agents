# .agents

Reusable agent harness shared across Codex, Claude, and Pi. Shared skills live at the repo root; Pi-specific skills, extensions, and sandbox defaults live under `pi/`.

## Setup

Install all Node-based tools from the repo root:

```bash
npm ci
```

## Layout

```
AGENTS.md              Shared base instructions (symlinked into each agent folder)
skills/                Skill source of truth (SKILL.md + optional scripts/assets)
pi/skills/             Pi-specific skills
pi/extensions/         Pi-specific extensions
pi/agent/sandbox.json  Repo-managed Pi sandbox defaults
bin/sync               Symlink everything into Codex, Claude, and Pi config dirs
```

## Syncing

`AGENTS.md` is symlinked into each agent config. Skills are symlinked to Claude, while Codex and Pi auto-discover them from `~/.agents/skills`.

| Content        | Codex                | Claude                | Pi                         |
| -------------- | -------------------- | --------------------- | -------------------------- |
| Instructions   | `~/.codex/AGENTS.md` | `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md`    |
| Skills         | `~/.agents/skills`   | `~/.claude/skills/`   | `~/.agents/skills`         |
| Extensions     | —                    | —                     | `~/.pi/agent/extensions/`  |
| Sandbox config | —                    | —                     | `~/.pi/agent/sandbox.json` |

```bash
~/.agents/bin/sync --prune
```

## Skills

| Skill               | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `browser-tools`     | Interactive browser automation via Chrome DevTools Protocol                       |
| `git-clean-history` | Reimplement a branch on a fresh branch off `main` with a clean commit history     |
| `git-commit`        | Tidy, focused commits with clear rationale in messages                            |
| `homeassistant-ops` | Operate a Home Assistant instance via REST/WebSocket APIs                         |
| `openscad`          | Create and render OpenSCAD 3D models, export STL                                  |
| `oracle`            | Second opinion from another LLM for debugging, refactors, design, or code reviews |
| `sentry`            | Fetch and analyze Sentry issues, events, and logs                                 |
| `update-changelog`  | Update CHANGELOG.md following Keep a Changelog                                    |
| `web-design`        | Distinctive, production-ready web interfaces                                      |

## Pi Skills

| Skill    | Description                                                           |
| -------- | --------------------------------------------------------------------- |
| `search` | Unified web search with automatic provider selection for current info |

## Pi Extensions

| Extension           | Command                      | Description                                                                    |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `answer`            | `/answer`                    | Extract and interactively answer agent questions                               |
| `branch-term`       | `/branch`                    | Fork the current session into a new tmux pane/window or show a resume command  |
| `fast`              | `/fast`                      | Toggle priority service tier for OpenAI/Codex models                           |
| `ghostty`           | _automatic_                  | Ghostty tab title and progress while the agent is working                      |
| `git-checkpoint`    | _automatic_                  | Stash checkpoints each turn so `/fork` can restore code state                  |
| `insights`          | `/insights`                  | Analyze Pi sessions and suggest reusable instructions, templates, skills, etc. |
| `loop`              | `/loop`                      | Repeat a prompt until the agent signals success                                |
| `notify`            | _automatic_                  | Terminal notification when the agent is waiting for input                      |
| `review`            | `/review`, `/triage`, `/fix` | Review PRs, branches, commits, or uncommitted changes                          |
| `sandbox`           | `/sandbox`                   | OS-level sandboxing for bash commands with runtime overrides                   |
| `session-breakdown` | `/session-breakdown`         | Usage stats and contribution-style calendar                                    |
| `telegram`          | `/telegram`                  | Interact with Pi through a Telegram bot bridge                                 |
| `todo`              | `/todo`                      | Todoist-backed tasks with offline outbox sync for single or multi-session work |
| `worktree`          | `/worktree`                  | Create and manage git worktrees                                                |
