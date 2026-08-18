"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Color = "violet" | "purple" | "blue" | "indigo" | "amber" | "cyan" | "sky" | "green";
type Service = { id: string; name: string; monogram: string; description: string; host: string; port: number; scheme: "http" | "https"; publicHost: string; container: string; color: Color; enabled: boolean };
type TerminalTarget = { id: string; name: string; host: string; port: number; username: string; keyFile: string; hostFingerprint: string };
type Config = { site: { name: string; node: string; address: string }; services: Service[]; terminals: TerminalTarget[] };
type Runtime = { state: string; detail: string; cpu: number; memory: number; memoryLimit: number; startedAt?: string };
type ServiceStatus = { id: string; container: Runtime | null; network: { reachable: boolean; latencyMs: number | null } };
type Status = { sampledAt: string; uptime: number; services: ServiceStatus[] };

const emptyConfig: Config = { site: { name: "mediactl", node: "server", address: "local" }, services: [], terminals: [] };
const colors: Color[] = ["violet", "purple", "blue", "indigo", "amber", "cyan", "sky", "green"];

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", "x-mediactl-request": "1", ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

async function apiText(url: string) {
  const response = await fetch(url, { headers: { "x-mediactl-request": "1" } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
  return response.text();
}

function formatBytes(value = 0) {
  if (!value) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${String(hours).padStart(2, "0")}h`;
}

function serviceUrl(service: Service) {
  return `${typeof window !== "undefined" && window.location.protocol === "http:" ? "http" : "https"}://${service.publicHost}`;
}

function TerminalPane({ target, onState }: { target: TerminalTarget; onState: (state: string) => void }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver;
    let terminal: import("@xterm/xterm").Terminal;
    let fit: import("@xterm/addon-fit").FitAddon;
    const connect = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !elementRef.current) return;
      terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.35,
        scrollback: 5000,
        theme: { background: "#1d1f27", foreground: "#e7e8ed", cursor: "#a78bfa", black: "#1d1f27", brightBlack: "#777b8b", green: "#68d391", yellow: "#f6c85f", blue: "#8da8ff", magenta: "#b89cff", cyan: "#67d4d1", white: "#f4f4f6" },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(elementRef.current);
      fit.fit();
      terminal.writeln(`\x1b[38;5;141mmediactl\x1b[0m connecting to ${target.username}@${target.host}…\r\n`);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal?target=${encodeURIComponent(target.id)}`);
      socketRef.current = socket;
      onState("connecting");
      socket.onopen = () => socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "data") terminal.write(message.data);
        if (message.type === "ready") { onState("connected"); terminal.focus(); }
        if (message.type === "error") { onState("error"); terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`); }
        if (message.type === "exit") { onState("closed"); terminal.writeln("\r\n\x1b[90mSession closed.\x1b[0m"); }
      };
      socket.onerror = () => onState("error");
      socket.onclose = () => onState("closed");
      terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "data", data })));
      terminal.onResize(({ cols, rows }) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "resize", cols, rows })));
      resizeObserver = new ResizeObserver(() => { fit.fit(); });
      resizeObserver.observe(elementRef.current);
    };
    void connect();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      socketRef.current?.close();
      terminal?.dispose();
    };
  }, [target, onState]);

  return <div className="terminal-mount" ref={elementRef} />;
}

