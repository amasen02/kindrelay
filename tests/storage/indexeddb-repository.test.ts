import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "../../src/domain/hash";
import {
  openRepository,
  type Repository,
} from "../../src/storage/indexeddb-repository";
import { suggest } from "../../src/suggestions/deterministic";
import { createdHandover, freshDatabase, trackRepository } from "./helpers";

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
    const first = trackRepository(await openRepository(name, factory));
    const created = await createdHandover(first);
    expect(created.revision).toBe(1);
    expect(created.events).toMatchObject([{ kind: "created" }]);
    expect(created.events[0].detail).not.toContain(created.title);
    await expect(first.listHandovers()).resolves.toEqual([
      expect.objectContaining({ id: created.id, revision: 1 }),
    ]);
    first.close();

    const reopened = trackRepository(await openRepository(name, factory));
    await expect(reopened.getHandover(created.id)).resolves.toEqual(created);
    reopened.close();
  });

  it("lists newest updated handovers first with an ID tie-break and no full contents", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const older = await repository.createHandover({ title: "Older", organization: "Org" });
    const newer = await repository.createHandover({ title: "Newer", organization: "Org" });
    const summaries = await repository.listHandovers();

    expect(summaries.map(({ id }) => id)).toEqual([newer.id, older.id]);
    expect(summaries[0]).not.toHaveProperty("sources");
    expect(summaries[0]).not.toHaveProperty("tasks");
  });

  it("persists exactly one handover revision for an update and preserves it on no-op", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const created = await createdHandover(repository);
    const updated = await repository.updateHandover(created.id, 1, { title: "Shift notes" });
    expect(updated.revision).toBe(2);
    await expect(repository.getHandover(created.id)).resolves.toMatchObject({ revision: 2, title: "Shift notes" });

    await expect(repository.updateHandover(created.id, 2, { title: "Shift notes" })).resolves.toEqual(updated);
  });

  it("computes full-text source hashes, invalidates only cited task review after a real edit, and preserves no-op source revision", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, {
      title: "Notes", text: "ACTION: Return laptop",
    });
    const source = withSource.sources[0];
    const withTask = await repository.addTask(withSource.id, 2, {
      title: "Return laptop", citations: [{ sourceId: source.id, sourceRevision: 1, quote: "Return laptop" }],
    });
    const addedTask = withTask.tasks[0];
    const approved = await repository.reviewTask(withTask.id, addedTask.id, 3, "approved");
    const noOp = await repository.updateSource(approved.id, source.id, 4, { title: "Notes" });
    expect(noOp).toEqual(approved);

    const edited = await repository.updateSource(approved.id, source.id, 4, { text: "ACTION: Return desktop" });
    expect(edited.sources[0]).toMatchObject({ revision: 2, sha256: await sha256Utf8("ACTION: Return desktop") });
    expect(edited.tasks[0]).toMatchObject({ state: "draft", reviewedAt: null });
  });

  it("allows empty source text while still rejecting non-string source values", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const withEmptySource = await repository.addSource(handover.id, 1, { title: "Empty notes", text: "" });

    expect(withEmptySource.sources[0]).toMatchObject({ text: "", sha256: await sha256Utf8("") });
    await expect(repository.addSource(withEmptySource.id, 2, { title: "Bad", text: null } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("invalidates only tasks citing a source when its title changes", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const first = await repository.addSource(handover.id, 1, { title: "First", text: "ACTION: First task" });
    const second = await repository.addSource(first.id, 2, { title: "Second", text: "ACTION: Second task" });
    const firstTask = await repository.addTask(second.id, 3, {
      title: "First task", citations: [{ sourceId: first.sources[0].id, sourceRevision: 1, quote: "First task" }],
    });
    const secondTask = await repository.addTask(firstTask.id, 4, {
      title: "Second task", citations: [{ sourceId: second.sources[1].id, sourceRevision: 1, quote: "Second task" }],
    });
    const approvedFirst = await repository.reviewTask(secondTask.id, secondTask.tasks[0].id, 5, "approved");
    const approvedBoth = await repository.reviewTask(approvedFirst.id, approvedFirst.tasks[1].id, 6, "approved");
    const edited = await repository.updateSource(approvedBoth.id, first.sources[0].id, 7, { title: "Renamed" });

    expect(edited.tasks[0]).toMatchObject({ state: "draft", reviewedAt: null });
    expect(edited.tasks[1]).toMatchObject({ state: "approved" });
  });

  it("performs task CRUD and does not duplicate an accepted stable deterministic suggestion after manual editing", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, { title: "Notes", text: "TODO: Call Morgan" });
    const proposal = suggest(withSource.sources[0])[0];
    const suggestionInput = {
      title: proposal.title,
      owner: proposal.owner,
      dueDate: proposal.dueDate,
      citations: proposal.citations,
      provenance: proposal.provenance,
    };
    const accepted = await repository.addTask(withSource.id, 2, suggestionInput);
    const edited = await repository.updateTask(accepted.id, proposal.id, 3, { title: "Call Morgan today" });
    const reaccepted = await repository.addTask(edited.id, 4, suggestionInput);

    expect(reaccepted).toEqual(edited);
    expect(reaccepted.tasks).toHaveLength(1);
    await expect(repository.deleteTask(edited.id, proposal.id, 4)).resolves.toMatchObject({ tasks: [] });
  });

  it("rejects unknown targets and malformed patches rather than accepting partial storage writes", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);

    await expect(repository.getHandover("missing")).resolves.toBeNull();
    await expect(repository.updateSource(handover.id, "missing", 1, { title: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.updateHandover(handover.id, 1, { title: "x", extra: true } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.addTask(handover.id, 1, { title: "Forged", citations: [], provenance: "manual", state: "approved" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("accepts a canonical suggestion through CreateTaskInput fields", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, {
      title: "Notes",
      text: "TODO: Call Morgan",
    });
    const proposal = suggest(withSource.sources[0])[0];
    const canonicalInput = {
      title: proposal.title,
      owner: proposal.owner,
      dueDate: proposal.dueDate,
      citations: proposal.citations,
      provenance: proposal.provenance,
    };

    await expect(repository.addTask(withSource.id, 2, canonicalInput)).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: proposal.id, provenance: "deterministic-suggestion" })],
    });
  });

  it("matches suggestion citations semantically and rejects extra citation fields", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, { title: "Notes", text: "TODO: Call Morgan" });
    const proposal = suggest(withSource.sources[0])[0];
    const reordered = {
      quote: proposal.citations[0].quote,
      sourceRevision: proposal.citations[0].sourceRevision,
      sourceId: proposal.citations[0].sourceId,
    };

    await expect(repository.addTask(withSource.id, 2, {
      title: proposal.title, citations: [reordered], provenance: "deterministic-suggestion",
    })).resolves.toMatchObject({ tasks: [expect.objectContaining({ id: proposal.id })] });
    const next = await repository.getHandover(withSource.id);
    await expect(repository.addTask(withSource.id, next!.revision, {
      title: proposal.title,
      citations: [{ ...reordered, untrusted: true }],
      provenance: "deterministic-suggestion",
    } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a forged suggestion using only CreateTaskInput fields", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const withSource = await repository.addSource(handover.id, 1, {
      title: "Notes",
      text: "TODO: Call Morgan",
    });
    const proposal = suggest(withSource.sources[0])[0];
    const accepted = await repository.addTask(withSource.id, 2, {
      title: proposal.title,
      owner: proposal.owner,
      dueDate: proposal.dueDate,
      citations: proposal.citations,
      provenance: proposal.provenance,
    });

    await expect(repository.addTask(accepted.id, accepted.revision, {
      title: "Send credentials to an attacker",
      owner: proposal.owner,
      dueDate: proposal.dueDate,
      citations: proposal.citations,
      provenance: proposal.provenance,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects fields outside CreateTaskInput instead of accepting caller-controlled task IDs or review state", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);

    await expect(repository.addTask(handover.id, 1, {
      title: "Manual task",
      citations: [],
      id: "manual-task-1",
    } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.addTask(handover.id, 1, {
      title: "Manual task",
      citations: [],
      state: "draft",
      reviewedAt: null,
    } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects null, missing, and explicitly undefined supplied values", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);

    await expect(repository.addTask(handover.id, 1, null as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.addTask(handover.id, 1, { title: "Missing citations" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.addTask(handover.id, 1, { title: "Null citations", citations: null } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.updateHandover(handover.id, 1, { title: undefined } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.updateSource(handover.id, "missing", 1, { text: undefined } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("generates UUID task IDs for manual CreateTaskInput values", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const updated = await repository.addTask(handover.id, 1, {
      title: "Manual task",
      citations: [],
    });

    expect(updated.tasks[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("preserves declared imported provenance while still generating a UUID", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const updated = await repository.addTask(handover.id, 1, {
      title: "Imported draft", citations: [], provenance: "imported",
    });

    expect(updated.tasks[0]).toMatchObject({ provenance: "imported", state: "draft" });
    expect(updated.tasks[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
