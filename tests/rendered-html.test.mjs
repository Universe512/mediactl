import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the mediactl application", async () => {
  const [page, layout, compose, caddy, manager] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../Caddyfile", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /mediactl — Remote server control/);
  assert.match(page, /TerminalPane/);
  assert.match(page, /Dashboard settings/);
  assert.match(page, /Restart stack/);
  assert.match(manager, /WebSocketServer/);
  assert.match(manager, /docker\.getContainer/);
  assert.match(manager, /SSHClient/);
  assert.match(compose, /LOCAL_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(compose, /LOCAL_ACCESS_TOKEN/);
  assert.match(compose, /profiles: \[cloudflare\]/);
  assert.match(compose, /docker-socket-proxy/);
  assert.match(compose, /cloudflare\/cloudflared/);
  assert.match(caddy, /reverse_proxy manager:4000/);
  assert.match(caddy, /header_up X-Mediactl-Local 1/);
  assert.match(manager, /timingSafeEqual/);
  assert.match(page, /sessionStorage/);
  await access(new URL("../dist/standalone/server.js", import.meta.url));
});
