---
name: genshin-skills
version: 0.1.0
description: >-
  Browser automation via Playwright for LLMs. Use when you need to:
  (1) automate web interactions (click, fill, navigate, screenshot),
  (2) extract page content or run JavaScript,
  (3) manage cookies or browser sessions,
  (4) log in to Genshin Impact cloud gaming and claim daily rewards.
  Background script manages browser sessions; agent invokes via bash.
metadata:
  openclaw:
    requires:
      bins:
        - node
        - npx
    install:
      - kind: node
        package: playwright
        bins:
          - npx
---

# Genshin-Skills

Browser automation skills for LLMs — 33 atomic Playwright-based browser operations.

## Quick Start

`<SKILL_DIR>` is the skill's install directory, available as the `SKILL_DIR` environment variable at runtime.

```bash
# Install
npm install
npx playwright install chromium

# Start browser (background)
node <SKILL_DIR>/dist/scripts/start-browser.js &

# Use skills
node <SKILL_DIR>/dist/scripts/run-skill.js browser_navigate --url "https://example.com"
node <SKILL_DIR>/dist/scripts/run-skill.js browser_screenshot --output-file page.png
node <SKILL_DIR>/dist/scripts/run-skill.js browser_extract_text

# Stop browser
node <SKILL_DIR>/dist/scripts/stop-browser.js
```

## Available Skills (33)

### Session Management

| Skill | Description | Required Args |
|-------|-------------|---------------|
| `browser_session_create` | Create a new browser session | _(none)_ |
| `browser_session_list` | List all active sessions | _(none)_ |
| `browser_session_close` | Close a browser session | _(none, closes default)_ |
| `browser_login` | Cookie-based persistent login (manual login on first use, auto-restore after) | _(none)_ |
| `browser_start_game` | Dismiss popups and click start after login | _(none)_ |

### Navigation

| Skill | Description | Required Args |
|-------|-------------|---------------|
| `browser_navigate` | Navigate to a URL | `--url` |
| `browser_get_url` | Get the current page URL | _(none)_ |
| `browser_get_title` | Get the current page title | _(none)_ |
| `browser_go_back` | Navigate back in history | _(none)_ |
| `browser_go_forward` | Navigate forward in history | _(none)_ |
| `browser_reload` | Reload the current page | _(none)_ |

### Interaction

| Skill | Description | Required Args |
|-------|-------------|---------------|
| `browser_click` | Click an element by selector, or at coordinates (x/y) | `--selector` or `--x --y` |
| `browser_fill` | Fill an input field (clears first) | `--selector --value` |
| `browser_type` | Type text character by character | `--selector --text` |
| `browser_hover` | Hover over an element | `--selector` |
| `browser_check` | Check/uncheck a checkbox | `--selector` |
| `browser_press_key` | Press a key or key combo | `--key` |
| `browser_select_option` | Select dropdown option | `--selector` + `--value`/`--label`/`--index` |

### Extraction

| Skill | Description | Required Args |
|-------|-------------|---------------|
| `browser_extract_text` | Extract visible text from page/element | _(none)_ |
| `browser_extract_html` | Extract HTML from page/element | _(none)_ |
| `browser_get_attribute` | Get an element's attribute value | `--selector --attribute` |
| `browser_screenshot` | Take a screenshot (base64 PNG) | _(none)_ |
| `browser_pdf` | Generate a PDF of the page | _(none)_ |

### Page Operations

| Skill | Description | Required Args |
|-------|-------------|---------------|
| `browser_scroll` | Scroll the page or element | _(none)_ |
| `browser_wait` | Wait for a duration (ms) | `--ms` |
| `browser_wait_for_selector` | Wait for an element to appear | `--selector` |
| `browser_evaluate` | Execute JavaScript in the page | `--expression` |
| `browser_set_viewport` | Set the viewport size | `--width --height` |
| `browser_upload_file` | Upload a file to a file input | `--selector --file-path` |
| `browser_dialog_handle` | Handle browser dialogs | `--action` (accept/dismiss) |

### Cookies

| Skill | Description | Required Args |
|-------|-------------|---------------|
| `browser_get_cookies` | Get cookies for the current page | _(none)_ |
| `browser_set_cookies` | Set cookies | `--cookies '[...]'` (JSON) |
| `browser_clear_cookies` | Clear all cookies | _(none)_ |

## Common Optional Args

- `--session-id <id>` — Target a specific session (default session used if omitted)
- `--timeout <ms>` — Element wait timeout (interaction skills, default 5000)
- `--wait-until <event>` — Navigation wait strategy: `load`, `domcontentloaded`, `networkidle`, `commit`
- `--output-file <path>` — Write screenshot/PDF binary to file instead of base64 in JSON

## Architecture

The browser runs as a long-lived background process (`start-browser.js`) that listens on a Unix domain socket. You must start it before invoking any skill. `run-skill.js` connects to the socket, sends a command, and prints JSON results to stdout. `stop-browser.js` sends a shutdown command for graceful cleanup.

**Constraints**: Only `http://` and `https://` URLs are allowed. Sessions auto-close after 30 minutes of inactivity.

## References

- **Agent prompt**: See [references/browser-prompt.md](references/browser-prompt.md) for full skill reference with detailed parameters and examples
- **Welkin Moon workflow**: See [references/bootstrap.md](references/bootstrap.md) for step-by-step Genshin daily reward claim
