import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [, , command, artifactArgument] = process.argv;
const acknowledgement = "I_UNDERSTAND_THIS_REPLACES_THE_TARGET";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function database(name) {
  const raw = process.env[name]?.trim();
  if (!raw) fail(`${name} is required`);
  let url;
  try { url = new URL(raw); } catch { fail(`${name} must be a PostgreSQL URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) {
    fail(`${name} must be a PostgreSQL URL with a database name`);
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!databaseName || databaseName.includes("/")) fail(`${name} must contain exactly one database name`);
  if (["template0", "template1"].includes(databaseName)) fail(`${name} may not target a template database`);
  const port = url.port || "5432";
  const user = decodeURIComponent(url.username);
  if (!user) fail(`${name} must include a database user`);
  return {
    host: url.hostname,
    port,
    user,
    password: decodeURIComponent(url.password),
    databaseName,
    sslmode: tlsMode(url),
    fingerprint: createHash("sha256").update(`${url.hostname.toLowerCase()}\0${port}\0${databaseName}`).digest("hex"),
  };
}

function isLocal(host) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
}

function tlsMode(url) {
  const supplied = url.searchParams.get("sslmode");
  if ([...url.searchParams.keys()].some((key) => key !== "sslmode")) fail("Unsupported PostgreSQL URL option");
  if (!isLocal(url.hostname)) {
    if (supplied && supplied !== "verify-full") fail("Remote recovery connections require sslmode=verify-full");
    return "verify-full";
  }
  if (supplied && !["disable", "prefer", "require", "verify-ca", "verify-full"].includes(supplied)) fail("Invalid sslmode");
  return supplied || "prefer";
}

function postgresArgs(connection) {
  return [
    "--host", connection.host,
    "--port", connection.port,
    "--username", connection.user,
    "--dbname", connection.databaseName,
    "--no-password",
  ];
}

async function run(executable, args, connection, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      ...options,
      env: {
        ...process.env,
        PGPASSWORD: connection?.password ?? "",
        PGSSLMODE: connection?.sslmode ?? "prefer",
      },
      stdio: options.stdio ?? ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", (error) => reject(new Error(`${executable} could not start: ${error.code ?? error.message}`)));
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${executable} failed (${signal ? `signal ${signal}` : `exit ${code}`})`)));
  });
}

function artifactPath(value) {
  if (!value || !isAbsolute(value)) fail("Provide an absolute backup artifact path");
  const path = resolve(value);
  const insideRepository = relative(resolve(dirname(fileURLToPath(import.meta.url)), ".."), path);
  if (!insideRepository || (!insideRepository.startsWith("..") && !isAbsolute(insideRepository))) {
    fail("Database artifacts may not be written inside the repository");
  }
  if (extname(path) !== ".dump") fail("Backup artifacts must use the .dump extension");
  return path;
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function sha256(path) {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function backup(path) {
  const source = database("BACKUP_DATABASE_URL");
  if (await exists(path) || await exists(`${path}.manifest.json`)) fail("Refusing to overwrite an existing backup or manifest");
  await mkdir(dirname(path), { recursive: true });
  await run("pg_dump", [
    ...postgresArgs(source),
    "--format=custom",
    "--schema=public",
    "--no-owner",
    "--file", path,
  ], source);
  const details = await stat(path);
  const manifest = {
    format: "master-leeter-public-backup-v1",
    createdAt: new Date().toISOString(),
    release: (process.env.RELEASE_SHA || process.env.RENDER_GIT_COMMIT || "unknown").slice(0, 64),
    sourceFingerprint: source.fingerprint,
    bytes: details.size,
    sha256: await sha256(path),
    artifact: path.split(/[\\/]/).at(-1),
  };
  await writeFile(`${path}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Backup created: ${path}`);
  console.log(`Manifest created: ${path}.manifest.json`);
}

async function readManifest(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(`${path}.manifest.json`, "utf8"));
  } catch {
    fail("Backup manifest is missing or invalid JSON");
  }
  if (parsed?.format !== "master-leeter-public-backup-v1" || !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
      !/^[a-f0-9]{64}$/.test(parsed.sourceFingerprint) || !Number.isSafeInteger(parsed.bytes) || parsed.bytes <= 0) {
    fail("Backup manifest is invalid");
  }
  const details = await stat(path);
  if (details.size !== parsed.bytes || await sha256(path) !== parsed.sha256) fail("Backup checksum or size does not match its manifest");
  return parsed;
}

async function verify(path) {
  await readManifest(path);
  await run("pg_restore", ["--list", path], undefined);
  console.log("Backup checksum and archive catalogue verified.");
}

async function restore(path) {
  const manifest = await readManifest(path);
  const target = database("RESTORE_DATABASE_URL");
  if (target.fingerprint === manifest.sourceFingerprint) fail("Restore target matches the backup source; use an isolated database");
  if (process.env.RESTORE_CONFIRM_DATABASE !== target.databaseName) fail("RESTORE_CONFIRM_DATABASE must exactly match the target database name");
  if (process.env.RESTORE_ISOLATED_ACK !== acknowledgement) fail(`RESTORE_ISOLATED_ACK must equal ${acknowledgement}`);
  await run("pg_restore", [
    ...postgresArgs(target),
    "--clean",
    "--if-exists",
    "--no-owner",
    "--exit-on-error",
    "--single-transaction",
    path,
  ], target);
  const required = [
    "interview_sessions", "session_events", "session_reports", "socket_tickets",
    "consent_grants", "session_runtime_owners", "runtime_inputs",
    "interview_preparations", "api_rate_limits", "interview_questions",
    "privacy_deletion_requests", "support_incidents",
  ];
  const sql = `SELECT coalesce(string_agg(required.name, ',' ORDER BY required.name), '') FROM unnest(ARRAY[${required.map((name) => `'${name}'`).join(",")}]) AS required(name) WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=required.name);`;
  let output = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn("psql", [...postgresArgs(target), "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", sql], {
      env: { ...process.env, PGPASSWORD: target.password, PGSSLMODE: target.sslmode },
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => reject(new Error(`psql could not start: ${error.code ?? error.message}`)));
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`psql failed (exit ${code})`)));
  });
  if (output.trim()) fail(`Restore completed but required application tables are missing: ${output.trim()}`);
  console.log("Isolated restore completed and required application tables verified. Run db:migrate --status and release:preflight --database before reopening admission.");
  console.log("Do not expose this database until erasure reconciliation and application smoke checks are recorded.");
}

if (!["backup", "verify", "restore"].includes(command) || !artifactArgument) {
  fail("Usage: node scripts/database-recovery.mjs <backup|verify|restore> <absolute-path.dump>");
}

const artifact = artifactPath(artifactArgument);
try {
  if (command === "backup") await backup(artifact);
  else if (command === "verify") await verify(artifact);
  else await restore(artifact);
} catch (error) {
  fail(error instanceof Error ? error.message : "Database recovery command failed");
}
