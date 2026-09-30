# tabkennel

**One logged-in browser for you and your AI agents.** tabkennel runs real Chrome on your server. You open it from any browser or your phone, sign in to your sites once, and your agents use that same logged-in Chrome over CDP. Each agent only sees the tabs it opened.

![The tabkennel viewer: your tab, plus tabs opened by two agents, grouped in the sidebar](docs/viewer.png)

- **Your logins, shared safely.** Sign in once (Gmail, GitHub, LinkedIn, your internal tools). Agents work as you, each in its own tabs. They can't see or touch your tabs or each other's.
- **You can step in.** When an agent hits a captcha, 2FA prompt or "is this you?" page, you open the viewer and answer it.
- **Workspaces.** Separate profiles with separate logins, for example `personal` and `work`. Each one runs its own Chrome.
- **No RAM when idle.** A workspace nobody is using goes to sleep after 10 minutes (configurable): its Chrome is stopped and its tabs are saved. The next person or agent to connect wakes it in about 2 seconds, and agents get their tabs back.
- **Fast on slow links.** The viewer only sends a new frame once the previous one has arrived. It never builds a backlog, so what you see stays current. An optional H.264 video mode gives smooth scrolling.
- **Works on a phone.** Your tabs render at your screen's size, sites get a mobile browser, and you get touch scrolling and an on-screen keyboard.
- **No root needed.** It's a Node process plus Xvfb. Run it as a normal user under systemd, or in Docker.

## Quick start

On a Linux server or VM with Node 20+:

```sh
sudo apt-get install -y xvfb ffmpeg      # ffmpeg is optional (video mode)
npm install -g github:killerz3/tabkennel
tabkennel setup
```

`setup` checks your system and downloads Chromium if you don't have one (about 170 MB, no root). It then sets a viewer password and offers to install a systemd user service, so tabkennel keeps running in the background and starts on boot.

Open **http://127.0.0.1:8083** and sign in. On a remote server, use `ssh -L 8083:127.0.0.1:8083 your-server` or [put it behind a tunnel](#reach-it-from-anywhere).

### Docker

```sh
git clone https://github.com/killerz3/tabkennel && cd tabkennel
echo "TABKENNEL_PASSWORD=$(openssl rand -base64 18)" > .env
docker compose up -d
```

Both ports are published on `127.0.0.1` only. Profiles live in the `tabkennel-data` volume.

## Connect an agent

Click **Connect an agent** in the viewer, or run `tabkennel connect <agent-name>`. You get ready-to-paste snippets like these:

```sh
# Claude Code (or any MCP client) via Chrome DevTools MCP
claude mcp add browser -- npx -y chrome-devtools-mcp@latest \
  --wsEndpoint ws://127.0.0.1:9230/default/research-bot/devtools/browser
```

```js
// Playwright
const browser = await chromium.connectOverCDP('http://127.0.0.1:9230/default/research-bot');
// Puppeteer
const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9230/default/research-bot/devtools/browser' });
```

The address is `ws://127.0.0.1:9230/<workspace>/<agent>/devtools/browser`:

- **`<agent>`** is any name you choose. It labels the agent's tabs in the viewer and scopes what it can see. Give each agent its own name.
- **`<workspace>`** picks which profile (which set of logins) the agent uses. If the workspace doesn't exist, it is created. If it's asleep, it wakes up.
- The older form `/<agent>/devtools/browser` uses the `default` workspace.

A long-running agent keeps working across sleeps. When its workspace goes to sleep the connection closes, and Chrome DevTools MCP reconnects on the next tool call, which wakes the workspace and restores its tabs.

## Workspaces and sleep

<img src="docs/phone.png" alt="tabkennel on a phone" width="260" align="right">

Each workspace is its own Chrome profile running in its own Chrome on its own virtual display. Logins, cookies and history never mix between them.

A workspace stays **awake** while you have it open in a visible viewer tab or an agent keeps sending commands. After `idleMinutes` with neither (10 by default), it goes **to sleep**: Chrome saves its session and exits, so the workspace uses no memory. It wakes when you select it in the viewer or an agent connects.

Change the timer for all workspaces with `idleMinutes` in the config. Change it for one workspace from the **⋯** menu in the viewer (2 minutes up to never). That menu also has **Put to sleep now** and **Delete workspace**.

```sh
tabkennel status          # which workspaces are awake, who is connected
tabkennel sleep work      # stop a workspace's browser now
tabkennel wake work
```

## The viewer

- **Images** mode (the default) streams JPEG frames only when the page changes. Pacing and quality adapt to your connection, and it works in every browser.
- **Video** mode streams H.264 from the workspace's display, decoded in your browser with WebCodecs. Scrolling and animation are smoother, but the server uses more CPU while you watch. It needs `ffmpeg` on the server and https or localhost in the browser.
- Tabs you open render at the size of your viewer. Agents' tabs keep their own size, so watching an agent doesn't change what it sees.
- Copy (Ctrl/Cmd+C) copies the page's selection to your clipboard. Paste types your clipboard into the page. JS alerts and confirms appear as dialogs you can answer.
- The numbers in the toolbar show the round trip, frames per second and bandwidth.

