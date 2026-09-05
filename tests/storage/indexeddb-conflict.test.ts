import { describe, expect, it, vi } from "vitest";
import type { ImportResult } from "../../src/domain/types";
import { openRepository } from "../../src/storage/indexeddb-repository";
import { createdHandover, freshDatabase } from "./helpers";

describe("IndexedDB repository transactions", () => {
  it("enforces CAS across two connections for stale updates and deletes without implicit retry", async () => {
    const { name, factory } = freshDatabase();
    const left = await openRepository(name, factory);
    const right = await openRepository(name, factory);
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
    const repository = await openRepository(name, factory);
    const handover = await createdHandover(repository);
    const originalTransaction = IDBDatabase.prototype.transaction;
    const openings: string[] = [];
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      openings.push(args[1] ?? "readonly");
      return originalTransaction.apply(this, args);
    });

    const pending = repository.addSource(handover.id, 1, { title: "Notes", text: "delayed hash" });
    await expect(pending).resolves.toMatchObject({ revision: 2 });
    expect(openings.indexOf("readwrite")).toBeGreaterThan(openings.indexOf("readonly"));
    spy.mockRestore();
  });

  it("resolves only after a completed transaction and maps an injected quota failure without a partial mutation", async () => {
    const { name, factory } = freshDatabase();
    const repository = await openRepository(name, factory);
    const handover = await createdHandover(repository);
    const database = (repository as unknown as { database: IDBDatabase }).database;
    const originalPut = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "handovers") throw new DOMException("quota", "QuotaExceededError");
      return originalPut.apply(this, args);
    });

    await expect(repository.updateHandover(handover.id, 1, { title: "Never committed" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(repository.getHandover(handover.id)).resolves.toEqual(handover);
    failure.mockRestore();
    expect(database).toBeDefined();
  });

  it("rejects an over-8MiB handover before storage and leaves the old snapshot intact", async () => {
    const repository = await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]);
    const handover = await createdHandover(repository);
    await expect(repository.addSource(handover.id, 1, { title: "large", text: "x".repeat(8 * 1024 * 1024) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.getHandover(handover.id)).resolves.toEqual(handover);
  });

  it("atomically creates import metadata, rejects duplicate IDs, filters metadata on deletion, and rolls back a forced second-store failure", async () => {
    const { name, factory } = freshDatabase();
    const repository = await openRepository(name, factory);
    const local = await createdHandover(repository);
    const imported: ImportResult = {
      handover: { ...local, id: "imported-1", tasks: [], sources: [], events: [{ id: "imported-event", at: local.createdAt, kind: "imported", detail: "{}" }] },
      foreignReview: [], foreignSources: [],
    };
    await expect(repository.commitImport(imported)).resolves.toMatchObject({ id: "imported-1", revision: 1 });
    await expect(repository.getImportRecord("imported-1")).resolves.toEqual({ handoverId: "imported-1", foreignReview: [], foreignSources: [] });
    await expect(repository.commitImport(imported)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const failure = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "importRecords") throw new DOMException("abort", "AbortError");
      return Reflect.apply(Object.getPrototypeOf(this).add, this, args);
    });
    const rejected: ImportResult = { ...imported, handover: { ...imported.handover, id: "imported-rollback", events: [{ ...imported.handover.events[0], id: "rollback-event" }] } };
    await expect(repository.commitImport(rejected)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    failure.mockRestore();
    await expect(repository.getHandover("imported-rollback")).resolves.toBeNull();
    await expect(repository.getImportRecord("imported-rollback")).resolves.toBeNull();
  });
});