export default function Home() {
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [draft, setDraft] = useState<Config>(emptyConfig);
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<"services" | "terminal">("services");
  const [selectedTerminal, setSelectedTerminal] = useState("");
  const [terminalState, setTerminalState] = useState("closed");
  const [terminalSession, setTerminalSession] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logs, setLogs] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api<Status>("/api/status")); } catch (cause) { setError((cause as Error).message); }
  }, []);

  useEffect(() => {
    void api<Config>("/api/config").then((value) => {
      setConfig(value); setDraft(structuredClone(value)); setSelectedTerminal(value.terminals[0]?.id || "");
    }).catch((cause) => setError(cause.message));
    void refreshStatus();
    const timer = window.setInterval(refreshStatus, 12_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const statusMap = useMemo(() => new Map(status?.services.map((item) => [item.id, item]) || []), [status]);
  const enabledServices = config.services.filter((service) => service.enabled);
  const healthy = enabledServices.filter((service) => {
    const item = statusMap.get(service.id);
    return item?.container ? item.container.state === "running" : item?.network.reachable;
  }).length;
  const activeTarget = config.terminals.find((target) => target.id === selectedTerminal);

  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label); setError("");
    try { await action(); setNotice(`${label} complete`); await refreshStatus(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  };

  const save = async () => {
    await mutate("Configuration saved", async () => {
      const value = await api<Config>("/api/config", { method: "PUT", body: JSON.stringify(draft) });
      setConfig(value); setDraft(structuredClone(value)); setSettingsOpen(false);
      if (!value.terminals.some((item) => item.id === selectedTerminal)) setSelectedTerminal(value.terminals[0]?.id || "");
    });
  };

  const updateService = (index: number, patch: Partial<Service>) => setDraft((current) => ({ ...current, services: current.services.map((service, itemIndex) => itemIndex === index ? { ...service, ...patch } : service) }));
  const updateTerminal = (index: number, patch: Partial<TerminalTarget>) => setDraft((current) => ({ ...current, terminals: current.terminals.map((target, itemIndex) => itemIndex === index ? { ...target, ...patch } : target) }));

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="identity"><strong>{config.site.name}</strong><span>{config.site.node} · {config.site.address}</span></div>
        <div className="health"><span className={`status-dot ${healthy === enabledServices.length ? "ok" : "warn"}`} />{healthy} of {enabledServices.length} services healthy <code>uptime {formatUptime(status?.uptime)}</code><button className="icon-button" onClick={() => { setDraft(structuredClone(config)); setSettingsOpen(true); }} aria-label="Open configuration">⚙</button></div>
      </header>

      <nav className="tabs" aria-label="Dashboard sections">
        <button className={tab === "services" ? "active" : ""} onClick={() => setTab("services")}>services</button>
        <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>terminal</button>
      </nav>

      {error && <div className="alert"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
      {notice && <div className="toast">✓ {notice}</div>}

      {tab === "services" ? (
        <section className="workspace services-view">
          <div className="section-bar"><div><h1>Services</h1><span>Container stats sampled {status ? Math.max(0, Math.round((Date.now() - new Date(status.sampledAt).getTime()) / 1000)) : "—"}s ago</span></div><div className="actions"><button onClick={() => { setDraft(structuredClone(config)); setSettingsOpen(true); }}>Edit cards</button><button className="primary" disabled={Boolean(busy)} onClick={() => void mutate("Stack restart", () => api("/api/stack/restart", { method: "POST" }))}>Restart stack</button></div></div>
          <div className="service-grid">
            {enabledServices.map((service) => {
              const item = statusMap.get(service.id);
              const runtime = item?.container;
              const state = runtime?.state || (item?.network.reachable ? "running" : "offline");
              const cpu = runtime?.cpu || 0;
              const memPercent = runtime?.memoryLimit ? Math.min(100, runtime.memory / runtime.memoryLimit * 100) : 0;
              return (
                <article className="service-card" key={service.id}>
                  <div className="service-title"><span className={`monogram ${service.color}`}>{service.monogram}</span><div><h2>{service.name}<span className={`status-dot ${state === "running" ? "ok" : state === "degraded" ? "warn" : "bad"}`} /></h2><code>:{service.port} · {state}</code></div><a href={serviceUrl(service)} target="_blank" rel="noreferrer">open ↗</a></div>
                  <p>{service.description}</p>
                  <div className="metrics"><div><label><span>CPU</span><b>{cpu.toFixed(0)}%</b></label><i><em style={{ width: `${Math.min(100, cpu)}%` }} /></i></div><div><label><span>MEM</span><b>{formatBytes(runtime?.memory)}</b></label><i><em style={{ width: `${memPercent}%` }} /></i></div></div>
                  <div className="card-actions"><button disabled={!service.container || busy === service.id} onClick={() => void mutate(service.id, () => api(`/api/services/${service.id}/restart`, { method: "POST" }))}>Restart</button><button disabled={!service.container} onClick={() => void apiText(`/api/services/${service.id}/logs`).then((body) => setLogs({ title: `${service.name} logs`, body })).catch((cause) => setError(cause.message))}>Logs</button><button className="link-button" onClick={() => { setTab("terminal"); setSelectedTerminal(config.terminals[0]?.id || ""); }}>Shell</button></div>
                </article>
              );
            })}
            {!enabledServices.length && <button className="empty-card" onClick={() => setSettingsOpen(true)}>+ Add your first service card</button>}
          </div>
        </section>
      ) : (
        <section className="workspace terminal-view">
          <div className="section-bar terminal-heading"><div><h1>Terminal</h1><div className="target-tabs">{config.terminals.map((target) => <button key={target.id} className={selectedTerminal === target.id ? "active" : ""} onClick={() => { setSelectedTerminal(target.id); setTerminalSession((value) => value + 1); }}>{target.name}</button>)}</div></div><div className="actions"><span className={`connection-pill ${terminalState}`}>ssh · {terminalState}</span><button onClick={() => setTerminalSession((value) => value + 1)}>{terminalState === "connected" ? "Reconnect" : "Connect"}</button></div></div>
          <div className="terminal-shell"><div className="terminal-chrome"><span><i />{activeTarget ? `${activeTarget.username}@${activeTarget.name} ~` : "No SSH host configured"}</span><code>utf-8</code></div>{activeTarget ? <TerminalPane key={`${activeTarget.id}-${terminalSession}`} target={activeTarget} onState={setTerminalState} /> : <button className="terminal-empty" onClick={() => setSettingsOpen(true)}>Configure an SSH target to start a terminal session.</button>}</div>
        </section>
      )}

      {settingsOpen && <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}><aside className="settings-panel"><div className="settings-header"><div><span>CONFIGURATION</span><h2>Dashboard settings</h2></div><button onClick={() => setSettingsOpen(false)}>×</button></div><div className="settings-body">
        <fieldset><legend>Dashboard</legend><div className="form-grid"><label>Name<input value={draft.site.name} onChange={(event) => setDraft({ ...draft, site: { ...draft.site, name: event.target.value } })} /></label><label>Node label<input value={draft.site.node} onChange={(event) => setDraft({ ...draft, site: { ...draft.site, node: event.target.value } })} /></label><label>Node address<input value={draft.site.address} onChange={(event) => setDraft({ ...draft, site: { ...draft.site, address: event.target.value } })} /></label></div></fieldset>
        <fieldset><legend><span>Service cards</span><button onClick={() => setDraft((current) => ({ ...current, services: [...current.services, { id: `service-${current.services.length + 1}`, name: "New service", monogram: "NS", description: "Managed service", host: "10.0.0.20", port: 8080, scheme: "http", publicHost: "service.example.com", container: "", color: "violet", enabled: true }] }))}>+ Add card</button></legend>{draft.services.map((service, index) => <div className="config-card" key={`${service.id}-${index}`}><div className="config-card-title"><strong>{service.name || "Untitled service"}</strong><button className="danger-link" onClick={() => setDraft((current) => ({ ...current, services: current.services.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button></div><div className="form-grid"><label>Name<input value={service.name} onChange={(event) => updateService(index, { name: event.target.value })} /></label><label>ID<input value={service.id} onChange={(event) => updateService(index, { id: event.target.value })} /></label><label>IP / host<input value={service.host} onChange={(event) => updateService(index, { host: event.target.value })} /></label><label>Port<input type="number" value={service.port} onChange={(event) => updateService(index, { port: Number(event.target.value) })} /></label><label>Public hostname<input value={service.publicHost} onChange={(event) => updateService(index, { publicHost: event.target.value })} /></label><label>Docker container<input value={service.container} onChange={(event) => updateService(index, { container: event.target.value })} /></label><label className="wide">Description<input value={service.description} onChange={(event) => updateService(index, { description: event.target.value })} /></label><label>Color<select value={service.color} onChange={(event) => updateService(index, { color: event.target.value as Color })}>{colors.map((color) => <option key={color}>{color}</option>)}</select></label><label className="check"><input type="checkbox" checked={service.enabled} onChange={(event) => updateService(index, { enabled: event.target.checked })} />Show card</label></div></div>)}</fieldset>
        <fieldset><legend><span>SSH terminal targets</span><button onClick={() => setDraft((current) => ({ ...current, terminals: [...current.terminals, { id: `host-${current.terminals.length + 1}`, name: "new-host", host: "10.0.0.10", port: 22, username: "mediaadmin", keyFile: "id_ed25519", hostFingerprint: "" }] }))}>+ Add host</button></legend>{draft.terminals.map((target, index) => <div className="config-card" key={`${target.id}-${index}`}><div className="config-card-title"><strong>{target.name}</strong><button className="danger-link" onClick={() => setDraft((current) => ({ ...current, terminals: current.terminals.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button></div><div className="form-grid"><label>Name<input value={target.name} onChange={(event) => updateTerminal(index, { name: event.target.value })} /></label><label>ID<input value={target.id} onChange={(event) => updateTerminal(index, { id: event.target.value })} /></label><label>IP / host<input value={target.host} onChange={(event) => updateTerminal(index, { host: event.target.value })} /></label><label>Port<input type="number" value={target.port} onChange={(event) => updateTerminal(index, { port: Number(event.target.value) })} /></label><label>SSH username<input value={target.username} onChange={(event) => updateTerminal(index, { username: event.target.value })} /></label><label>Key file<input value={target.keyFile} onChange={(event) => updateTerminal(index, { keyFile: event.target.value })} /></label><label className="wide">Host fingerprint (optional SHA256)<input value={target.hostFingerprint} onChange={(event) => updateTerminal(index, { hostFingerprint: event.target.value })} placeholder="SHA256:…" /></label></div></div>)}</fieldset>
      </div><div className="settings-footer"><button onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary" disabled={Boolean(busy)} onClick={() => void save()}>Save configuration</button></div></aside></div>}

      {logs && <div className="overlay"><div className="logs-modal"><div><h2>{logs.title}</h2><button onClick={() => setLogs(null)}>×</button></div><pre>{logs.body || "No recent output."}</pre></div></div>}
    </main>
  );
}
