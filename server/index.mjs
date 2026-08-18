import crypto from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Docker from "dockerode";
import express from "express";
import httpProxy from "http-proxy";
import { Client as SSHClient } from "ssh2";
import { WebSocketServer } from "ws";
import { findService, findTerminal, loadConfig, publicConfig, saveConfig } from "./config.mjs";

const port = Number(process.env.PORT || 4000);
const keyDir = process.env.SSH_KEY_DIR || "/run/secrets/ssh";
const requireAccess = process.env.REQUIRE_CF_ACCESS === "true";
const dockerHost = (process.env.DOCKER_HOST || "docker-proxy").replace(/^https?:\/\//, "");
const docker = new Docker({ host: dockerHost, protocol: "http", port: Number(process.env.DOCKER_PORT || 2375), timeout: 5000 });
const app = express();
const server = http.createServer(app);
const terminalWss = new WebSocketServer({ noServer: true });
const serviceProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

function hasAccess(request) {
  return !requireAccess || Boolean(request.headers["cf-access-jwt-assertion"] || request.headers["cf-access-authenticated-user-email"]);
}

function accessGuard(request, response, next) {
  if (!hasAccess(request)) return response.status(401).json({ error: "Cloudflare Access identity required." });
  next();
}

function mutationGuard(request, response, next) {
  if (request.get("x-mediactl-request") !== "1") return response.status(403).json({ error: "Missing dashboard request header." });
  next();
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function calculateCpu(stats) {
  const cpuDelta = stats.cpu_stats?.cpu_usage?.total_usage - stats.precpu_stats?.cpu_usage?.total_usage;
  const systemDelta = stats.cpu_stats?.system_cpu_usage - stats.precpu_stats?.system_cpu_usage;
  const cpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  return systemDelta > 0 && cpuDelta > 0 ? Math.min(999, (cpuDelta / systemDelta) * cpus * 100) : 0;
}

function withTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)),
  ]);
}

async function containerStatus(service) {
  if (!service.container) return null;
  try {
    const container = docker.getContainer(service.container);
    const [details, stats] = await withTimeout(Promise.all([container.inspect(), container.stats({ stream: false })]), 5500, "Docker status");
    const memory = stats.memory_stats?.usage || 0;
    const memoryLimit = stats.memory_stats?.limit || 0;
    const health = details.State?.Health?.Status;
    return {
      state: details.State?.Running ? (health === "unhealthy" ? "degraded" : "running") : "stopped",
      detail: health || details.State?.Status || "unknown",
      cpu: Number(calculateCpu(stats).toFixed(1)),
      memory,
      memoryLimit,
      startedAt: details.State?.StartedAt,
    };
  } catch (error) {
    return { state: "unknown", detail: error.statusCode === 404 ? "container not found" : "docker unavailable", cpu: 0, memory: 0, memoryLimit: 0 };
  }
}

