import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const id = "11111111-1111-4111-8111-111111111111";
const report = {
  sessionId: id,
  scenarioRef: "fixture",
  rubricId: "fixture",
  rubricVersion: 1,
  generatedAt: "2026-01-01T10:45:00Z",
  overall: 2.5,
  dimensions: [
    {
      dimension: "communication",
      score: 2.5,
      confidence: 0.5,
      rationale: "Synthetic assessment for interface verification.",
      evidence: [
        {
          seq: 1,
          occurredAt: "2026-01-01T10:05:00Z",
          kind: "clarification",
          summary: "Synthetic evidence: candidate checked a constraint.",
          evidenceHash: "fixture",
        },
      ],
    },
  ],
  hintsUsed: [],
  probesAsked: [],
  missedOpportunities: [],
  drills: {
    communication: "Explain one trade-off.",
    algorithmic: "Compare two approaches.",
    testing: "Check an empty input.",
  },
};
async function fixtures(page: Page) {
  await page.route("http://localhost:4000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === "/v1/scenarios")
      body = {
        scenarios: [
          {
            ref: "fixture",
            level: "Intermediate",
            topics: ["Reasoning"],
            expectedMinutes: 45,
          },
        ],
      };
    else if (
      path === "/v1/interview-sessions" &&
      route.request().method() === "POST"
    )
      body = { sessionId: id };
    else if (path === "/v1/interview-sessions")
      body = {
        sessions: [
          {
            sessionId: id,
            mode: "MOCK",
            state: "EVALUATION",
            createdAt: "2026-01-01T10:00:00Z",
            startedAt: "2026-01-01T10:00:00Z",
            endedAt: "2026-01-01T10:45:00Z",
            expectedSeconds: 2700,
            remainingSeconds: 0,
          },
        ],
        nextCursor: null,
      };
    else if (path.endsWith("/report")) body = { report };
    else if (path.endsWith("/resume"))
      body = {
        code: "# Synthetic fixture\n",
        notes: "",
        ended: false,
        remainingSeconds: 2400,
        state: "IMPLEMENTATION",
        nextClientSeq: 0,
        codeRevision: 0,
      };
    else if (path.endsWith("/socket-ticket")) body = { ticket: "fixture" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    });
  });
  await page.routeWebSocket(/ws:\/\/localhost:4000\/.*/, (socket) => {
    socket.onMessage((message) => {
      const value = JSON.parse(String(message));
      if (typeof value.clientSeq === "number")
        socket.send(
          JSON.stringify({ kind: "ACK", clientSeq: value.clientSeq }),
        );
    });
  });
}
test.beforeEach(async ({ page }) => {
  await fixtures(page);
});
const routes = [
  "/",
  "/start",
  "/history",
  "/settings",
  "/faq",
  "/privacy",
  "/support",
  `/interview/${id}`,
  `/report/${id}`,
];
for (const theme of ["dark", "light"] as const)
  for (const motion of ["no-preference", "reduce"] as const)
    for (const route of routes) {
      test(`${route} ${theme} ${motion}`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
        await page.goto("/settings");
        await page.getByRole("radio", { name: theme, exact: false }).check();
        await page.goto(route);
        await expect(page.locator("main")).toBeVisible();
        if (route === "/history")
          await expect(
            page.getByRole("heading", { name: "Mock interview" }),
          ).toBeVisible();
        if (route === "/start")
          await expect(page.getByRole("radio")).toHaveCount(1);
        if (route.includes("/report/"))
          await expect(
            page.getByRole("heading", { name: "What happened" }),
          ).toBeVisible();
        if (route.includes("/interview/"))
          await expect(
            page.getByRole("textbox", {
              name: "python solution editor",
              exact: true,
            }),
          ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(result.violations).toEqual([]);
        if (motion === "reduce")
          await info.attach(`${theme}-screen`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
      });
    }
test("setup, editor, help and completion with keyboard", async ({ page }) => {
  await page.goto("/start");
  await page
    .getByRole("button", { name: "Continue", exact: false })
    .press("Enter");
  await page.getByRole("radio", { name: "Strict", exact: false }).check();
  await page
    .getByRole("button", { name: "Enter interview", exact: false })
    .press("Enter");
  await expect(page).toHaveURL(new RegExp(`/interview/${id}`));
  await page
    .getByRole("textbox", { name: "python solution editor", exact: true })
    .fill("# candidate fixture");
  await page
    .getByRole("textbox", { name: "python solution editor", exact: true })
    .press("Control+2");
  await expect(
    page.getByRole("textbox", { name: "Interview notes", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Interview notes", exact: true })
    .fill("Verify a boundary.");
  await page.locator('summary[aria-label="Interview actions"]').press("Enter");
  await page
    .getByRole("button", { name: "Complete interview", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("button", { name: "Keep interviewing" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Keep interviewing" }).press("Escape");
  await expect(
    page.getByRole("button", { name: "Complete interview", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Complete interview", exact: true })
    .press("?");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).press("Escape");
  await page
    .getByRole("button", { name: "Complete interview", exact: true })
    .press("Enter");
  await page
    .getByRole("button", { name: "Complete and view report" })
    .press("Enter");
  await expect(
    page.getByRole("heading", { name: "What happened" }),
  ).toBeVisible();
});
test("history undo sends no deletion request", async ({ page }) => {
  let deletes = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletes++;
  });
  await page.goto("/history");
  await page.getByRole("button", { name: /Delete interview/ }).click();
  await page.getByRole("button", { name: "Undo deletion" }).click();
  await page.waitForTimeout(5100);
  expect(deletes).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Mock interview" }),
  ).toBeVisible();
});

test("voice permission is explicit and late permission is released after cancel", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const fixture = { requests: 0, stopped: 0, resolve: () => {} };
    Object.assign(window, { microphoneFixture: fixture });
    navigator.mediaDevices.getUserMedia = () => {
      fixture.requests++;
      return new Promise((resolve) => {
        fixture.resolve = () =>
          resolve({
            getTracks: () => [{ stop: () => fixture.stopped++ }],
          } as unknown as MediaStream);
      });
    };
  });
  await page.goto(`/interview/${id}`);
  await page.getByRole("button", { name: "Start voice", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Check your microphone and speaker",
  });
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).microphoneFixture.requests),
  ).toBe(0);
  await dialog.getByRole("button", { name: "Allow microphone" }).click();
  expect(
    await page.evaluate(() => (window as any).microphoneFixture.requests),
  ).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => (window as any).microphoneFixture.resolve());
  await expect
    .poll(() => page.evaluate(() => (window as any).microphoneFixture.stopped))
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Start voice", exact: true }),
  ).toBeFocused();
});

