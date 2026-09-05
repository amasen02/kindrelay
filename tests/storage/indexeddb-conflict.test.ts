import { describe, expect, it, vi } from "vitest";
import type { ImportResult } from "../../src/domain/types";
import { sha256Utf8 } from "../../src/domain/hash";
import { openRepository } from "../../src/storage/indexeddb-repository";
import { createdHandover, freshDatabase, trackRepository } from "./helpers";

async function importedResult(id: string, at: string): Promise<ImportResult> {
  const text = "ACTION: Return the keys";
  const source = {
    id: `${id}-source`,
    title: "Imported notes",
    text,
    sha256: await sha256Utf8(text),
    revision: 1,
  };
  const task = {
    id: `${id}-task`,
    title: "Return the keys",
    owner: null,
    dueDate: null,
    citations: [{ sourceId: source.id, sourceRevision: 1, quote: "Return the keys" }],
    state: "draft" as const,
    reviewedAt: null,
    provenance: "imported" as const,
  };
  return {
    handover: {
      id,
      title: "Imported handover",
      organization: "Kind Org",
      createdAt: at,
      updatedAt: at,
      sources: [source],
      tasks: [task],
      events: [{ id: `${id}-event`, at, kind: "imported", detail: "{}" }],
      revision: 1,
    },
    foreignReview: [
      { taskId: task.id, importedState: "approved", importedReviewedAt: at },
    ],
    foreignSources: [
      {
        localSourceId: source.id,
        originalSourceId: "original-source",
        originalSourceRevision: 1,
        originalSourceSha256: source.sha256,
        excerptSha256: await sha256Utf8("Return the keys"),
      },
    ],
  };
}

