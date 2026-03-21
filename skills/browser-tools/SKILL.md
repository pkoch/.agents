---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to a Chromium-based browser (Chromium/Chrome) running on `:9222` with remote debugging enabled.

## Setup

Run once before first use:

```bash
bun install
```

Run from the repo root (`$HOME/.agents`). If you only want this package, use `bun install --filter browser-tools`.

## Start Chromium / Chrome

```bash
"$HOME/.agents/skills/browser-tools/browser-start.ts"              # Fresh profile
"$HOME/.agents/skills/browser-tools/browser-start.ts" --profile    # Copy your profile (cookies, logins)
"$HOME/.agents/skills/browser-tools/browser-start.ts" --watch      # Start background JSONL logging
"$HOME/.agents/skills/browser-tools/browser-start.ts" --browser chromium
"$HOME/.agents/skills/browser-tools/browser-start.ts" --browser chrome
```

Launch a browser with remote debugging on `:9222`. Use `--profile` to preserve your authentication state.

If the auto-detection picks the wrong browser, set:

- `BROWSER_TOOLS_BROWSER=chromium` (or `chrome`)
- `BROWSER_TOOLS_EXECUTABLE=/absolute/path/to/browser`
- `BROWSER_TOOLS_PROFILE_SRC=/absolute/path/to/profile/dir` (optional)

## Navigate

```bash
"$HOME/.agents/skills/browser-tools/browser-nav.ts" https://example.com
"$HOME/.agents/skills/browser-tools/browser-nav.ts" https://example.com --new
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing current tab.

## Evaluate JavaScript

```bash
"$HOME/.agents/skills/browser-tools/browser-eval.ts" 'document.title'
"$HOME/.agents/skills/browser-tools/browser-eval.ts" 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

For multi-line code or statements, wrap in an IIFE:

```bash
"$HOME/.agents/skills/browser-tools/browser-eval.ts" '(() => { const x = 1; return x + 1; })()'
```

## Screenshot

```bash
"$HOME/.agents/skills/browser-tools/browser-screenshot.ts"
```

Capture current viewport and return temporary file path. Use this to visually inspect page state or verify UI changes.

## Pick Elements

```bash
"$HOME/.agents/skills/browser-tools/browser-pick.ts" "Click the submit button"
```

Use this when the user wants to select specific DOM elements on the page. This launches an interactive picker: click elements to select them, Cmd/Ctrl+Click for multi-select, Enter to finish.

## Dismiss cookie banners

```bash
"$HOME/.agents/skills/browser-tools/browser-dismiss-cookies.ts"          # Accept cookies
"$HOME/.agents/skills/browser-tools/browser-dismiss-cookies.ts" --reject # Reject (where possible)
```

Run after navigation if cookie dialogs interfere with interaction.

## Cookies

```bash
"$HOME/.agents/skills/browser-tools/browser-cookies.ts"
"$HOME/.agents/skills/browser-tools/browser-cookies.ts" --format=netscape > cookies.txt
```

Display all cookies for the current tab including domain, path, httpOnly, and secure flags.

The `--format=netscape` option outputs cookies in Netscape format for use with curl/wget (`curl -b cookies.txt`).

## Extract Page Content

```bash
"$HOME/.agents/skills/browser-tools/browser-content.ts" https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction and Turndown for HTML-to-markdown conversion.

## Background logging (console + errors + network)

Start the watcher:

```bash
"$HOME/.agents/skills/browser-tools/browser-watch.ts"
```

Or launch the browser with logging enabled:

```bash
"$HOME/.agents/skills/browser-tools/browser-start.ts" --watch
```

Logs are written as JSONL to a temp directory by default:

- Default: `/tmp/agent-browser-tools/logs/YYYY-MM-DD/<targetId>.jsonl`
- Override: `BROWSER_TOOLS_LOG_ROOT=/some/dir`

Tail the most recent log:

```bash
"$HOME/.agents/skills/browser-tools/browser-logs-tail.ts"           # dump and exit
"$HOME/.agents/skills/browser-tools/browser-logs-tail.ts" --follow  # follow
```

Summarize network responses (status codes, failures):

```bash
"$HOME/.agents/skills/browser-tools/browser-net-summary.ts"
"$HOME/.agents/skills/browser-tools/browser-net-summary.ts" --file /path/to/log.jsonl
```

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution
