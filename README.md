# mediactl

A self-hosted control plane for a home media stack. It runs on Linux with Docker, sits behind Cloudflare Tunnel and Access, and provides:

- configurable service cards (add, remove, reorder in the config, change IPs, ports, hostnames, and container names);
- live reachability, Docker state, CPU, and memory sampling;
- container restart, stack restart, and recent log controls;
- dynamic hostname proxying, so IP and port edits apply immediately;
- a real, interactive browser terminal over SSH with resize, color, scrollback, and multiple target tabs;
- a token-protected LAN listener that can be enabled before DNS is ready;
- no direct manager or Docker API ports and no SSH private keys sent to the browser.

## Architecture

```text
Browser
  ├─ LAN IP:8088 + local access token
  └─ Cloudflare Access + outbound-only Tunnel
      └─ Caddy gateway
          ├─ portal (React UI)
          └─ manager (config, metrics, Docker controls, SSH, service proxy)
              └─ restricted Docker socket proxy
```

The management container is the only component that can reach the restricted Docker API. The socket proxy is on an internal Docker network and has no published port. Only Caddy's dedicated LAN listener is published, and it requires `LOCAL_ACCESS_TOKEN` for APIs and terminal WebSockets.

## Linux installation

Requirements: Docker Engine with the Compose plugin and network access from this machine to the media services and SSH targets. Cloudflare and DNS can be added later.

```bash
git clone https://github.com/Universe512/mediactl.git
cd mediactl
./install.sh
```

The first run creates `.env` and `secrets/`, then stops so you can add your settings. Find the LXC's LAN IP and generate a private token:

```bash
hostname -I
openssl rand -hex 32
```

Edit `.env`. Use the LXC address shown by `hostname -I`, and paste the random value from the second command:

```dotenv
ROOT_DOMAIN=example.com
DASHBOARD_SUBDOMAIN=media
CLOUDFLARE_TUNNEL_TOKEN=paste-your-tunnel-token-here
LOCAL_BIND_ADDRESS=10.0.0.50
LOCAL_PORT=8088
LOCAL_ACCESS_TOKEN=paste-the-random-value-here
REQUIRE_CF_ACCESS=true
```

Cloudflare may stay as the placeholder for now. Optionally copy your SSH key, then run the installer again:

```bash
cp /home/YOUR_USER/.ssh/id_ed25519 secrets/id_ed25519
chmod 600 secrets/id_ed25519
./install.sh
```

Open `http://10.0.0.50:8088` (substitute your LXC IP), enter `LOCAL_ACCESS_TOKEN`, and the dashboard will load. The token is stored only in that browser tab's session storage. On first start, `config/config.example.yaml` is copied into the persistent `mediactl-data` volume. After that, use the gear button to edit cards and SSH targets. Those changes survive container rebuilds.

When the dashboard is opened over its local HTTP address, each card's **open** link goes directly to the configured private IP and port. Your computer must be able to reach that service IP. The dashboard cannot make a browser reach a network that the browser itself cannot route to.

To keep local access limited to the LXC itself, set `LOCAL_BIND_ADDRESS=127.0.0.1`. To use it from other LAN devices, bind the exact LXC LAN IP; avoid `0.0.0.0` unless you understand the exposure.

### Enable LAN access on an existing installation

Pull the update, find the LXC address, and generate a token:

```bash
cd mediactl
git pull
hostname -I
openssl rand -hex 32
nano .env
```

Add these lines to `.env`, substituting the LXC address and generated token:

```dotenv
LOCAL_BIND_ADDRESS=10.0.0.50
LOCAL_PORT=8088
LOCAL_ACCESS_TOKEN=your-generated-token
```

Then apply the update and open the printed address:

```bash
./install.sh
```

## Cloudflare setup

1. In Zero Trust, create an Access application before publishing the tunnel. Choose a self-hosted/public-hostname application and protect both `media.example.com` and the service hostnames with an Allow policy for only your account or group. Cloudflare Access is deny-by-default when no Allow policy matches.
2. Create a remotely managed Cloudflare Tunnel and copy its token into `.env`.
3. Add a published application route for `media.example.com` with the service URL `http://gateway:80`.
4. Add the card hostnames (for example `jellyfin.example.com`, `radarr.example.com`) to the same tunnel, also pointing to `http://gateway:80`. If your certificate and DNS setup support the wildcard you intend to use, a wildcard route avoids adding a route for each future card.
5. For every route, enable **Protect with Access** so `cloudflared` validates the Access JWT before forwarding to the origin. Keep `REQUIRE_CF_ACCESS=true` as a second check in the manager.

After adding the real tunnel token, start Cloudflare without changing the local setup:

```bash
docker compose --profile cloudflare up -d
```

Cloudflare recommends creating the Access app before the tunnel route and validating the Access token at the origin. See [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) and [Cloudflare Tunnel origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).

No router port-forward is required. If the host firewall filters outbound traffic, Cloudflare documents TCP/UDP port `7844` as the tunnel transport; see [Tunnel with firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).

## Configure cards

Open the gear button and edit a card's:

- private `IP / host` and `Port` used by the gateway;
- public hostname opened by the card;
- Docker container name used for stats, restart, and logs;
- label, monogram, description, color, and visibility.

Cards without a container name still receive a network reachability check, but Docker controls are disabled. The public hostname must also exist as a Cloudflare Tunnel route. Requests for unknown hostnames receive a 404 instead of becoming an open proxy.

## Configure the terminal

The terminal is a real SSH PTY, not a simulated command box. The browser sends keystrokes over an authenticated WebSocket; the manager connects to the selected private host with the mounted key.

Create a dedicated SSH user with only the permissions you want a remote administrator to have. Put its private key in `./secrets`, then enter only the file name (for example `id_ed25519`) in dashboard settings. Key paths are deliberately rejected.

Pinning a server host key is recommended. Get the SHA-256 fingerprint from a trusted LAN session:

```bash
ssh-keyscan -t ed25519 10.0.0.4 2>/dev/null | ssh-keygen -lf - -E sha256
```

Copy the `SHA256:...` value into that terminal target's **Host fingerprint** field. An incorrect fingerprint causes the connection to fail closed.

## Operations

```bash
docker compose logs -f manager gateway tunnel
docker compose pull
docker compose --profile cloudflare up -d --build
```

The Docker socket grants powerful host-level control. This stack reduces exposure with a dedicated socket proxy and an internal-only Docker network. Keep the local token private, restrict the LAN listener with the LXC/firewall, and keep remote access behind Cloudflare Access with MFA. Do not publish the manager or Docker proxy directly.

Native TV clients often cannot complete an interactive Access login. For remote playback in those apps, use a separate, narrowly scoped policy or a VPN; keep the admin dashboard and terminal behind Access.

## Local development

Run the manager and UI in separate terminals:

```bash
REQUIRE_CF_ACCESS=false DATA_DIR=./.test-data node server/index.mjs
npm run dev
```

Then open `http://localhost:3000`. The development server proxies `/api` and `/ws` to the manager on port 4000.

## Validation

```bash
npm test
docker compose config --quiet
```
