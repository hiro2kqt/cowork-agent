# Bridge Relay: the console from your phone

Works like Claude's `/remote-control`. The laptop keeps running Codex, Claude Code, and the Bridge Console as usual. The console connects **out** to a small relay on your server. You open the relay's address on your phone, and every click travels down that connection to the console on the laptop.

```
Phone ──http──► Server: node scripts/relay.mjs  (Tailscale address only)
                          ▲
                          │ the laptop polls the relay (outgoing only)
Laptop: Bridge Console ───┘──► Codex Desktop, Claude Code
```

There is no login: access is your Tailscale network. The relay therefore:

- listens only on the server's Tailscale address (it refuses `0.0.0.0`), and only answers tailnet clients (100.64.0.0/10);
- answers only to the names given with `--name` and its own Tailscale IP, so another site cannot reach it by DNS rebinding;
- refuses requests sent by other web pages (Origin / Sec-Fetch-Site checks).

Anyone who can reach the relay can direct Codex and Claude on your laptop. Keep it on the tailnet, and share that tailnet only with devices you own.

## Server (Ubuntu), once

1. Install Node.js 20+, and put the server on your tailnet (`tailscale up`).
2. Point the DNS name at the server's Tailscale IP (`tailscale ip -4`), for example an `A` record `console.example.com → 100.x.y.z`.
3. Copy this repository to the server, for example to `/opt/cowork-agent`.
4. Run it as a service. Create `/etc/systemd/system/bridge-relay.service`:

   ```ini
   [Unit]
   Description=Bridge Relay
   After=network-online.target tailscaled.service
   Wants=network-online.target

   [Service]
   ExecStart=/usr/bin/node /opt/cowork-agent/scripts/relay.mjs --name console.example.com --port 80
   Restart=always
   RestartSec=5
   DynamicUser=yes
   AmbientCapabilities=CAP_NET_BIND_SERVICE

   [Install]
   WantedBy=multi-user.target
   ```

   Then `sudo systemctl daemon-reload && sudo systemctl enable --now bridge-relay`. `journalctl -u bridge-relay -f` shows its log. `Restart=always` also covers the case where Tailscale comes up after the relay.

   Port 80 needs the capability line above. Without it, use `--port 8787` and add `:8787` to the addresses below.

### Behind nginx (HTTPS)

If the server already serves sites with nginx on its Tailscale address, put the relay behind it instead of on port 80. Ready-made files are in `deploy/`:

1. DNS: `console.example.com` → the server's Tailscale IP. Get a certificate for it the way you did for your other sites (the address is private, so it has to be a DNS challenge).
2. `deploy/bridge-relay.service` → `/etc/systemd/system/` (the relay on `127.0.0.1:8787`), then `sudo systemctl daemon-reload && sudo systemctl enable --now bridge-relay`.
3. `deploy/nginx-agents.hirolab.space.conf` → `/etc/nginx/sites-available/`, link it into `sites-enabled`, then `sudo nginx -t && sudo systemctl reload nginx`.

nginx must pass `X-Real-IP $remote_addr`: the relay checks that this address is in the tailnet. Change `agents.hirolab.space` in both files to your name.

## Laptop, once

```sh
node scripts/console.mjs --connect http://console.example.com
```

Or, without a command: open the console on the laptop, enter the address under **Cloud** in the sidebar, and click *Connect*. The address is saved in `<state dir>/console/cloud.json`. From then on, the console connects every time it starts, from the shortcut as well, and reconnects by itself after sleep or a network change. `node scripts/console.mjs --disconnect` forgets it.

## Phone

Open `http://console.example.com` with the Tailscale app connected. Bookmark it or add it to the home screen. If the laptop's console is not running, the page says the laptop is offline and retries.

For the console to work while you are away, the laptop must stay awake on power (Windows: Settings → System → Power → Sleep: Never when plugged in; closing the lid: Do nothing), with the console, Codex Desktop, and the selected Claude Code session open.

## Notes

- Traffic between devices is encrypted by Tailscale (WireGuard), so plain `http://` is fine here. For `https://`, put Caddy in front of the relay and get a certificate with a DNS challenge (the name points to a private address, so the HTTP challenge cannot work).
- Requests and uploads pass through the relay in memory. Nothing is stored on the server.
- One laptop per relay.
