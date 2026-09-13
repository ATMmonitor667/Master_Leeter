import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_DATABASE_ADMIN_URL) {
  console.error("Set TEST_DATABASE_ADMIN_URL to a local disposable PostgreSQL maintenance database. See docs/DATABASE_TESTING.md.");
  process.exit(1);
}
const cwd = fileURLToPath(new URL("../", import.meta.url));
const runner = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [runner, "run", "src/modules/session/pg-integration.test.ts"], {
  cwd, stdio: "inherit", env: { ...process.env, REQUIRE_DATABASE_TESTS: "1" },
});
if (result.error) console.error("Database test runner failed to start.");
process.exit(result.status ?? 1);
