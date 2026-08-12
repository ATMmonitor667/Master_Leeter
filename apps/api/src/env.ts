import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader.
 *
 * Deliberately not `dotenv`. This runs once at boot, reads two files, and has
 * no behaviour worth a dependency — and the failure mode it prevents is the
 * expensive kind: a variable was set in `apps/api/.env.local`, nothing read it,
 * and the server booted with `runner: "none"` while looking perfectly healthy.
 * A config file that is silently ignored is worse than no config file.
 *
 * Rules, in order of precedence:
 *
 *   1. Real environment variables always win. CI and production set them for a
 *      reason; a stale local file must never override a deployed secret.
 *   2. `.env.local` — personal, gitignored, holds real credentials.
 *   3. `.env`       — shared defaults, may be committed.
 *
 * Both files are optional. A missing file is silence, not an error: the API is
 * designed to boot without a judge model or a realtime key (M2-4), so absence
 * is a supported state rather than a misconfiguration.
 *
 * NOT imported by the module graph at import time — `loadEnv()` is called
 * explicitly from `start()`. Tests must never inherit a developer's personal
 * credentials by side effect of importing a module.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** apps/api — where a service-specific .env.local naturally lives. */
const API_ROOT = join(here, "..");

/** Repo root — where .env.example sits, so where people expect .env to go. */
const REPO_ROOT = join(here, "../../..");

/**
 * Parse a .env file body.
 *
 * Supports `KEY=value`, `export KEY=value`, `#` comments, blank lines, and
 * single or double quoted values. Escape sequences are not interpreted: an API
 * key containing a literal backslash should survive this function unchanged,
 * which matters more here than supporting `\n` in a config value.
 */
export function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (key === "") continue;

    let value = line.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);

    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Trailing comments are only stripped from unquoted values. A `#` inside
      // quotes is part of the secret, and secrets do contain `#`.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

function readIfPresent(path: string): Record<string, string> | undefined {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    // ENOENT is the expected case, and any other read failure should not stop
    // a server that is designed to run without these files at all.
    return undefined;
  }
}

export interface LoadEnvResult {
  /** Files that existed and were read, in the order applied. */
  loaded: string[];
  /** Names of variables this call actually set. Never their values. */
  applied: string[];
}

/**
 * Populate `process.env` from the .env files, without clobbering real ones.
 *
 * Returns what it did so the caller can log it. The log line names variables
 * but never prints values — a boot log is not a place to leak an API key.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): LoadEnvResult {
  const candidates = [
    join(API_ROOT, ".env.local"),
    join(REPO_ROOT, ".env.local"),
    join(API_ROOT, ".env"),
    join(REPO_ROOT, ".env"),
  ];

  const loaded: string[] = [];
  const applied: string[] = [];

  for (const path of candidates) {
    const parsed = readIfPresent(path);
    if (!parsed) continue;
    loaded.push(path);

    for (const [key, value] of Object.entries(parsed)) {
      // Precedence rule 1, and the earlier file wins over the later one.
      if (env[key] !== undefined) continue;
      env[key] = value;
      applied.push(key);
    }
  }

  return { loaded, applied };
}
