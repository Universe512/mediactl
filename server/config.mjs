import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const dataDir = process.env.DATA_DIR || "/data";
const configPath = process.env.CONFIG_PATH || path.join(dataDir, "config.yaml");
const examplePath = process.env.CONFIG_EXAMPLE || path.resolve("config/config.example.yaml");

let cached;

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function id(value, fallback) {
  const clean = text(value, fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) throw new Error("Every item needs an id.");
  return clean.slice(0, 48);
}

function port(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid port: ${value}`);
  return parsed;
}

function host(value) {
  const clean = text(value);
  if (!clean || !/^[a-zA-Z0-9._:-]+$/.test(clean)) throw new Error(`Invalid host: ${value}`);
  return clean;
}

export function normalizeConfig(input = {}) {
  const serviceIds = new Set();
  const terminalIds = new Set();
  const services = (Array.isArray(input.services) ? input.services : []).map((item, index) => {
    const serviceId = id(item.id, item.name || `service-${index + 1}`);
    if (serviceIds.has(serviceId)) throw new Error(`Duplicate service id: ${serviceId}`);
    serviceIds.add(serviceId);
    const scheme = item.scheme === "https" ? "https" : "http";
    return {
      id: serviceId,
      name: text(item.name, serviceId),
      monogram: text(item.monogram, text(item.name, serviceId).slice(0, 2)).slice(0, 3).toUpperCase(),
      description: text(item.description, "Managed service"),
      host: host(item.host),
      port: port(item.port, scheme === "https" ? 443 : 80),
      scheme,
      publicHost: host(item.publicHost),
      container: text(item.container),
      color: ["violet", "purple", "blue", "indigo", "amber", "cyan", "sky", "green"].includes(item.color) ? item.color : "violet",
      enabled: item.enabled !== false,
    };
  });

  const terminals = (Array.isArray(input.terminals) ? input.terminals : []).map((item, index) => {
    const terminalId = id(item.id, item.name || `terminal-${index + 1}`);
    if (terminalIds.has(terminalId)) throw new Error(`Duplicate terminal id: ${terminalId}`);
    terminalIds.add(terminalId);
    const keyFile = path.basename(text(item.keyFile, "id_ed25519"));
    if (keyFile !== text(item.keyFile, "id_ed25519")) throw new Error("SSH keyFile must be a file name, not a path.");
    return {
      id: terminalId,
      name: text(item.name, terminalId),
      host: host(item.host),
      port: port(item.port, 22),
      username: text(item.username),
      keyFile,
      hostFingerprint: text(item.hostFingerprint),
    };
  });

  return {
    site: {
      name: text(input.site?.name, "mediactl"),
      node: text(input.site?.node, "server"),
      address: text(input.site?.address, "local"),
    },
    services,
    terminals,
  };
}

export async function loadConfig(force = false) {
  if (cached && !force) return cached;
  await mkdir(dataDir, { recursive: true });
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    raw = await readFile(examplePath, "utf8");
    await writeFile(configPath, raw, { mode: 0o600 });
  }
  cached = normalizeConfig(YAML.parse(raw));
  return cached;
}

export async function saveConfig(input) {
  const normalized = normalizeConfig(input);
  const temporary = `${configPath}.tmp`;
  await mkdir(dataDir, { recursive: true });
  await writeFile(temporary, YAML.stringify(normalized, { lineWidth: 0 }), { mode: 0o600 });
  await rename(temporary, configPath);
  cached = normalized;
  return normalized;
}

export function publicConfig(config) {
  return config;
}

export function findService(config, idValue) {
  return config.services.find((service) => service.id === idValue);
}

export function findTerminal(config, idValue) {
  return config.terminals.find((terminal) => terminal.id === idValue);
}
