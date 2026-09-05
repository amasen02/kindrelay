import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const privateMarker = "PRIVATE-E2E-MARKER-DO-NOT-SHARE";
const actionOne = "Return the shared laptop.";
const actionTwo = "Confirm the pantry inventory.";

function guardExternalRequests(page: Page) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    expect(url.origin, `unexpected runtime request: ${request.url()}`).toBe(
      "http://127.0.0.1:4173",
    );
  });
}

async function tabUntil(page: Page, target: Locator) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await page.keyboard.press("Tab");
    try {
      await expect(target).toBeFocused({ timeout: 100 });
      return;
    } catch {
      // Continue traversing the real tab order.
    }
  }
  throw new Error("Target was not reached by keyboard tab traversal.");
}

async function createReviewableWorkspace(page: Page) {
  await page.getByLabel("Workspace title").fill("E2E volunteer handover");
  await page.getByLabel("Organization").fill("KindRelay evidence org");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "E2E volunteer handover" }),
  ).toBeVisible();
  await page.getByLabel("Source title").fill("E2E notes");
  await page
    .getByLabel("Source text")
    .fill(`ACTION: ${actionOne}\nACTION: ${actionTwo}\n${privateMarker}`);
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByText(actionOne, { exact: true })).toBeVisible();
  await page
    .locator("article", { hasText: actionOne })
    .getByRole("button", { name: "Accept suggestion" })
    .click();
  await expect(
    page
      .locator("article", { hasText: actionOne })
      .getByRole("button", { name: "Accept suggestion" }),
  ).toHaveCount(0);
  await page
    .locator("article", { hasText: actionTwo })
    .getByRole("button", { name: "Accept suggestion" })
    .click();
  await expect(
    page.getByRole("button", { name: `Edit task ${actionOne}` }),
  ).toBeVisible();

  await page.getByRole("button", { name: `Edit task ${actionOne}` }).click();
  await page
    .getByLabel("Task title")
    .fill("Return the shared laptop to the office");
  await page.getByRole("button", { name: "Save task" }).click();
  await page
    .getByRole("region", { name: "Review tasks" })
    .getByRole("checkbox", { name: /acknowledge.*sensitive/i })
    .check();
  await page
    .getByRole("button", {
      name: "Approve Return the shared laptop to the office",
    })
    .click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  const review = page.getByRole("region", { name: "Review tasks" });
  await review
    .getByRole("combobox", { name: "Task to review" })
    .selectOption({ label: actionTwo });
  await review.getByRole("button", { name: `Reject ${actionTwo}` }).click();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
}

async function exportApproved(page: Page, format: "JSON" | "Markdown") {
  const transfer = page.getByRole("region", { name: "Transfer workspace" });
  await transfer
    .getByRole("checkbox", { name: /select.*return the shared laptop/i })
    .check();
  await transfer.getByRole("checkbox", { name: /acknowledge.*share/i }).check();
  const download = page.waitForEvent("download");
  await transfer
    .getByRole("button", { name: `Download selected ${format}` })
    .click();
  return download;
}

