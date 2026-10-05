# Installing ridealong: instructions for AI agents

You are installing **ridealong** for a user: one self-hosted, logged-in Chrome that the user watches and drives from a web viewer (port 8083), and that AI agents drive over CDP (port 9230). Follow these steps in order. When a step needs `sudo` or anything else the user should decide, stop and ask them.

## 1. Check the machine

```sh
uname -s          # Linux or Darwin (macOS). Windows: stop and suggest WSL2 or Docker.
node --version    # needs v20 or newer
```

If Node is missing or older than 20, install it: on macOS `brew install node`, on Linux the user's package manager or [nvm](https://github.com/nvm-sh/nvm). Ask before using `sudo`.

If `ridealong --version` already works, ridealong is installed. Skip to step 3 and report what `ridealong status` shows.

## 2. Install

### macOS with Homebrew (preferred on a Mac)

```sh
brew install killerz3/tap/ridealong
ridealong setup --yes
brew services start ridealong
```

### macOS without Homebrew

```sh
npm install -g https://github.com/killerz3/ridealong/releases/latest/download/ridealong.tgz
ridealong setup --yes
```

On a Mac, `setup --yes` uses Google Chrome from `/Applications` when it's there (otherwise it downloads Chromium), generates a viewer password and installs a launchd agent so ridealong starts at login. Chrome runs headless on macOS. That is expected: the user sees pages in the viewer, not in a Chrome window.

### Linux

```sh
sudo apt-get install -y xvfb ffmpeg     # ask the user first; ffmpeg is optional (video mode)
npm install -g https://github.com/killerz3/ridealong/releases/latest/download/ridealong.tgz
ridealong setup --yes
```

On other distros, install `xvfb` (it's `xorg-x11-server-Xvfb` on Fedora) with the system package manager. `setup --yes` downloads Chromium if no Chrome is found (about 170 MB, no root), generates a viewer password and installs a systemd user service.

If `npm install -g` fails with a permissions error, don't use `sudo npm`. Set a user prefix (`npm config set prefix ~/.local`, with `~/.local/bin` on `PATH`) and retry.

### Docker (any OS)

```sh
git clone https://github.com/killerz3/ridealong && cd ridealong
echo "RIDEALONG_PASSWORD=$(openssl rand -base64 18)" > .env
docker compose up -d
```

## 3. Verify

```sh
ridealong doctor                  # Xvfb (Linux), Chrome, ffmpeg, password
ridealong status                  # should list the "default" workspace
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8083/   # expect 200
```

If ridealong isn't running, start it with `ridealong start` in the foreground to see the error. Check logs with `journalctl --user -u ridealong -n 50` (Linux), `~/.ridealong/ridealong.log` (macOS launchd) or `$(brew --prefix)/var/log/ridealong.log` (Homebrew). If a workspace fails to start on Linux because Chrome libraries are missing, ask the user to run `sudo node $(npm root -g)/ridealong/node_modules/playwright-core/cli.js install-deps chromium`.

## 4. Connect yourself (optional)

If the user wants *you* to use the browser, pick a short agent name and run:

```sh
ridealong connect <agent-name>
```

It prints setup for Claude Code, Codex, MCP clients, Playwright and Puppeteer. For Claude Code:

```sh
claude mcp add browser -- npx -y chrome-devtools-mcp@latest \
  --wsEndpoint ws://127.0.0.1:9230/default/<agent-name>/devtools/browser
```

## 5. Report back to the user

Tell the user:

- the viewer URL, **http://127.0.0.1:8083**, and the generated password. Setup prints it; it's also `password` in `~/.ridealong/config.json`. They can change it with `ridealong password <new>`.
- on a remote server, how to reach the viewer: `ssh -L 8083:127.0.0.1:8083 <server>`, or a tunnel (see the README's "Reach it from anywhere")
- that they should open the viewer and sign in to the sites their agents need. Agents then reuse those logins.

## Rules

- **Never expose port 9230.** It has no authentication, and anything that reaches it is logged in as the user everywhere. Don't change `bind` from `127.0.0.1`, and don't open either port in a firewall or tunnel unless the user explicitly asks. Even then, only the viewer (8083) goes behind a tunnel, never 9230.
- Don't sign in to sites for the user, and don't read or copy cookies or profile data from `~/.ridealong`.
- Ask before `sudo`, before installing system packages, and before replacing an existing ridealong config.
