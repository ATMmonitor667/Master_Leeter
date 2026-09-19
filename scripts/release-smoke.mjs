// Bounded read-only probes: no sign-in, interviews, provider calls or writes.
const usage = "Usage: pnpm release:smoke -- --api <origin> --web-origin <origin> --release <id> --admission <paused|open>";
const args = process.argv.slice(2).filter((value) => value !== "--");

function origin(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("INVALID_ORIGIN");
  return url.origin;
}

async function main() {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--api", "--web-origin", "--release", "--admission"].includes(args[i]) ||
        !args[i + 1] || flags.has(args[i])) throw new Error(usage);
    flags.set(args[i], args[i + 1]);
  }
  if (flags.size !== 4) throw new Error(usage);
  const api = origin(flags.get("--api"));
  const web = origin(flags.get("--web-origin"));
  const release = flags.get("--release");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(release) || !["paused", "open"].includes(flags.get("--admission"))) throw new Error(usage);
  async function request(path, status) {
    const response = await fetch(`${api}${path}`, {
      headers: { origin: web }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== status) { await response.body?.cancel(); throw new Error(`SMOKE_HTTP_FAILED:${path}`); }
    if (response.headers.get("access-control-allow-origin") !== web ||
        response.headers.get("x-content-type-options") !== "nosniff") {
      await response.body?.cancel(); throw new Error(`SMOKE_HEADERS_FAILED:${path}`);
    }
    return response;
  }
  for (const [path, expected] of [["/health/live", "live"], ["/health/ready", "ready"], ["/health/status", "ok"]]) {
    const response = await request(path, 200);
    const body = await response.json();
    if (body.status !== expected || body.release !== release) throw new Error(`SMOKE_RELEASE_FAILED:${path}`);
    if (path === "/health/status") {
      const c = body.capabilities;
      if (c?.authentication !== "AVAILABLE" || c.storage !== "AVAILABLE" ||
          c.admission !== flags.get("--admission").toUpperCase() ||
          [c.voice, c.classifier, c.evaluator].some((state) => state !== "CLOSED")) {
        throw new Error("SMOKE_CAPABILITIES_FAILED");
      }
    }
  }
  for (const authorization of [undefined, "Bearer invalid-release-smoke-token"]) {
    const response = await fetch(`${api}/v1/interview-sessions`, {
      headers: authorization ? { authorization } : {},
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.status !== 401) throw new Error("SMOKE_AUTHENTICATION_FAILED");
  }
  console.log(JSON.stringify({ release, checkedAt: new Date().toISOString(), result: "passed",
    checks: ["liveness", "readiness", "release identity", "CORS", "security header", "capabilities", "anonymous and invalid-token rejection"],
    limitation: "Does not verify valid-user ownership, provider access, WebSocket recovery or microphone behavior." }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "";
  console.error(message === usage || /^(INVALID_ORIGIN|SMOKE_[A-Z_]+(?::\/health\/[a-z]+)?)$/.test(message) ? message : "RELEASE_SMOKE_FAILED");
  process.exitCode = 1;
});