test("fresh contexts create, review, reload, download, restore, re-review, and export real approved artifacts", async ({
  browser,
}, testInfo) => {
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  try {
    contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    guardExternalRequests(pageA);
    await pageA.goto("/");
    await createReviewableWorkspace(pageA);
    await pageA.reload();
    await pageA.getByRole("button", { name: "E2E volunteer handover" }).click();
    await expect(
      pageA.getByRole("button", {
        name: "Edit task Return the shared laptop to the office",
      }),
    ).toBeVisible();
    await expect(pageA.getByText("Rejected", { exact: true })).toBeVisible();

    const jsonDownload = await exportApproved(pageA, "JSON");
    const jsonPath = testInfo.outputPath("context-a-approved.json");
    await jsonDownload.saveAs(jsonPath);
    const jsonText = await readFile(jsonPath, "utf8");
    const packet = JSON.parse(jsonText) as {
      handoverId: string;
      tasks: Array<{
        id: string;
        title: string;
        state: string;
        citations: Array<{ quote: string }>;
      }>;
    };
    expect(packet.tasks).toEqual([
      expect.objectContaining({
        title: "Return the shared laptop to the office",
        state: "approved",
        citations: [expect.objectContaining({ quote: actionOne })],
      }),
    ]);
    expect(jsonText).not.toContain(privateMarker);
    expect(jsonText).not.toContain(actionTwo);

    const markdownDownload = await exportApproved(pageA, "Markdown");
    const markdownPath = testInfo.outputPath("context-a-approved.md");
    await markdownDownload.saveAs(markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toContain("# KindRelay approved handover");
    expect(markdown).toContain("Return the shared laptop to the office");
    expect(markdown).toContain("Quote: Return the shared laptop\\.");
    expect(markdown).not.toContain(privateMarker);
    expect(markdown).not.toContain(actionTwo);

    contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    guardExternalRequests(pageB);
    await pageB.goto("/");
    await expect(pageB.getByText("No workspaces yet.")).toBeVisible();
    await pageB.getByLabel("Import a local JSON file").setInputFiles(jsonPath);
    await expect(pageB.getByText(/approvals reset to drafts/i)).toBeVisible();
    await pageB
      .getByRole("checkbox", { name: /acknowledge.*restore/i })
      .check();
    await pageB
      .getByRole("button", { name: "Restore as new workspace" })
      .click();
    await expect(
      pageB.getByRole("heading", { name: "Imported handover" }),
    ).toBeVisible();
    await pageB.reload();
    await pageB.getByRole("button", { name: "Imported handover" }).click();
    await expect(
      pageB.getByText("Needs review", { exact: true }),
    ).toBeVisible();
    await expect(
      pageB.getByRole("button", {
        name: "Edit task Return the shared laptop to the office",
      }),
    ).toBeVisible();
    const importedReview = pageB.getByRole("region", { name: "Review tasks" });
    await importedReview
      .getByRole("checkbox", { name: /acknowledge.*sensitive/i })
      .check();
    await importedReview
      .getByRole("button", {
        name: "Approve Return the shared laptop to the office",
      })
      .click();
    const reexport = await exportApproved(pageB, "JSON");
    const reexportPath = testInfo.outputPath("context-b-approved.json");
    await reexport.saveAs(reexportPath);
    const reexported = JSON.parse(
      await readFile(reexportPath, "utf8"),
    ) as typeof packet;
    expect(reexported.handoverId).not.toBe(packet.handoverId);
    expect(reexported.tasks[0]?.id).not.toBe(packet.tasks[0]?.id);
    expect(reexported.tasks[0]?.citations[0]?.quote).toBe(actionOne);
    await pageB.screenshot({
      path: testInfo.outputPath("context-b-reviewed.png"),
      fullPage: true,
    });
  } finally {
    await contextB?.close();
    await contextA?.close();
  }
});

test("source invalidation exposes independent gaps without reviewed-task 375px overflow", async ({
  page,
}, testInfo) => {
  guardExternalRequests(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await createReviewableWorkspace(page);
  const source = page.getByRole("button", { name: "Edit source E2E notes" });
  await source.click();
  await page.getByLabel("Source title").fill("E2E notes revised");
  await page
    .getByLabel("Source text")
    .fill(
      `ACTION: ${actionOne}\nACTION: ${actionTwo}\nrevised ${privateMarker}`,
    );
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.getByText(/gap: missing citation/i).first()).toBeVisible();
  await expect(page.getByText(/gap: missing owner/i).first()).toBeVisible();
  await expect(page.getByText(/gap: missing date/i).first()).toBeVisible();
  await expect(page.getByText(/gap: unreviewed/i).first()).toBeVisible();
  await expect(page.getByText(/citation no longer matches/i)).toBeVisible();
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  await page.screenshot({
    path: testInfo.outputPath("reviewed-375px.png"),
    fullPage: true,
  });

  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Delete source E2E notes revised" })
    .click();
  await expect(
    page.getByRole("heading", { name: "E2E notes revised" }),
  ).toBeVisible();
});

test("private backup warning, actual artifact, and cancelled source deletion preserve private notes", async ({
  page,
}, testInfo) => {
  guardExternalRequests(page);
  await page.goto("/");
  await createReviewableWorkspace(page);
  const transfer = page.getByRole("region", { name: "Transfer workspace" });
  await expect(
    transfer.getByText(/complete notes, drafts, rejected tasks and history/i),
  ).toBeVisible();
  await transfer
    .getByRole("checkbox", { name: /acknowledge.*private/i })
    .check();
  const backupDownload = page.waitForEvent("download");
  await transfer
    .getByRole("button", { name: "Download private backup" })
    .click();
  const backupPath = testInfo.outputPath("actual-private-backup.json");
  await (await backupDownload).saveAs(backupPath);
  expect(await readFile(backupPath, "utf8")).toContain(privateMarker);

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete source E2E notes" }).click();
  await expect(page.getByRole("heading", { name: "E2E notes" })).toBeVisible();
});

test("keyboard-only workspace creation reaches the editor", async ({
  page,
}) => {
  guardExternalRequests(page);
  await page.goto("/");
  const title = page.getByLabel("Workspace title");
  await tabUntil(page, title);
  await page.keyboard.type("Keyboard workspace");
  const organization = page.getByLabel("Organization");
  await tabUntil(page, organization);
  await page.keyboard.type("Keyboard organization");
  const create = page.getByRole("button", { name: "Create workspace" });
  await tabUntil(page, create);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Keyboard workspace" }),
  ).toBeVisible();
});

