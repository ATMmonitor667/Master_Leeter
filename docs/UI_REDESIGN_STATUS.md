# UI redesign implementation and verification

The redesign is implemented on `codex-ui-redesign`, based on the `UI` branch and
`UI_REDESIGN_PLAN.txt`. Changes are local; the branch has not been merged or deployed.

## Implemented

- A semantic token system generates both CSS and Monaco themes. Dark, light and
  system preferences persist locally. Inter and JetBrains Mono are self-hosted.
- The marketing page is a server component, with a separate three-step `/start`
  flow. Scenario references stay opaque, and resume consent remains explicit.
- The interview workspace has a resizable desktop split, collapsible side panels,
  mobile tabs, keyboard shortcuts, native dialogs and clear save/recovery states.
  Monaco has assistance disabled and follows theme/font preferences.
- Voice preflight requires a user action to request microphone permission. Its
  meter reflects the actual input. Canceling releases tracks, including permission
  granted after cancellation; blocked permission remains retryable.
- Reports show captured evidence before estimates. History groups sessions and
  offers an undo window before issuing deletion. Settings expose appearance and
  honest deletion scope. Login, privacy, support, error and empty states use the
  shared visual system.
- The old global stylesheet and decorative canvas components are removed. CI
  checks token drift/contrast, literal colors, route bundle budgets, accessibility,
  responsive overflow, keyboard workflows and Lighthouse performance budgets.

## Automated checks

- The complete route matrix passed 126 browser checks across desktop (1440px),
  tablet (834px) and mobile (390px), including both themes and reduced motion.
  Checks cover nine routes, axe, keyboard completion, deletion undo and partial,
  pending and unavailable reports. Screenshots are attached to the HTML reporter.
- Two additional microphone regressions run on all three viewports. The final
  keyboard/microphone subset passed all nine checks against the final build.
- Web unit tests: 136 passed. The earlier repository suite passed 960 tests;
  16 database-dependent tests were skipped because PostgreSQL was unavailable.
- Production build, repository typecheck, semantic contrast, token drift,
  literal-color ownership and private-content bundle checks passed.
- Final gzip budgets: landing initial JS 108.6 KiB (110 KiB limit), interview
  initial JS 129.7 KiB (170 KiB limit), total CSS 8.6 KiB (45 KiB limit).
- Three final Lighthouse desktop simulated-throttling runs per page passed.
  Landing: performance 99–100, accessibility 100, LCP 517–831 ms, CLS 0.00029.
  FAQ: performance/accessibility 100, LCP 409–487 ms, CLS 0. These are local lab
  results, not production field measurements.

Browser fixtures use synthetic scenario/report data and a mocked session socket.
These checks do not verify the live voice provider or production authentication.

## Reproduce

From the repository root, install the lockfile dependencies, then run:

```sh
pnpm tokens:check
pnpm check:ui
pnpm typecheck
pnpm --filter @master-leeter/web build
pnpm check:ui-budget
pnpm check:bundle
pnpm test:ui
```

Install Chromium first with the Playwright CLI if it is unavailable. On Windows,
the CLI can be invoked from `apps/web` as
`node node_modules/@playwright/test/cli.js install chromium` (and `test`).

For local performance audits, start the production web server on port 3100 in
one terminal and run `pnpm check:performance` from the root in another. Set
`CHROME_PATH` to the installed Chromium executable if automatic discovery cannot
find it. The collector audits the landing page and FAQ three times using the
Lighthouse desktop simulated-throttling configuration. HTML and JSON reports are
written to the ignored `apps/web/lighthouse-report` directory. On Windows the
collector must have permission to terminate its own Chrome process.

## Remaining acceptance work

- Review screenshots and approve stable visual regression baselines. The current
  suite captures review screenshots; it does not assert approved pixel baselines.
- NVDA with Chrome and VoiceOver with Safari through the full cockpit workflow.
- Manual 400% zoom and Windows High Contrast verification.
- Full voice interviews on a 13-inch laptop at 100% and 125% OS scaling, with
  real microphone switching, network recovery and provider audio.
- Live interaction latency/INP measurement and real account/resume workflows.

The automated results do not replace these manual acceptance gates in the plan.
