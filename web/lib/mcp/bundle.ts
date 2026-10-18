import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPlainObject, type JsonRpcId, type JsonRpcResponse } from "./jsonrpc";
import { MODERN_PROTOCOL_VERSION } from "./protocol";

// Runs the committed PayBox plugin bundle (web/mcp/owed-plugin.mjs, a byte copy of plugin/dist/plugin.mjs) the way
// PayBox's sandbox does (decision D4): a fresh `node` process per operation, a clean environment, one stateless MCP
// 2026-07-28 request on stdin carrying the per-request _meta envelope (the bundle rejects `initialize`: it serves
// only 2026-07-28), a 10 s budget and 256 KiB of stdout. The process group is killed as soon as the answer is in.

export const BUNDLE_LIMITS = {
  /** PayBox's per-call budget. */
  timeoutMs: 10_000,
  /** PayBox's stdout cap. */
  stdoutBytes: 256 * 1024,
  /** Kept for the server log only; never returned to clients. */
  stderrBytes: 16 * 1024,
  /** Bundle processes one warm instance runs at once; later calls wait for a free slot. */
  concurrency: 8,
  /** How long a call waits for a slot before it is refused as busy. */
  queueMs: 5_000,
} as const;

export const DEFAULT_OWED_BASE_URL = "https://www.getowed.xyz";
const CLIENT_INFO = { name: "owed-remote-mcp", version: "1" } as const;
/** The id the bundle sees; replies are re-labelled with the client's own id. */
const CHILD_ID = 1;

export type BundleFailure = "timeout" | "output_limit" | "exited" | "spawn_failed" | "protocol" | "busy";

export class BundleError extends Error {
  readonly kind: BundleFailure;
  readonly stderr: string;
  constructor(kind: BundleFailure, message: string, stderr = "") {
    super(message);
    this.kind = kind;
    this.stderr = stderr;
  }
}

/** One operation for the bundle: a method and its params, without _meta (the executor adds the envelope). */
export interface BundleCall {
  method: string;
  params?: Record<string, unknown>;
}

export interface BundleRun {
  /** The bundle's JSON-RPC response (id CHILD_ID). */
  message: JsonRpcResponse;
  stderr: string;
  ms: number;
}

export interface BundleOptions {
  bundlePath: string;
  /** OWED_BASE_URL for the plugin. */
  baseUrl: string;
  timeoutMs?: number;
  stdoutBytes?: number;
  /** Extra node flags before the bundle path. Tests only (e.g. a network guard preload); production passes none. */
  nodeArgs?: readonly string[];
}

/** The plugin's whole environment: nothing from this server (no database URL, no tokens, no NODE_OPTIONS). */
export function bundleEnv(baseUrl: string): { PATH: string; OWED_BASE_URL: string; NODE_ENV: "production"; NO_COLOR: "1" } {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    OWED_BASE_URL: baseUrl,
    NODE_ENV: "production",
    NO_COLOR: "1",
  };
}

/** The plugin's OWED_BASE_URL: OWED_MCP_BASE_URL when set, else production. */
export function bundleBaseUrl(): string {
  return process.env.OWED_MCP_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_OWED_BASE_URL;
}

/**
 * The committed bundle's path. Next traces web/mcp/owed-plugin.mjs into the /api/mcp function
 * (outputFileTracingIncludes in next.config.ts), and the function runs from the project directory (web/).
 */
