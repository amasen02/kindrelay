// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scanGaps } from "../../src/domain/gaps";
import { QuotaError } from "../../src/domain/errors";
import { sha256Utf8 } from "../../src/domain/hash";
import { packetCodec } from "../../src/import-export/codec";
import { openRepository, type Repository } from "../../src/storage/indexeddb-repository";
import { suggest } from "../../src/suggestions/deterministic";
import { App } from "../../src/ui/App";

let sequence = 0;
let repository: Repository | undefined;

const servicesFor = (repo: Repository) => ({
  repository: repo,
  suggestions: { suggest },
  gaps: { scan: scanGaps },
  codec: packetCodec,
});

async function renderApp<T>(seed: (repo: Repository) => Promise<T>) {
  sequence += 1;
  repository = await openRepository(`review-transfer-${sequence}`, new IDBFactory());
  const seeded = await seed(repository);
  const user = userEvent.setup();
  render(<App services={servicesFor(repository)} />);
  return { user, repository, seeded };
}

async function makeReviewableWorkspace(repo: Repository) {
  const created = await repo.createHandover({
    title: "October handover",
    organization: "Kind Org",
  });
  const sourced = await repo.addSource(created.id, created.revision, {
    title: "Coordinator notes",
    text: "Return the shared laptop before Friday.",
  });
  const withApproved = await repo.addTask(sourced.id, sourced.revision, {
    title: "Arrange the laptop return",
    citations: [{
      sourceId: sourced.sources[0].id,
      sourceRevision: sourced.sources[0].revision,
      quote: "Return the shared laptop",
    }],
  });
  const withDraft = await repo.addTask(withApproved.id, withApproved.revision, {
    title: "Draft must not leave the workspace",
    citations: [{
      sourceId: withApproved.sources[0].id,
      sourceRevision: withApproved.sources[0].revision,
      quote: "Return the shared laptop",
    }],
  });
  const withRejected = await repo.addTask(withDraft.id, withDraft.revision, {
    title: "Rejected private-only task",
    citations: [],
  });
  return repo.reviewTask(
    withRejected.id,
    withRejected.tasks[2].id,
    withRejected.revision,
    "rejected",
  );
}

async function openWorkspace(
  user: ReturnType<typeof userEvent.setup>,
  workspaceTitle: string,
) {
  await user.click(await screen.findByRole("button", { name: workspaceTitle }));
  await screen.findByRole("heading", { name: workspaceTitle });
}

async function upload(
  user: ReturnType<typeof userEvent.setup>,
  bytes: string,
  name = "handover.json",
) {
  const input = screen.getByLabelText("Import a local JSON file");
  await user.upload(input, new File([bytes], name, { type: "application/json" }));
}

async function shareBytesFromSeparateWorkspace() {
  sequence += 1;
  const source = await openRepository(`review-transfer-source-${sequence}`, new IDBFactory());
  const workspace = await makeReviewableWorkspace(source);
  const approved = await source.reviewTask(workspace.id, workspace.tasks[0].id, workspace.revision, "approved");
  const packet = await packetCodec.exportApproved(approved, "json", [approved.tasks[0].id]);
  source.close();
  return packetCodec.renderPacket(packet);
}