test("keyboard flow adds a source, accepts, reviews, exports, and focuses restore preview", async ({
  page,
}) => {
  guardExternalRequests(page);
  await page.goto("/");
  const title = page.getByLabel("Workspace title");
  await tabUntil(page, title);
  await page.keyboard.type("Keyboard full flow");
  const organization = page.getByLabel("Organization");
  await tabUntil(page, organization);
  await page.keyboard.type("Keyboard org");
  const create = page.getByRole("button", { name: "Create workspace" });
  await tabUntil(page, create);
  await page.keyboard.press("Enter");
  const sourceTitle = page.getByLabel("Source title");
  await tabUntil(page, sourceTitle);
  await page.keyboard.type("Keyboard notes");
  const sourceText = page.getByLabel("Source text");
  await tabUntil(page, sourceText);
  await page.keyboard.type("ACTION: Keyboard reviewed task");
  const addSource = page.getByRole("button", { name: "Add source" });
  await tabUntil(page, addSource);
  await page.keyboard.press("Enter");
  const suggestion = page
    .locator("article", { hasText: "Keyboard reviewed task" })
    .getByRole("button", { name: "Accept suggestion" });
  await tabUntil(page, suggestion);
  await page.keyboard.press("Enter");
  const review = page.getByRole("region", { name: "Review tasks" });
  const reviewAck = review.getByRole("checkbox", {
    name: /acknowledge.*sensitive/i,
  });
  await tabUntil(page, reviewAck);
  await page.keyboard.press("Space");
  const approve = review.getByRole("button", {
    name: "Approve Keyboard reviewed task",
  });
  await tabUntil(page, approve);
  await page.keyboard.press("Enter");
  const transfer = page.getByRole("region", { name: "Transfer workspace" });
  const selected = transfer.getByRole("checkbox", {
    name: /select.*keyboard reviewed/i,
  });
  await tabUntil(page, selected);
  await page.keyboard.press("Space");
  const shareAck = transfer.getByRole("checkbox", {
    name: /acknowledge.*share/i,
  });
  await tabUntil(page, shareAck);
  await page.keyboard.press("Space");
  const download = page.waitForEvent("download");
  const downloadButton = transfer.getByRole("button", {
    name: "Download selected JSON",
  });
  await tabUntil(page, downloadButton);
  await page.keyboard.press("Enter");
  const path = test.info().outputPath("keyboard-share.json");
  await (await download).saveAs(path);
  const back = page.getByRole("button", { name: "Back to workspaces" });
  await tabUntil(page, back);
  await page.keyboard.press("Enter");
  const fileInput = page.getByLabel("Import a local JSON file");
  await tabUntil(page, fileInput);
  await fileInput.setInputFiles(path);
  await expect(page.getByText(/approvals reset to drafts/i)).toBeFocused();
  const restoreAck = page.getByRole("checkbox", {
    name: /acknowledge.*restore/i,
  });
  await tabUntil(page, restoreAck);
  await page.keyboard.press("Space");
  const restore = page.getByRole("button", {
    name: "Restore as new workspace",
  });
  await tabUntil(page, restore);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Imported handover" }),
  ).toBeFocused();
});

