import { createRequire } from "node:module";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const require = createRequire(import.meta.url);
// pnpm places the peer beside @monaco-editor/react even when it has no direct
// web-workspace symlink. Resolve through that package in both layouts.
const reactPackage = require.resolve("@monaco-editor/react/package.json");
const monacoEntry = require.resolve("monaco-editor", { paths: [dirname(reactPackage)] });
const monacoRoot = resolve(monacoEntry, "../../..");
const source = join(monacoRoot, "min", "vs");
const destination = join(webRoot, "public", "monaco", "vs");
const marker = join(webRoot, "public", "monaco", ".version");
const { version } = JSON.parse(await readFile(join(monacoRoot, "package.json"), "utf8"));

try {
  if ((await readFile(marker, "utf8")) === version) {
    await stat(join(destination, "loader.js"));
    await stat(join(destination, "editor", "editor.main.js"));
    process.exit(0);
  }
} catch {
  // First build or an incomplete copy: restore the local assets.
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
await writeFile(marker, version);
console.log(`Prepared local Monaco assets (${version}).`);
