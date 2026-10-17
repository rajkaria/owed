// Preloaded into the plugin process by plugin-e2e.mjs as
//   node --import file:///…/net-guard.mjs?policy=allow&hosts=a.example,b.example dist/plugin.mjs
// It enforces the PayBox sandbox network rule (HTTPS only, to exact configured hosts) for every socket the plugin
// opens: fetch/undici, http(s), ws, everything goes through net.Socket.prototype.connect. Each attempt is reported
// on stderr as one line `OWED_E2E_NET {json}` for the harness to collect. Policy comes from this module's own URL
// so nothing is added to the plugin's environment.
import net from "node:net";
import tls from "node:tls";

const params = new URL(import.meta.url).searchParams;
const policy = params.get("policy") ?? "none"; // none | allow | any
const hosts = new Set((params.get("hosts") ?? "").split(",").filter(Boolean).map((host) => host.toLowerCase()));
const connect = net.Socket.prototype.connect;

function target(args) {
  let [first, second] = args;
  if (Array.isArray(first)) [first, second] = first; // net.connect() passes already-normalized [options, callback]
  if (first !== null && typeof first === "object") {
    if (first.path) return { path: String(first.path) };
    return { host: String(first.host ?? first.hostname ?? "localhost").toLowerCase(), port: Number(first.port) };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof second === "string" ? second.toLowerCase() : "localhost", port: Number(first) };
}

function report(entry) {
  try { process.stderr.write(`OWED_E2E_NET ${JSON.stringify(entry)}\n`); } catch { /* stderr closed: nothing to report to */ }
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const where = target(args);
  const secure = this instanceof tls.TLSSocket;
  let reason = null;
  if (where.path) reason = "local sockets are not reachable from the PayBox sandbox";
  else if (policy === "none") reason = "no network is allowed in this phase";
  else if (policy === "allow" && !secure) reason = "only HTTPS is allowed";
  else if (policy === "allow" && where.port !== 443) reason = "only port 443 is allowed";
  else if (policy === "allow" && !hosts.has(where.host)) reason = "host is not in the configured host list";
  report({ host: where.host ?? null, port: where.port ?? null, path: where.path ?? null, tls: secure, allowed: reason === null, reason });
  if (reason === null) return connect.apply(this, args);
  const error = Object.assign(new Error(`connect ECONNREFUSED ${where.host ?? where.path}:${where.port ?? ""} (owed-e2e sandbox: ${reason})`), { code: "ECONNREFUSED" });
  process.nextTick(() => this.destroy(error));
  return this;
};