export function bundlePath(cwd = process.cwd()): string {
  const candidates = [join(cwd, "mcp", "owed-plugin.mjs"), join(cwd, "web", "mcp", "owed-plugin.mjs")];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

/** web/mcp/owed-plugin.meta.json, written by scripts/sync-mcp-bundle.mjs next to the bundle. */
export interface BundleMeta {
  file: string;
  bytes: number;
  sha256: string;
  protocolVersion: string;
  server: { name: string; version: string };
  tools: string[];
}

export function readBundleMeta(path = bundlePath()): BundleMeta {
  return JSON.parse(readFileSync(join(dirname(path), "owed-plugin.meta.json"), "utf8")) as BundleMeta;
}

/** The JSON line the bundle receives: the operation with this endpoint's own 2026-07-28 envelope. */
export function bundleRequest(call: BundleCall): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id: CHILD_ID,
    method: call.method,
    params: {
      ...call.params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  })}\n`;
}

function validResponse(value: unknown, id: JsonRpcId): value is JsonRpcResponse {
  if (!isPlainObject(value) || value.jsonrpc !== "2.0" || value.id !== id) return false;
  if (("result" in value) === ("error" in value)) return false;
  if ("result" in value) return isPlainObject(value.result);
  return isPlainObject(value.error) && typeof value.error.code === "number" && typeof value.error.message === "string";
}

/** Spawns the bundle once for one operation. */
export function runBundle(call: BundleCall, options: BundleOptions): Promise<BundleRun> {
  const timeoutMs = options.timeoutMs ?? BUNDLE_LIMITS.timeoutMs;
  const stdoutCap = options.stdoutBytes ?? BUNDLE_LIMITS.stdoutBytes;
  const started = performance.now();
  return new Promise<BundleRun>((resolve, reject) => {
    let stderr = "";
    let stdoutBytes = 0;
    let pending = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const stop = () => {
      if (child?.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL"); // the whole process group: nothing the plugin started survives
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const finish = (error: BundleError | null, message?: JsonRpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (error) reject(error);
      else resolve({ message: message!, stderr, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish(new BundleError("timeout", `the plugin did not answer within ${timeoutMs} ms`, stderr)), timeoutMs);

    try {
      child = spawn(process.execPath, [...(options.nodeArgs ?? []), options.bundlePath], {
        cwd: dirname(options.bundlePath),
        env: bundleEnv(options.baseUrl),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      finish(new BundleError("spawn_failed", `could not start the plugin: ${(error as Error).message}`));
      return;
    }

    child.on("error", (error) => finish(new BundleError("spawn_failed", `could not start the plugin: ${error.message}`, stderr)));
    child.on("close", (code, signal) => finish(new BundleError("exited", `the plugin exited (${code ?? signal}) before answering`, stderr)));
    child.stdin!.on("error", () => undefined); // a plugin that exits early closes its stdin; "close" reports it
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < BUNDLE_LIMITS.stderrBytes) stderr += chunk.toString("utf8").slice(0, BUNDLE_LIMITS.stderrBytes - stderr.length);
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutCap) {
        finish(new BundleError("output_limit", `the plugin wrote more than ${stdoutCap} bytes`, stderr));
        return;
      }
      pending += chunk.toString("utf8");
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish(new BundleError("protocol", `the plugin wrote non-JSON to stdout: ${JSON.stringify(line.slice(0, 80))}`, stderr));
          return;
        }
        if (isPlainObject(parsed) && !("id" in parsed)) continue; // logging / progress notifications
        if (!validResponse(parsed, CHILD_ID)) {
          finish(new BundleError("protocol", "the plugin returned an invalid JSON-RPC response", stderr));
          return;
        }
        finish(null, parsed);
        return;
      }
    });

    child.stdin!.write(bundleRequest(call));
  });
}

/** At most `max` bundle processes at once per instance; a call that can't get a slot within `waitMs` is refused. */
export function createSlots(max: number, waitMs: number) {
  let active = 0;
  const queue: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  const release = () => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else {
      active -= 1;
    }
  };
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active < max) {
        active += 1;
      } else {
        await new Promise<void>((grant, refuse) => {
          const entry = {
            grant,
            timer: setTimeout(() => {
              queue.splice(queue.indexOf(entry), 1);
              refuse(new BundleError("busy", `no free plugin slot within ${waitMs} ms`));
            }, waitMs),
          };
          queue.push(entry);
        });
      }
      try {
        return await work();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
  };
}

export type BundleExecutor = (call: BundleCall) => Promise<JsonRpcResponse>;

/** The production executor: the committed bundle, OWED_MCP_BASE_URL (else production), PayBox's limits. */
export function bundleExecutor(options: Partial<BundleOptions> & { concurrency?: number; queueMs?: number } = {}): BundleExecutor {
  const slots = createSlots(options.concurrency ?? BUNDLE_LIMITS.concurrency, options.queueMs ?? BUNDLE_LIMITS.queueMs);
  return async (call) => {
    const run = await slots.run(() => runBundle(call, {
      bundlePath: options.bundlePath ?? bundlePath(),
      baseUrl: options.baseUrl ?? bundleBaseUrl(),
      timeoutMs: options.timeoutMs,
      stdoutBytes: options.stdoutBytes,
      nodeArgs: options.nodeArgs,
    }));
    return run.message;
  };
}