describe("IndexedDB repository transactions", () => {
  it("enforces CAS across two connections for stale updates and deletes without implicit retry", async () => {
    const { name, factory } = freshDatabase();
    const left = trackRepository(await openRepository(name, factory));
    const right = trackRepository(await openRepository(name, factory));
    const created = await createdHandover(left);
    const updated = await left.updateHandover(created.id, 1, { title: "Current" });

    await expect(right.updateHandover(created.id, 1, { organization: "Stale" })).rejects.toMatchObject({
      code: "REVISION_CONFLICT", expectedRevision: 1, actualRevision: 2,
    });
    await expect(right.deleteHandover(created.id, 1)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(left.getHandover(created.id)).resolves.toEqual(updated);
  });

  it("waits for deferred source hashing before opening the readwrite transaction", async () => {
    const { name, factory } = freshDatabase();
    const repository = trackRepository(await openRepository(name, factory));
    const handover = await createdHandover(repository);
    const originalTransaction = IDBDatabase.prototype.transaction;
    const openings: string[] = [];
    let releaseDigest!: () => void;
    let signalDigestStarted!: () => void;
    const digestStarted = new Promise<void>((resolve) => {
      signalDigestStarted = resolve;
    });
    const deferredDigest = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      signalDigestStarted();
      await deferredDigest;
      return originalDigest(algorithm, data);
    });
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      openings.push(args[1] ?? "readonly");
      return originalTransaction.apply(this, args);
    });

    const input = { title: "Notes", text: "delayed hash" };
    const pending = repository.addSource(handover.id, 1, input);
    await digestStarted;
    input.text = "mutated after validation";
    expect(openings).not.toContain("readwrite");
    releaseDigest();
    await expect(pending).resolves.toMatchObject({ revision: 2 });
    expect(openings.indexOf("readwrite")).toBeGreaterThan(openings.indexOf("readonly"));
    await expect(repository.getHandover(handover.id)).resolves.toMatchObject({
      sources: [expect.objectContaining({ text: "delayed hash" })],
    });
    spy.mockRestore();
    digestSpy.mockRestore();
  });

  it("uses the second readwrite CAS check after deferred hashing across two connections", async () => {
    const { name, factory } = freshDatabase();
    const left = trackRepository(await openRepository(name, factory));
    const right = trackRepository(await openRepository(name, factory));
    const handover = await createdHandover(left);
    let releaseDigest!: () => void;
    let signalDigestStarted!: () => void;
    const digestStarted = new Promise<void>((resolve) => { signalDigestStarted = resolve; });
    const deferredDigest = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      signalDigestStarted();
      await deferredDigest;
      return originalDigest(algorithm, data);
    });

    const pending = left.addSource(handover.id, 1, { title: "Notes", text: "ACTION: race" });
    await digestStarted;
    const concurrent = await right.updateHandover(handover.id, 1, { title: "Changed elsewhere" });
    releaseDigest();

    await expect(pending).rejects.toMatchObject({
      code: "REVISION_CONFLICT", expectedRevision: 1, actualRevision: 2,
    });
    await expect(left.getHandover(handover.id)).resolves.toEqual(concurrent);
  });

  it("resolves only after a completed transaction and maps an injected quota failure without a partial mutation", async () => {
    const { name, factory } = freshDatabase();
    const repository = trackRepository(await openRepository(name, factory));
    const handover = await createdHandover(repository);
    const originalPut = IDBObjectStore.prototype.put;
    let completed = false;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "handovers") throw new DOMException("quota", "QuotaExceededError");
      return originalPut.apply(this, args);
    });

    await expect(repository.updateHandover(handover.id, 1, { title: "Never committed" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(repository.getHandover(handover.id)).resolves.toEqual(handover);
    failure.mockRestore();

    const completionProbe = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      this.transaction.addEventListener("complete", () => {
        completed = true;
      });
      return originalPut.apply(this, args);
    });
    await expect(repository.updateHandover(handover.id, 1, { title: "Committed" })).resolves.toMatchObject({ revision: 2 });
    expect(completed).toBe(true);
    completionProbe.mockRestore();
  });

  it("rejects an over-8MiB handover before storage and leaves the old snapshot intact", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const handover = await createdHandover(repository);
    const oversized = await importedResult("over-budget", handover.createdAt);
    oversized.handover.title = `Oversized header ${"x".repeat(8 * 1024 * 1024)}`;
    await expect(repository.commitImport(oversized)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.getHandover(handover.id)).resolves.toEqual(handover);
    await expect(repository.getHandover("over-budget")).resolves.toBeNull();
  });

  it("atomically creates import metadata, rejects duplicate IDs, filters metadata on deletion, and rolls back a forced second-store failure", async () => {
    const { name, factory } = freshDatabase();
    const repository = trackRepository(await openRepository(name, factory));
    const local = await createdHandover(repository);
    const imported = await importedResult("imported-1", local.createdAt);
    await expect(repository.commitImport(imported)).resolves.toMatchObject({ id: "imported-1", revision: 1 });
    await expect(repository.getImportRecord("imported-1")).resolves.toEqual({
      handoverId: "imported-1",
      foreignReview: imported.foreignReview,
      foreignSources: imported.foreignSources,
    });
    await expect(repository.commitImport(imported)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const importedTaskId = imported.handover.tasks[0].id;
    const afterTaskDelete = await repository.deleteTask("imported-1", importedTaskId, 1);
    expect(afterTaskDelete.tasks).toEqual([]);
    await expect(repository.getImportRecord("imported-1")).resolves.toMatchObject({ foreignReview: [] });
    const importedSourceId = imported.handover.sources[0].id;
    await expect(repository.deleteSource("imported-1", importedSourceId, 2)).resolves.toMatchObject({ sources: [] });
    await expect(repository.getImportRecord("imported-1")).resolves.toMatchObject({ foreignSources: [] });

    const originalAdd = IDBObjectStore.prototype.add;
    let handoverAdds = 0;
    let importRecordAdds = 0;
    const failure = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "handovers") handoverAdds += 1;
      if (this.name === "importRecords") {
        importRecordAdds += 1;
        throw new DOMException("abort", "AbortError");
      }
      return originalAdd.apply(this, args);
    });
    const rejected = await importedResult("imported-rollback", local.createdAt);
    await expect(repository.commitImport(rejected)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    failure.mockRestore();
    expect(handoverAdds).toBe(1);
    expect(importRecordAdds).toBe(1);
    await expect(repository.getHandover("imported-rollback")).resolves.toBeNull();
    await expect(repository.getImportRecord("imported-rollback")).resolves.toBeNull();
  });

  it("rejects foreign metadata that does not reference the imported workspace", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const local = await createdHandover(repository);
    const invalid = await importedResult("invalid-metadata", local.createdAt);
    invalid.foreignReview = [
      { taskId: "missing-local-task", importedState: "approved", importedReviewedAt: local.createdAt },
    ];

    await expect(repository.commitImport(invalid)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.getHandover("invalid-metadata")).resolves.toBeNull();
    await expect(repository.getImportRecord("invalid-metadata")).resolves.toBeNull();
  });
});
