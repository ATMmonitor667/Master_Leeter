/**
 * Eval harness barrel (M4-4).
 *
 * Star exports rather than named lists, on purpose. A named re-export block is a
 * long run of lines with no syntactic anchor, so any tool that sorts lines turns
 * it into invalid TypeScript. Four star exports survive that; there are no name
 * collisions between these modules to disambiguate anyway.
 *
 * Two things deliberately absent:
 *   - `cli.ts` reads `process.argv` and calls `process.exit`. Neither belongs in
 *     anything a server imports.
 *   - `interruption.test.ts` is a test file. Exporting it would pull vitest into
 *     the production module graph.
 */

export * from "./metrics.js";
export * from "./expectations.js";
export * from "./harness.js";
export * from "./report.js";
