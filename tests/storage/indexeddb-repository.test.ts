import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "../../src/domain/hash";
import {
  openRepository,
  type Repository,
} from "../../src/storage/indexeddb-repository";
import { suggest } from "../../src/suggestions/deterministic";
import { createdHandover, freshDatabase } from "./helpers";

describe("sha256Utf8", () => {
  it("hashes ASCII and Unicode UTF-8 text to lowercase SHA-256 hex", async () => {
    await expect(sha256Utf8("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(sha256Utf8("Kind 💙")).resolves.toBe(
      "a200cb10ee651e0514c4816693cb5d25ddafb0f4537e3a48bc93626e003be311",
    );
  });
});

describe("IndexedDB repository CRUD", () => {
  it("creates, reads, lists, closes, and reopens a validated handover", async () => {
    const { name, factory } = freshDatabase();
    const first = await openRepository(name, factory);
    const created = await createdHandover(first);
    expect(created.revision).toBe(1);
    expect(created.events).toMatchObject([{ kind: "created" }]);
    expect(created.events[0].detail).not.toContain(created.title);
    await expect(first.listHandovers()).resolves.toEqual([
      expect.objectContaining({ id: created.id, revision: 1 }),
    ]);
    first.close();

    const reopened = await openRepository(name, factory);
    await expect(reopened.getHandover(created.id)).resolves.toEqual(created);
    reopened.close();
  });

  it("lists newest updated handovers first with an ID tie-break and no full contents", async () => {
    const repository = await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]);
    const older = await repository.createHandover({ title: "Older", organization: "Org" });
    const newer = await repository.createHandover({ title: "Newer", organization: "Org" });
    const summaries = await repository.listHandovers();

    expect(summaries.map(({ id }) => id)).toEqual([newer.id, older.id]);
    expect(summaries[0]).not.toHaveProperty("sources");
    expect(summaries[0]).not.toHaveProperty("tasks");
  });

  it("persists exactly one handover revision for an update and preserves it on no-op", async () => {
    const repository = await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]);
    const created = await createdHandover(repository);
    const updated = await repository.updateHandover(created.id, 1, { title: "Shift notes" });
    expect(updated.revision).toBe(2);
    await expect(repository.getHandover(created.id)).resolves.toMatchObject({ revision: 2, title: "Shift notes" });

    await expect(repository.updateHandover(created.id, 2, { title: "Shift notes" })).resolves.toEqual(updated);
  });

  it("computes full-text source hashes, invalidates only cited task review after a real edit, and preserves no-op source revision", async () => {
    const repository = await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]);
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, {
      title: "Notes", text: "ACTION: Return laptop",
    });
    const source = withSource.sources[0];
    const withTask = await repository.addTask(withSource.id, 2, {
      title: "Return laptop", citations: [{ sourceId: source.id, sourceRevision: 1, quote: "Return laptop" }],
    });
    const approved = await repository.reviewTask(withTask.id, "task-1", 3, "approved");
    const noOp = await repository.updateSource(approved.id, source.id, 4, { title: "Notes" });
    expect(noOp).toEqual(approved);

    const edited = await repository.updateSource(approved.id, source.id, 4, { text: "ACTION: Return desktop" });
    expect(edited.sources[0]).toMatchObject({ revision: 2, sha256: await sha256Utf8("ACTION: Return desktop") });
    expect(edited.tasks[0]).toMatchObject({ state: "draft", reviewedAt: null });
  });

  it("performs task CRUD and does not duplicate an accepted stable deterministic suggestion after manual editing", async () => {
    const repository = await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]);
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, { title: "Notes", text: "TODO: Call Morgan" });
    const proposal = suggest(withSource.sources[0])[0];
    const accepted = await repository.addTask(withSource.id, 2, proposal);
    const edited = await repository.updateTask(accepted.id, proposal.id, 3, { title: "Call Morgan today" });
    const reaccepted = await repository.addTask(edited.id, 4, proposal);

    expect(reaccepted).toEqual(edited);
    expect(reaccepted.tasks).toHaveLength(1);
    await expect(repository.deleteTask(edited.id, proposal.id, 4)).resolves.toMatchObject({ tasks: [] });
  });

  it("rejects unknown targets and malformed patches rather than accepting partial storage writes", async () => {
    const repository = await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]);
    const handover = await createdHandover(repository);

    await expect(repository.getHandover("missing")).resolves.toBeNull();
    await expect(repository.updateSource(handover.id, "missing", 1, { title: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.updateHandover(handover.id, 1, { title: "x", extra: true } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.addTask(handover.id, 1, { title: "Forged", citations: [], provenance: "manual", state: "approved" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