test("unknown structural capability on an actual exported packet is rejected", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    guardExternalRequests(page);
    await page.goto("/");
    await createReviewableWorkspace(page);
    const download = await exportApproved(page, "JSON");
    const exported = testInfo.outputPath("valid-export.json");
    await download.saveAs(exported);
    const packet = JSON.parse(await readFile(exported, "utf8")) as Record<
      string,
      unknown
    >;
    packet.scriptUrl = "https://example.invalid";
    await page.getByRole("button", { name: "Back to workspaces" }).click();
    const workspaces = page.getByRole("region", { name: "Workspaces" });
    await expect(workspaces.getByRole("button")).toHaveCount(1);
    await page
      .getByLabel("Import a local JSON file")
      .setInputFiles({
        name: "unknown-capability.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(packet)),
      });
    await expect(page.getByRole("alert")).toContainText(
      /unexpected|invalid|packet/i,
    );
    await expect(workspaces.getByRole("button")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Restore as new workspace" }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("two tabs surface a CAS conflict, preserve unsaved input, and explicitly reload saved state", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    guardExternalRequests(first);
    guardExternalRequests(second);
    await first.goto("/");
    await first.getByLabel("Workspace title").fill("CAS workspace");
    await first.getByLabel("Organization").fill("Initial organization");
    await first.getByRole("button", { name: "Create workspace" }).click();
    await second.goto("/");
    await second.getByRole("button", { name: "CAS workspace" }).click();
    await first.getByLabel("Organization").fill("First tab saved organization");
    await first.getByRole("button", { name: "Save workspace details" }).click();
    await second
      .getByLabel("Organization")
      .fill("Second tab unsaved organization");
    await second
      .getByRole("button", { name: "Save workspace details" })
      .click();
    await expect(second.getByRole("alert")).toContainText(
      /changed elsewhere|reload before saving/i,
    );
    await expect(second.getByLabel("Organization")).toHaveValue(
      "Second tab unsaved organization",
    );
    second.once("dialog", (dialog) => dialog.accept());
    await second
      .getByRole("button", { name: "Reload saved workspace" })
      .click();
    await expect(second.getByLabel("Organization")).toHaveValue(
      "First tab saved organization",
    );
  } finally {
    await context.close();
  }
});