async function networkStatus(service) {
  const started = performance.now();
  try {
    const response = await fetch(`${service.scheme}://${service.host}:${service.port}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(2500),
    });
    return { reachable: response.status < 500, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { reachable: false, latencyMs: null };
  }
}

app.get("/health", (_request, response) => response.json({ ok: true }));

app.use("/api", accessGuard);

app.get("/api/config", asyncRoute(async (_request, response) => {
  response.json(publicConfig(await loadConfig()));
}));

app.put("/api/config", mutationGuard, asyncRoute(async (request, response) => {
  response.json(publicConfig(await saveConfig(request.body)));
}));

app.get("/api/status", asyncRoute(async (_request, response) => {
  const config = await loadConfig();
  const services = await Promise.all(config.services.filter((service) => service.enabled).map(async (service) => {
    const [container, network] = await Promise.all([containerStatus(service), networkStatus(service)]);
    return { id: service.id, container, network };
  }));
  response.json({ sampledAt: new Date().toISOString(), uptime: process.uptime(), services });
}));

app.post("/api/services/:id/restart", mutationGuard, asyncRoute(async (request, response) => {
  const service = findService(await loadConfig(), request.params.id);
  if (!service) return response.status(404).json({ error: "Service not found." });
  if (!service.container) return response.status(400).json({ error: "No Docker container is configured for this service." });
  await docker.getContainer(service.container).restart({ t: 15 });
  response.json({ ok: true });
}));

app.get("/api/services/:id/logs", asyncRoute(async (request, response) => {
  const service = findService(await loadConfig(), request.params.id);
  if (!service) return response.status(404).json({ error: "Service not found." });
  if (!service.container) return response.status(400).json({ error: "No Docker container is configured for this service." });
  const output = await docker.getContainer(service.container).logs({ stdout: true, stderr: true, timestamps: true, tail: 250 });
  const clean = output.toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  response.type("text/plain").send(clean.slice(-100_000));
}));

app.post("/api/stack/restart", mutationGuard, asyncRoute(async (_request, response) => {
  const config = await loadConfig();
  const names = [...new Set(config.services.filter((service) => service.enabled && service.container).map((service) => service.container))];
  const results = [];
  for (const name of names) {
    try {
      await docker.getContainer(name).restart({ t: 15 });
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error.reason || error.message });
    }
  }
  response.status(results.some((item) => !item.ok) ? 207 : 200).json({ results });
}));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).json({ error: error.message || "Unexpected server error." });
});

function sanitizedProxyHeaders(headers) {
  const next = { ...headers };
  delete next["cf-access-jwt-assertion"];
  delete next["cf-access-authenticated-user-email"];
  delete next.cookie;
  return next;
}

async function proxyRequest(request, response) {
  if (!hasAccess(request)) return response.writeHead(401).end("Cloudflare Access identity required.");
  const config = await loadConfig();
  const requestHost = String(request.headers.host || "").split(":")[0].toLowerCase();
  const service = config.services.find((item) => item.enabled && item.publicHost.toLowerCase() === requestHost);
  if (!service) return response.writeHead(404).end("Unknown mediactl service host.");
  request.headers = sanitizedProxyHeaders(request.headers);
  serviceProxy.web(request, response, { target: `${service.scheme}://${service.host}:${service.port}` });
}

app.use((request, response) => void proxyRequest(request, response).catch((error) => {
  console.error(error);
  if (!response.headersSent) response.writeHead(502);
  response.end("Service proxy error.");
}));

serviceProxy.on("error", (error, _request, response) => {
  console.error(error);
  if (response?.writeHead && !response.headersSent) response.writeHead(502);
  response?.end?.("Upstream service unavailable.");
});

terminalWss.on("connection", async (socket, request, terminal) => {
  const ssh = new SSHClient();
  let stream;
  const send = (message) => socket.readyState === 1 && socket.send(JSON.stringify(message));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "data" && typeof message.data === "string") stream?.write(message.data);
      if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) stream?.setWindow(message.rows, message.cols, 0, 0);
    } catch { /* malformed client messages are ignored */ }
  });
  socket.on("close", () => ssh.end());

  try {
    const privateKey = await readFile(path.join(keyDir, terminal.keyFile));
    const expectedFingerprint = terminal.hostFingerprint.replace(/^SHA256:/, "");
    ssh.on("ready", () => {
      ssh.shell({ term: "xterm-256color", cols: 120, rows: 34 }, (error, shell) => {
        if (error) return send({ type: "error", message: error.message });
        stream = shell;
        send({ type: "ready", label: `${terminal.username}@${terminal.name}` });
        shell.on("data", (data) => send({ type: "data", data: data.toString("utf8") }));
        shell.stderr.on("data", (data) => send({ type: "data", data: data.toString("utf8") }));
        shell.on("close", () => { send({ type: "exit" }); socket.close(); });
      });
    });
    ssh.on("error", (error) => { send({ type: "error", message: error.message }); socket.close(); });
    ssh.connect({
      host: terminal.host,
      port: terminal.port,
      username: terminal.username,
      privateKey,
      readyTimeout: 12_000,
      keepaliveInterval: 15_000,
      hostVerifier: expectedFingerprint ? (key) => crypto.createHash("sha256").update(key).digest("base64") === expectedFingerprint : undefined,
    });
  } catch (error) {
    send({ type: "error", message: error.code === "ENOENT" ? `SSH key '${terminal.keyFile}' is not mounted.` : error.message });
    socket.close();
  }
});

server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/ws/terminal") {
      if (!hasAccess(request)) return socket.destroy();
      const terminal = findTerminal(await loadConfig(), url.searchParams.get("target"));
      if (!terminal) return socket.destroy();
      terminalWss.handleUpgrade(request, socket, head, (websocket) => terminalWss.emit("connection", websocket, request, terminal));
      return;
    }
    const config = await loadConfig();
    const requestHost = String(request.headers.host || "").split(":")[0].toLowerCase();
    const service = config.services.find((item) => item.enabled && item.publicHost.toLowerCase() === requestHost);
    if (!service || !hasAccess(request)) return socket.destroy();
    request.headers = sanitizedProxyHeaders(request.headers);
    serviceProxy.ws(request, socket, head, { target: `${service.scheme}://${service.host}:${service.port}` });
  } catch {
    socket.destroy();
  }
});

await loadConfig();
server.listen(port, "0.0.0.0", () => console.log(`mediactl manager listening on :${port}`));