afterEach(() => {
  cleanup();
  repository?.close();
  repository = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("KindRelay review and transfer", () => {
  it("shares the editor pending lane while a real export is preparing", async () => {
    const { user, repository: repo, seeded: workspace } = await renderApp(makeReviewableWorkspace);
    const approved = await repo.reviewTask(workspace.id, workspace.tasks[0].id, workspace.revision, "approved");
    await openWorkspace(user, approved.title);
    const transfer = screen.getByRole("region", { name: "Transfer workspace" });
    await user.click(within(transfer).getByRole("checkbox", { name: /select.*arrange/i }));
    await user.click(within(transfer).getByRole("checkbox", { name: /acknowledge.*share/i }));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realExport = packetCodec.exportApproved;
    vi.spyOn(packetCodec, "exportApproved").mockImplementationOnce(async (...args) => {
      await gate;
      return realExport(...args);
    });
    await user.click(within(transfer).getByRole("button", { name: "Download selected JSON" }));
    expect(screen.getByRole("button", { name: "Back to workspaces" })).toBeDisabled();
    expect(within(transfer).getByRole("button", { name: "Download selected JSON" })).toBeDisabled();
    release!();
    await screen.findByText(/JSON download prepared/i);
  });

  it("records an explicit rejection and never lists the rejected task for share export", async () => {
    const { user, repository: repo, seeded: workspace } = await renderApp(makeReviewableWorkspace);
    await openWorkspace(user, workspace.title);
    const review = screen.getByRole("region", { name: "Review tasks" });
    await user.selectOptions(within(review).getByRole("combobox", { name: "Task to review" }), workspace.tasks[1].id);
    await user.click(within(review).getByRole("button", { name: "Reject Draft must not leave the workspace" }));
    await waitFor(async () => expect((await repo.getHandover(workspace.id))?.tasks.find((task) => task.id === workspace.tasks[1].id)?.state).toBe("rejected"));
    const transfer = screen.getByRole("region", { name: "Transfer workspace" });
    expect(within(transfer).queryByRole("checkbox", { name: /select.*draft must not leave/i })).not.toBeInTheDocument();
  });

  it("resets a share acknowledgement when selected approved tasks change", async () => {
    const { user, repository: repo, seeded: workspace } = await renderApp(makeReviewableWorkspace);
    const approved = await repo.reviewTask(workspace.id, workspace.tasks[0].id, workspace.revision, "approved");
    await openWorkspace(user, approved.title);
    const transfer = screen.getByRole("region", { name: "Transfer workspace" });
    await user.click(within(transfer).getByRole("checkbox", { name: /select.*arrange/i }));
    const acknowledgement = within(transfer).getByRole("checkbox", { name: /acknowledge.*share/i });
    await user.click(acknowledgement);
    await user.click(within(transfer).getByRole("checkbox", { name: /select.*arrange/i }));
    expect(acknowledgement).not.toBeChecked();
  });

  it("shows every share field and independent gaps, requires a fresh acknowledgement for approval, and permits missing owner/date", async () => {
    const { user, repository: repo, seeded: workspace } = await renderApp(makeReviewableWorkspace);
    await openWorkspace(user, workspace.title);

    const beforeApproval = workspace.tasks[0];
    const review = screen.getByRole("region", { name: "Review tasks" });
    expect(within(review).getByRole("heading", { name: "Arrange the laptop return" })).toBeVisible();
    expect(within(review).getByText(workspace.tasks[0].id)).toBeVisible();
    expect(within(review).getByText("Coordinator notes")).toBeVisible();
    expect(within(review).getByText(workspace.sources[0].sha256)).toBeVisible();
    expect(await within(review).findByText(await sha256Utf8("Return the shared laptop"))).toBeVisible();
    expect(within(review).getByText(/exact quote/i)).toBeVisible();
    expect(within(review).getByText(/source revision/i)).toBeVisible();
    expect(within(review).getByText(/provenance/i)).toBeVisible();
    expect(within(review).getByText(/review time/i)).toBeVisible();
    expect(within(review).getByText(/gap: missing owner/i)).toBeVisible();
    expect(within(review).getByText(/gap: missing date/i)).toBeVisible();
    expect(within(review).getByText(/gap: unreviewed/i)).toBeVisible();
    expect(within(review).getByText(/not encrypted/i)).toBeVisible();
    expect(within(review).getByText(/cannot guarantee.*secrets/i)).toBeVisible();
    expect(within(review).getByText(/inspect every shared field/i)).toBeVisible();

    const acknowledgement = within(review).getByRole("checkbox", {
      name: /acknowledge.*sensitive/i,
    });
    const approve = within(review).getByRole("button", {
      name: "Approve Arrange the laptop return",
    });
    expect(approve).toBeDisabled();
    await user.click(acknowledgement);
    await user.click(approve);
    await waitFor(async () =>
      expect((await repo.getHandover(workspace.id))?.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: beforeApproval.id, state: "approved" }),
        ]),
      ),
    );
    await expect(repo.getHandover(workspace.id)).resolves.toMatchObject({
      revision: workspace.revision + 1,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: beforeApproval.id,
          state: "approved",
          reviewedAt: expect.any(String),
        }),
        expect.objectContaining({
          id: workspace.tasks[1].id,
          state: "draft",
        }),
      ]),
    });
    expect(within(review).getByRole("checkbox", { name: /acknowledge.*sensitive/i })).not.toBeChecked();
  });

  it("blocks invalid citations with a return-to-editor repair path and resets approval acknowledgement after a task selection/revision change", async () => {
    const { user, repository: repo, seeded: workspace } = await renderApp(makeReviewableWorkspace);
    await openWorkspace(user, workspace.title);

    const review = screen.getByRole("region", { name: "Review tasks" });
    const acknowledgement = within(review).getByRole("checkbox", {
      name: /acknowledge.*sensitive/i,
    });
    await user.click(acknowledgement);
    expect(acknowledgement).toBeChecked();
    const taskChoice = within(review).getByRole("combobox", { name: "Task to review" });
    await user.selectOptions(taskChoice, workspace.tasks[1].id);
    expect(within(review).getByRole("checkbox", { name: /acknowledge.*sensitive/i })).not.toBeChecked();
    expect(within(review).getByRole("button", { name: "Approve Draft must not leave the workspace" })).toBeDisabled();
    await user.click(acknowledgement);
    await user.click(screen.getByRole("button", { name: "Edit source Coordinator notes" }));
    await user.clear(screen.getByLabelText("Source text"));
    await user.type(screen.getByLabelText("Source text"), "Return the shared laptop after revision.");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    expect(await within(review).findByText(/citation no longer matches/i)).toBeVisible();
    expect(within(review).getByRole("checkbox", { name: /acknowledge.*sensitive/i })).not.toBeChecked();
    expect(within(review).getByRole("button", { name: /return to editor/i })).toBeVisible();
    expect(within(review).getByRole("button", { name: "Approve Draft must not leave the workspace" })).toBeDisabled();
    expect(acknowledgement).not.toBeChecked();
  });

  it("exports only selected approved tasks using real JSON and Markdown artifacts, and keeps private backup visibly separate", async () => {
    const { user, repository: repo, seeded: workspace } = await renderApp(makeReviewableWorkspace);
    const firstApproved = await repo.reviewTask(workspace.id, workspace.tasks[0].id, workspace.revision, "approved");
    const second = await repo.addTask(firstApproved.id, firstApproved.revision, {
      title: "Approved second task",
      citations: [{
        sourceId: workspace.sources[0].id,
        sourceRevision: workspace.sources[0].revision,
        quote: "Return the shared laptop",
      }],
    });
    const approved = await repo.reviewTask(second.id, second.tasks[3].id, second.revision, "approved");
    await openWorkspace(user, approved.title);

    const transfer = screen.getByRole("region", { name: "Transfer workspace" });
    const selected = within(transfer).getByRole("checkbox", {
      name: /select.*arrange the laptop return/i,
    });
    const json = within(transfer).getByRole("button", { name: "Download selected JSON" });
    expect(json).toBeDisabled();
    await user.click(selected);
    expect(json).toBeDisabled();
    await user.click(within(transfer).getByRole("checkbox", { name: /acknowledge.*share/i }));

    const downloads: Array<{ name: string; type: string; text: string }> = [];
    const byUrl = new Map<string, { name: string; type: string; text: string }>();
    let urlSequence = 0;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:captured-${urlSequence++}`;
        const entry = { name: "", type: blob.type, text: "" };
        downloads.push(entry);
        byUrl.set(url, entry);
        const reader = new FileReader();
        reader.onload = () => { entry.text = String(reader.result); };
        reader.readAsText(blob);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    });
    const order: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      const entry = byUrl.get(this.href);
      if (entry) entry.name = this.download;
      order.push("click");
    });
    vi.mocked(URL.revokeObjectURL).mockImplementation(() => order.push("revoke"));
    await user.click(json);
    await screen.findByText(/download prepared/i);
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
      expect(downloads[0]?.text).toMatch(/\S/);
    });
    const jsonPacket = JSON.parse(downloads[0].text);
    expect(jsonPacket.tasks).toHaveLength(1);
    expect(jsonPacket.tasks[0]).toMatchObject({ id: approved.tasks[0].id, state: "approved" });
    expect(downloads[0]).toMatchObject({ name: expect.stringMatching(/\.json$/), type: expect.stringMatching(/application\/json/) });
    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:captured-0");
    expect(order).toEqual(["click", "revoke"]);

    await user.click(within(transfer).getByRole("checkbox", { name: /acknowledge.*share/i }));
    await user.click(within(transfer).getByRole("button", { name: "Download selected Markdown" }));
    await screen.findByText(/markdown download prepared/i);
    await waitFor(() => {
      expect(downloads).toHaveLength(2);
      expect(downloads[1]?.text).toMatch(/\S/);
    });
    expect(downloads[1].text).toContain("# KindRelay approved handover");
    expect(downloads[1].text).toContain("Arrange the laptop return");
    expect(downloads[1].text).not.toContain("Draft must not leave the workspace");

    expect(within(transfer).getByRole("heading", { name: "Private backup" })).toBeVisible();
    expect(within(transfer).getByText(/complete notes.*drafts.*rejected.*history/i)).toBeVisible();
    expect(within(transfer).getByText(/v1 cannot preserve.*provenance/i)).toBeVisible();
    expect(within(transfer).getByText(/secure storage/i)).toBeVisible();
    await user.click(within(transfer).getByRole("checkbox", { name: /acknowledge.*private/i }));
    await user.click(within(transfer).getByRole("button", { name: "Download private backup" }));
    await waitFor(() => {
      expect(downloads).toHaveLength(3);
      expect(downloads[2]?.text).toMatch(/\S/);
    });
    expect(JSON.parse(downloads[2].text)).toMatchObject({ format: "private-backup-json" });
    expect(downloads[2].text).toContain("Draft must not leave the workspace");
    expect(downloads[2].text).toContain("Rejected private-only task");
    expect(JSON.parse(downloads[2].text).handover.events.length).toBeGreaterThan(1);
  });

  it("previews actual exported file bytes without writing, resets restore acknowledgement on file change, and restores a new draft-only workspace", async () => {
    const bytes = await shareBytesFromSeparateWorkspace();
    const { user, repository: repo } = await renderApp(async () => undefined);

    await upload(user, bytes);
    expect(await screen.findByText(/Imported handover/i)).toBeVisible();
    expect(screen.getByText(/1 task.*1 source/i)).toBeVisible();
    expect(screen.getByText(/approvals reset to drafts/i)).toBeVisible();
    expect(screen.getByText(/foreign review.*historical/i)).toBeVisible();
    expect((await repo.listHandovers())).toHaveLength(0);
    const restore = screen.getByRole("button", { name: "Restore as new workspace" });
    expect(restore).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /acknowledge.*restore/i }));
    await upload(user, bytes, "replacement.json");
    await screen.findByText(/Imported handover/i);
    expect(screen.getByRole("checkbox", { name: /acknowledge.*restore/i })).not.toBeChecked();
    const replacementRestore = screen.getByRole("button", { name: "Restore as new workspace" });
    expect(replacementRestore).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /acknowledge.*restore/i }));
    await user.click(replacementRestore);
    await screen.findByRole("heading", { name: "Imported handover" });
    const workspaces = await repo.listHandovers();
    expect(workspaces).toHaveLength(1);
    const restored = await repo.getHandover(workspaces[0].id);
    expect(restored).toMatchObject({
      tasks: [expect.objectContaining({ state: "draft", reviewedAt: null, provenance: "imported" })],
    });
  });

  it("opens a restored workspace by its new ID so dirty fields from the previous editor do not leak", async () => {
    const bytes = await shareBytesFromSeparateWorkspace();
    const { user, seeded: existing } = await renderApp(makeReviewableWorkspace);
    await openWorkspace(user, existing.title);
    await user.clear(screen.getByLabelText("Workspace title"));
    await user.type(screen.getByLabelText("Workspace title"), "Unsaved old workspace title");

    await upload(user, bytes);
    await screen.findByText(/approvals reset to drafts/i);
    await user.click(screen.getByRole("checkbox", { name: /acknowledge.*restore/i }));
    await user.click(screen.getByRole("button", { name: "Restore as new workspace" }));

    await screen.findByRole("heading", { name: "Imported handover" });
    expect(screen.getByLabelText("Workspace title")).toHaveValue("Imported handover");
    expect(screen.getByLabelText("Workspace title")).not.toHaveValue("Unsaved old workspace title");
  });

  it("keeps the current workspace intact when invalid input, quota failure, or an over-16MiB file is rejected before reading", async () => {
    const { user, repository: repo, seeded: existing } = await renderApp(makeReviewableWorkspace);
    await openWorkspace(user, existing.title);
    await user.click(screen.getByRole("button", { name: "Back to workspaces" }));

    await upload(user, "{not JSON");
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid|packet/i);
    expect(await repo.getHandover(existing.id)).not.toBeNull();

    const valid = await shareBytesFromSeparateWorkspace();
    await upload(user, valid, "valid.json");
    await screen.findByText(/approvals reset to drafts/i);
    vi.spyOn(repo, "commitImport").mockRejectedValueOnce(new QuotaError("Local storage is full."));
    await user.click(screen.getByRole("checkbox", { name: /acknowledge.*restore/i }));
    await user.click(screen.getByRole("button", { name: "Restore as new workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/storage is full/i);
    expect(await repo.listHandovers()).toHaveLength(1);

    const padded = `${valid}${" ".repeat(16 * 1024 * 1024 + 1)}`;
    const large = new File([padded], "large.json", { type: "application/json" });
    const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    await user.upload(screen.getByLabelText("Import a local JSON file"), large);
    expect(await screen.findByText(/Import file exceeds 16 MiB/i, { selector: '[role="alert"]' })).toBeVisible();
    expect(read).not.toHaveBeenCalled();
    expect(await repo.getHandover(existing.id)).not.toBeNull();
  });
});