test("blocked microphone permission leaves the check retryable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Synthetic blocked permission", "NotAllowedError");
    };
  });
  await page.goto(`/interview/${id}`);
  await page.getByRole("button", { name: "Start voice", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Check your microphone and speaker",
  });
  await dialog.getByRole("button", { name: "Allow microphone" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "permission was blocked",
  );
  await expect(
    dialog.getByRole("button", { name: "Allow microphone" }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Start interview voice" }),
  ).toBeDisabled();
});
for (const status of [202, 404, 503])
  test(`report recovery ${status}`, async ({ page }) => {
    await page.route(
      `http://localhost:4000/v1/interview-sessions/${id}/report`,
      (route) =>
        route.fulfill({
          status,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(
            status === 202
              ? { status: "QUEUED" }
              : { error: "Synthetic service failure" },
          ),
        }),
    );
    await page.goto(`/report/${id}`);
    await expect(
      page.getByRole("heading", {
        name:
          status === 202
            ? "Preparing your report…"
            : "Your report is unavailable.",
      }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
  });
test("partial report shows weak evidence and separate unavailable estimates", async ({
  page,
}) => {
  const partial = {
    ...report,
    dimensions: [{ ...report.dimensions[0], evidence: [] }],
    solutionGrade: {
      status: "INSUFFICIENT_EVIDENCE",
      score: null,
      confidence: 0,
      summary: "Synthetic fixture with too little evidence.",
      strengths: [],
      improvements: [],
      dimensions: [],
      evidence: [],
      model: "fixture",
      promptVersion: "fixture",
    },
  };
  await page.route(
    `http://localhost:4000/v1/interview-sessions/${id}/report`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ report: partial }),
      }),
  );
  await page.goto(`/report/${id}`);
  await expect(
    page.getByText(
      "No evidence moments are available. Treat estimates as weak signals.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Solution quality" }),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
});