On a 4 Mbit/s link with 30 ms latency, streaming a busy animated page, the picture was **56 ms old at the median (p95 101 ms)**. A viewer that acknowledges frames as soon as the server sends them (tabkennel's predecessor did this) fell **8 to 12 seconds** behind on the same link.

## Reach it from anywhere

Only expose the **viewer** port (8083). Never expose the agent port (9230): anything that can reach it is signed in as you everywhere.

**Cloudflare Tunnel** (no open ports). Add Cloudflare Access in front for a second login:

```yaml
# /etc/cloudflared/config.yml
ingress:
  - hostname: browser.example.com
    service: http://127.0.0.1:8083
  - service: http_status:404
```

**Caddy** (automatic HTTPS):

```
browser.example.com {
  reverse_proxy 127.0.0.1:8083
}
```

Video mode and clipboard copy need HTTPS, which both of these provide.

## Configuration

`tabkennel setup` writes `~/.tabkennel/config.json`. Environment variables override it.

| Setting | Env var | Default | |
|---|---|---|---|
| `password` | `TABKENNEL_PASSWORD` | set by setup | viewer password |
| `viewerPort` | `TABKENNEL_PORT` | `8083` | web viewer |
| `agentPort` | `TABKENNEL_AGENT_PORT` | `9230` | CDP for agents |
| `bind` | `TABKENNEL_BIND` | `127.0.0.1` | interface both ports listen on |
| `idleMinutes` | `TABKENNEL_IDLE_MINUTES` | `10` | sleep after this long unused; `0` = never |
| `screen` | `TABKENNEL_SCREEN` | `1920x1200` | virtual display per workspace (largest page size) |
| `fps` | `TABKENNEL_FPS` | `30` | video mode frame rate |
| `chrome` | `TABKENNEL_CHROME` | auto | path to Chrome/Chromium |
| `sandbox` | `TABKENNEL_SANDBOX` | `auto` | Chrome's sandbox; auto turns it off where it can't run |
| `chromeArgs` | | `[]` | extra Chrome flags |

Data lives in `~/.tabkennel` (or `TABKENNEL_HOME`), with one folder per workspace under `workspaces/`.

## Security model

- The viewer is protected by a password. The session cookie is HttpOnly and SameSite=Strict, and websocket connections must come from the same origin. Put an identity layer such as Cloudflare Access or your VPN in front of it anyway.
- The agent port has **no authentication**. It listens on localhost, and agents must run on the same machine (or reach it over an SSH tunnel). Treat it like a password manager that is already unlocked.
- Tab isolation stops agents from tripping over each other. It is **not** a security boundary between agents: every agent is logged in as you everywhere, and CDP is powerful. Only connect agents you trust.
- On hosts that can't run Chrome's sandbox (root, containers, Ubuntu 23.10+ with restricted user namespaces), tabkennel runs Chrome with `--no-sandbox`. That's one more reason to browse only where you'd browse anyway.

## How it works

```
 you (browser/phone) ── https ──▶ viewer :8083 ─┐
                                               ├─▶ workspace "default": Chrome + Xvfb (profile A)
 agents (MCP, Playwright) ─ ws ─▶ agent proxy :9230 ─┤
                                               └─▶ workspace "work":    Chrome + Xvfb (profile B), asleep
```

- **Agent proxy.** It passes CDP through unchanged except for `Target.*` messages. That's where it records which agent created which tab and hides every other tab from that agent's discovery, auto-attach and `getTargets`. Popups inherit their opener's owner. Before a workspace sleeps, agent tabs are remembered by URL and handed back to their agent when Chrome restores them, even after a crash.
- **Viewer.** It attaches to the selected tab over CDP and streams frames over one websocket. In Images mode it acknowledges each frame to Chrome only after your browser has received it, keeping at most two in flight. Quality and size follow the measured round trip. Video mode captures the display with `ffmpeg -f x11grab`, encodes low-latency H.264 and sends one access unit per message. If you fall behind, it skips ahead to the next keyframe.
- **Workspaces.** Each one gets Xvfb (`-displayfd`, so it needs no fixed display numbers) and Chrome with `--remote-debugging-port=0`, both started on demand. Stopping uses `Browser.close`, so the session is saved. If tabkennel itself crashes, the next start stops the leftover Chrome gracefully before launching a new one.

## Troubleshooting

- `tabkennel doctor` checks Xvfb, Chromium, ffmpeg and the password.
- **A workspace won't start.** The error appears in the viewer and in `tabkennel status`. Common causes are a missing Xvfb or missing Chrome libraries. Run `node $(npm root -g)/tabkennel/node_modules/playwright-core/cli.js install-deps chromium` as root.
- **Blank boxes instead of characters.** Install fonts: `sudo apt-get install fonts-noto fonts-noto-cjk fonts-noto-color-emoji`.
- **Sites ask you to verify yourself a lot.** Datacenter IPs look suspicious. Answer the prompts in the viewer, and pace your agents like a person.

## Development

```sh
git clone https://github.com/killerz3/tabkennel && cd tabkennel && npm install
npm test        # end-to-end: real Chrome, puppeteer agents, viewer protocol (~2.5 min)
node bin/tabkennel.js start
```

MIT licensed.
