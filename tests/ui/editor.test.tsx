import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom

import { QuotaError } from "../../src/domain/errors";
import { scanGaps } from "../../src/domain/gaps";
import { packetCodec } from "../../src/import-export/codec";
import { openRepository, type Repository } from "../../src/storage/indexeddb-repository";
import { suggest } from "../../src/suggestions/deterministic";
import { App } from "../../src/ui/App";

let databaseNumber = 0;
let repository: Repository;
let databaseName = "";
let databaseFactory: IDBFactory;

async function renderEditor() {
  databaseNumber += 1;
  databaseName = `editor-${databaseNumber}`;
  databaseFactory = new IDBFactory();
  repository = await openRepository(databaseName, databaseFactory);
  const user = userEvent.setup();
  render(
    <App
      services={{
        repository,
        suggestions: { suggest },
        gaps: { scan: scanGaps },
        codec: packetCodec,
      }}
    />,
  );
  return user;
}

async function createAndOpenWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Workspace title"), "October handover");
  await user.type(screen.getByLabelText("Organization"), "Kind Org");
  await user.click(screen.getByRole("button", { name: "Create workspace" }));
  const created = await screen.findByRole("heading", { name: "October handover" });
  expect(created).toBeVisible();
  return (await repository.listHandovers())[0];
}

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  repository?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KindRelay workspace editor", () => {
  it("creates and opens a labeled workspace, then saves header and source edits through the real repository", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);

    await user.clear(screen.getByLabelText("Workspace title"));
    await user.type(screen.getByLabelText("Workspace title"), "October transition");
    await user.click(screen.getByRole("button", { name: "Save workspace details" }));
    await user.type(screen.getByLabelText("Source title"), "Laptop notes");
    await user.type(screen.getByLabelText("Source text"), "ACTION: Return the shared laptop.");
    await user.click(screen.getByRole("button", { name: "Add source" }));

    await screen.findByRole("heading", { name: "Laptop notes" });
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({
      title: "October transition",
      sources: [expect.objectContaining({ title: "Laptop notes", text: "ACTION: Return the shared laptop." })],
    });

    await user.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await user.click(screen.getByRole("button", { name: "October transition" }));
    expect(await screen.findByRole("heading", { name: "October transition" })).toBeVisible();
  });

  it("adds a manual task with the user-selected exact citation, edits that citation, and deletes the task only after confirmation", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    const sourced = await repository.addSource(workspace.id, workspace.revision, {
      title: "Coordinator notes",
      text: "Return the shared laptop. Return the shared desktop.",
    });
    await user.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await user.click(screen.getByRole("button", { name: /October handover/i }));

    await user.type(screen.getByLabelText("Task title"), "Return laptop");
    await user.selectOptions(screen.getByLabelText("Citation source"), sourced.sources[0].id);
    await user.type(screen.getByLabelText("Citation quote"), "Return the shared laptop.");
    await user.click(screen.getByRole("button", { name: "Add citation" }));
    await user.click(screen.getByRole("button", { name: "Add task" }));

    await screen.findByText("Return laptop");
    await user.click(screen.getByRole("button", { name: "Edit task Return laptop" }));
    await user.clear(screen.getByLabelText("Citation quote"));
    await user.type(screen.getByLabelText("Citation quote"), "Return the shared desktop.");
    await user.click(screen.getByRole("button", { name: "Save task" }));
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({
      tasks: [expect.objectContaining({ citations: [{ sourceId: sourced.sources[0].id, sourceRevision: 1, quote: "Return the shared desktop." }] })],
    });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Delete task Return laptop" }));
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ tasks: [expect.anything()] });
    await user.click(screen.getByRole("button", { name: "Delete task Return laptop" }));
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ tasks: [] });
  });

  it("accepts each canonical suggestion once and filters it after acceptance", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    const sourced = await repository.addSource(workspace.id, workspace.revision, {
      title: "Action notes",
      text: "TODO: Call Morgan\nordinary context",
    });
    await user.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await user.click(screen.getByRole("button", { name: /October handover/i }));

    const suggestion = await screen.findByText("Call Morgan");
    await user.click(within(suggestion.parentElement!).getByRole("button", { name: "Accept suggestion" }));

    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({
      tasks: [expect.objectContaining({
        title: "Call Morgan",
        provenance: "deterministic-suggestion",
        citations: [{ sourceId: sourced.sources[0].id, sourceRevision: 1, quote: "Call Morgan" }],
      })],
    });
    expect(screen.queryByRole("button", { name: "Accept suggestion" })).not.toBeInTheDocument();
  });

  it("does not delete a source when confirmation is cancelled, then deletes it only after confirmation", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    const sourced = await repository.addSource(workspace.id, workspace.revision, { title: "Delete me", text: "notes" });
    await user.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await user.click(screen.getByRole("button", { name: /October handover/i }));
    vi.mocked(window.confirm).mockReturnValueOnce(false);

    await user.click(screen.getByRole("button", { name: "Delete source Delete me" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Delete source.*Delete me/));
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ sources: [expect.objectContaining({ id: sourced.sources[0].id })] });

    await user.click(screen.getByRole("button", { name: "Delete source Delete me" }));
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ sources: [] });
  });

  it("does not delete a workspace when confirmation is cancelled, then removes it after confirmation", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    vi.mocked(window.confirm).mockReturnValueOnce(false);

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ id: workspace.id });
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await expect(repository.getHandover(workspace.id)).resolves.toBeNull();
  });

  it("marks a previously approved cited task as Needs review when the source title changes", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    const withSource = await repository.addSource(workspace.id, workspace.revision, { title: "Original title", text: "Return laptop" });
    const withTask = await repository.addTask(withSource.id, withSource.revision, {
      title: "Return laptop",
      citations: [{ sourceId: withSource.sources[0].id, sourceRevision: 1, quote: "Return laptop" }],
    });
    const approved = await repository.reviewTask(withTask.id, withTask.tasks[0].id, withTask.revision, "approved");
    await user.click(screen.getByRole("button", { name: "Back to workspaces" }));
    await user.click(screen.getByRole("button", { name: /October handover/i }));

    await user.click(screen.getByRole("button", { name: "Edit source Original title" }));
    await user.clear(screen.getByLabelText("Source title"));
    await user.type(screen.getByLabelText("Source title"), "Renamed notes");
    await user.click(screen.getByRole("button", { name: "Save source" }));

    await screen.findByText("Needs review");
    await expect(repository.getHandover(approved.id)).resolves.toMatchObject({
      sources: [expect.objectContaining({ title: "Renamed notes", revision: 2 })],
      tasks: [expect.objectContaining({ state: "draft", reviewedAt: null })],
    });
  });

  it("prevents a duplicate pending save while the real repository write is gated", async () => {
    const user = await renderEditor();
    await createAndOpenWorkspace(user);
    const actualSave = repository.updateHandover.bind(repository);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(repository, "updateHandover").mockImplementationOnce(async (...args) => {
      await gate;
      return actualSave(...args);
    });
    await user.clear(screen.getByLabelText("Workspace title"));
    await user.type(screen.getByLabelText("Workspace title"), "Delayed title");

    const saveButton = screen.getByRole("button", { name: "Save workspace details" });
    await user.click(saveButton);
    expect(saveButton).toBeDisabled();
    await user.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
    release!();
    await screen.findByText("Workspace details saved");
  });

  it("announces a quota failure without discarding typed input", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    vi.spyOn(repository, "updateHandover").mockRejectedValueOnce(new QuotaError("Storage is full."));
    await user.clear(screen.getByLabelText("Workspace title"));
    await user.type(screen.getByLabelText("Workspace title"), "Unsaved quota title");
    await user.click(screen.getByRole("button", { name: "Save workspace details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Storage is full.");
    expect(screen.getByLabelText("Workspace title")).toHaveValue("Unsaved quota title");
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ title: "October handover" });
  });

  it("preserves a real stale-revision header edit and requires explicit reload confirmation rather than overwrite", async () => {
    const user = await renderEditor();
    const workspace = await createAndOpenWorkspace(user);
    const otherTab = await openRepository(databaseName, databaseFactory);
    await otherTab.updateHandover(workspace.id, workspace.revision, { title: "Changed in another tab" });
    await user.clear(screen.getByLabelText("Workspace title"));
    await user.type(screen.getByLabelText("Workspace title"), "Keep my wording");
    await user.click(screen.getByRole("button", { name: "Save workspace details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/i);
    expect(screen.getByLabelText("Workspace title")).toHaveValue("Keep my wording");
    expect(screen.getByRole("button", { name: "Reload saved workspace" })).toBeVisible();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Reload saved workspace" }));
    expect(screen.getByLabelText("Workspace title")).toHaveValue("Keep my wording");
    await user.click(screen.getByRole("button", { name: "Reload saved workspace" }));
    await screen.findByDisplayValue("Changed in another tab");
    await expect(repository.getHandover(workspace.id)).resolves.toMatchObject({ title: "Changed in another tab" });
    otherTab.close();
  });
});