test("simulated targeted IndexedDB quota reports failure and leaves persisted source data unchanged", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (
        (args[0] as { sources?: Array<{ title?: string }> }).sources?.some(
          (source) => source.title === "Rejected quota source",
        )
      ) {
        throw new DOMException("simulated quota", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
  guardExternalRequests(page);
  await page.goto("/");
  await page.getByLabel("Workspace title").fill("Quota workspace");
  await page.getByLabel("Organization").fill("Quota organization");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByLabel("Source title").fill("Durable source");
  await page.getByLabel("Source text").fill("ACTION: Durable evidence.");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(
    page.getByRole("heading", { name: "Durable source" }),
  ).toBeVisible();
  await expect(page.getByLabel("Source title")).toHaveValue("");
  await page.getByLabel("Source title").fill("Rejected quota source");
  await page.getByLabel("Source text").fill("ACTION: Must not persist.");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("alert")).toContainText(
    /simulated quota|quota|storage/i,
  );
  await page.reload();
  await page.getByRole("button", { name: "Quota workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Durable source" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Rejected quota source" }),
  ).toHaveCount(0);
});

async function actualExportForImportMutation(
  browser: import("@playwright/test").Browser,
  testInfo: import("@playwright/test").TestInfo,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  guardExternalRequests(page);
  await page.goto("/");
  await createReviewableWorkspace(page);
  const download = await exportApproved(page, "JSON");
  const path = testInfo.outputPath("source-packet.json");
  await download.saveAs(path);
  return {
    context,
    path,
    packet: JSON.parse(await readFile(path, "utf8")) as {
      tasks: Array<{ id: string; citations: Array<{ excerptSha256: string }> }>;
      sources: Array<{ id: string; title: string }>;
    },
  };
}

test("single-field tampered excerpt hash from an actual export is rejected without a new workspace", async ({
  browser,
}, testInfo) => {
  const { context, path, packet } = await actualExportForImportMutation(
    browser,
    testInfo,
  );
  try {
    packet.tasks[0]!.citations[0]!.excerptSha256 = "0".repeat(64);
    const page = await context.newPage();
    guardExternalRequests(page);
    await page.goto("/");
    const workspaces = page.getByRole("region", { name: "Workspaces" });
    await expect(workspaces.getByRole("button")).toHaveCount(1);
    await page
      .getByLabel("Import a local JSON file")
      .setInputFiles({
        name: "tampered.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(packet)),
      });
    await expect(page.getByRole("alert")).toContainText(
      /hash|excerpt|invalid/i,
    );
    await expect(workspaces.getByRole("button")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Restore as new workspace" }),
    ).toHaveCount(0);
    void path;
  } finally {
    await context.close();
  }
});

test("single duplicate task ID in an actual export is rejected without a new workspace", async ({
  browser,
}, testInfo) => {
  const { context, packet } = await actualExportForImportMutation(
    browser,
    testInfo,
  );
  try {
    packet.tasks.push({
      ...packet.tasks[0]!,
      citations: [...packet.tasks[0]!.citations],
    });
    const page = await context.newPage();
    guardExternalRequests(page);
    await page.goto("/");
    const workspaces = page.getByRole("region", { name: "Workspaces" });
    await expect(workspaces.getByRole("button")).toHaveCount(1);
    await page
      .getByLabel("Import a local JSON file")
      .setInputFiles({
        name: "duplicate.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(packet)),
      });
    await expect(page.getByRole("alert")).toContainText(/duplicate|invalid/i);
    await expect(workspaces.getByRole("button")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Restore as new workspace" }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("hostile-looking human text from an actual packet remains inert after restore", async ({
  browser,
}, testInfo) => {
  const { context, packet } = await actualExportForImportMutation(
    browser,
    testInfo,
  );
  try {
    const hostile = "<img src=x onerror=window.__kindrelayExecuted=true>";
    packet.sources[0]!.title = hostile;
    const page = await context.newPage();
    guardExternalRequests(page);
    await page.goto("/");
    await page
      .getByLabel("Import a local JSON file")
      .setInputFiles({
        name: "inert.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(packet)),
      });
    await page.getByRole("checkbox", { name: /acknowledge.*restore/i }).check();
    await page
      .getByRole("button", { name: "Restore as new workspace" })
      .click();
    await expect(page.getByRole("heading", { name: hostile })).toBeVisible();
    await expect(page.locator("img")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Boolean(
          (window as Window & { __kindrelayExecuted?: boolean })
            .__kindrelayExecuted,
        ),
      ),
    ).toBe(false);
    void testInfo;
  } finally {
    await context.close();
  }
});

for (const quote of ["__proto__", "constructor", "toString"])
  test(`prototype-like suggestion quote ${quote} renders with its actual digest`, async ({
    page,
  }) => {
    guardExternalRequests(page);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto("/");
    await page.getByLabel("Workspace title").fill("Prototype quote workspace");
    await page.getByLabel("Organization").fill("Evidence organization");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByLabel("Source title").fill("Prototype note");
    await page.getByLabel("Source text").fill(`ACTION: ${quote}`);
    await page.getByRole("button", { name: "Add source" }).click();
    await page
      .locator("article", { hasText: quote })
      .getByRole("button", { name: "Accept suggestion" })
      .click();
    await expect(
      page.getByRole("button", { name: `Edit task ${quote}` }),
    ).toBeVisible();
    const review = page.getByRole("region", { name: "Review tasks" });
    await expect(
      review
        .locator("dd")
        .filter({ hasText: createHash("sha256").update(quote).digest("hex") }),
    ).toHaveText(createHash("sha256").update(quote).digest("hex"));
    expect(pageErrors).toEqual([]);
  });
