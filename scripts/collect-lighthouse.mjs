/** In-process Lighthouse collection avoids Windows child-CLI shutdown stalls. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const webRequire = createRequire(resolve("apps/web/package.json"));
const lhRequire = createRequire(webRequire.resolve("@lhci/cli/package.json"));
const { default: lighthouse } = await import(
  pathToFileURL(lhRequire.resolve("lighthouse")).href
);
const lighthouseRequire = createRequire(lhRequire.resolve("lighthouse"));
const chromeLauncher = await import(
  pathToFileURL(lighthouseRequire.resolve("chrome-launcher")).href
);
const { default: desktop } = await import(
  pathToFileURL(
    lighthouseRequire.resolve("lighthouse/core/config/desktop-config.js"),
  ).href
);
const runs = Number(process.env.LIGHTHOUSE_RUNS ?? "3");
if (!Number.isInteger(runs) || runs < 1 || runs > 3)
  throw new Error("LIGHTHOUSE_RUNS must be 1–3");
const directory = resolve("apps/web/lighthouse-report");
await mkdir(directory, { recursive: true });
const chrome = await chromeLauncher.launch({
  chromePath: process.env.CHROME_PATH,
  chromeFlags: ["--headless=new", "--no-sandbox"],
});
let failed = false;
try {
  for (const [name, url] of [
    ["landing", "http://127.0.0.1:3100/"],
    ["faq", "http://127.0.0.1:3100/faq"],
  ]) {
    for (let run = 1; run <= runs; run++) {
      const result = await lighthouse(
        url,
        {
          port: chrome.port,
          logLevel: "error",
          output: ["json", "html"],
          maxWaitForLoad: 10000,
        },
        desktop,
      );
      if (!result || result.lhr.runtimeError)
        throw new Error(
          result?.lhr.runtimeError?.message ?? "Lighthouse returned no report",
        );
      await writeFile(
        resolve(directory, `${name}-${run}.json`),
        result.report[0],
      );
      await writeFile(
        resolve(directory, `${name}-${run}.html`),
        result.report[1],
      );
      const lhr = result.lhr;
      const performance = lhr.categories.performance.score;
      const accessibility = lhr.categories.accessibility.score;
      const lcp = lhr.audits["largest-contentful-paint"].numericValue;
      const cls = lhr.audits["cumulative-layout-shift"].numericValue;
      console.log(
        `${name} run ${run}: performance ${performance}, accessibility ${accessibility}, LCP ${Math.round(lcp)}ms, CLS ${cls}`,
      );
      if (
        performance < 0.95 ||
        accessibility < 0.95 ||
        lcp > 2000 ||
        cls > 0.05
      )
        failed = true;
    }
  }
} finally {
  await chrome.kill();
}
if (failed)
  throw new Error(
    "Lighthouse performance budget exceeded; see apps/web/lighthouse-report",
  );
