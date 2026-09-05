import { describe, expect, it, vi } from "vitest";
import { sha256Utf8 } from "../../src/domain/hash";
import type { ForeignReviewRecord, ImportResult } from "../../src/domain/types";
import { openRepository } from "../../src/storage/indexeddb-repository";
import { createdHandover, freshDatabase, trackRepository } from "./helpers";

function rawDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function upgradeDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawPut(
  database: IDBDatabase,
  store: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([store], "readwrite");
    transaction.objectStore(store).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function imported(id: string, at: string): Promise<ImportResult> {
  const text = "ACTION: Return keys";
  const source = {
    id: id + "-source",
    title: "Imported notes",
    text,
    sha256: await sha256Utf8(text),
    revision: 1,
  };
  const task = {
    id: id + "-task",
    title: "Return keys",
    owner: null,
    dueDate: null,
    citations: [{ sourceId: source.id, sourceRevision: 1, quote: "Return keys" }],
    state: "draft" as const,
    reviewedAt: null,
    provenance: "imported" as const,
  };
  return {
    handover: {
      id,
      title: "Imported",
      organization: "Kind Org",
      createdAt: at,
      updatedAt: at,
      sources: [source],
      tasks: [task],
      events: [{ id: id + "-event", at, kind: "imported", detail: "{}" }],
      revision: 1,
    },
    foreignReview: [{ taskId: task.id, importedState: "approved", importedReviewedAt: at }],
    foreignSources: [{
      localSourceId: source.id,
      originalSourceId: "foreign-source",
      originalSourceRevision: 1,
      originalSourceSha256: source.sha256,
      excerptSha256: await sha256Utf8("Return keys"),
    }],
  };
}

describe("IndexedDB integrity boundaries", () => {
  it("closes the old repository handle when a version change arrives", async () => {
    const { name, factory } = freshDatabase();
    const repository = trackRepository(await openRepository(name, factory));
    const handover = await createdHandover(repository);
    const upgraded = await upgradeDatabase(factory, name);
    upgraded.close();

    await expect(repository.getHandover(handover.id)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("rejects every malformed foreign metadata shape before persistence", async () => {
    const repository = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const seed = await createdHandover(repository);
    const corruptions: ReadonlyArray<(packet: ImportResult) => void> = [
      (packet) => { packet.foreignReview[0].importedReviewedAt = "2026-02-30T00:00:00.000Z"; },
      (packet) => { packet.foreignReview[0].importedState = "draft"; },
      (packet) => { packet.foreignSources[0].originalSourceSha256 = "not-a-digest"; },
      (packet) => { packet.foreignSources[0].originalSourceRevision = 0; },
      (packet) => { (packet.foreignReview as ForeignReviewRecord[]).push({ ...packet.foreignReview[0] }); },
      (packet) => { (packet.foreignSources[0] as unknown as Record<string, unknown>).extra = true; },
    ];

    for (const [index, corrupt] of corruptions.entries()) {
      const packet = await imported("invalid-" + index, seed.createdAt);
      corrupt(packet);
      await expect(repository.commitImport(packet)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(repository.getHandover(packet.handover.id)).resolves.toBeNull();
    }
  });

  it("rejects corrupt stored handovers and import metadata from a raw second connection", async () => {
    const { name, factory } = freshDatabase();
    const repository = trackRepository(await openRepository(name, factory));
    const handover = await createdHandover(repository);
    const raw = await rawDatabase(factory, name);
    await rawPut(raw, "handovers", { id: handover.id });
    raw.close();

    await expect(repository.getHandover(handover.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(repository.listHandovers()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const clean = trackRepository(await openRepository(...Object.values(freshDatabase()) as [string, IDBFactory]));
    const valid = await createdHandover(clean);
    const rawClean = await rawDatabase(factory, name);
    rawClean.close();
    const second = freshDatabase();
    const secondRepository = trackRepository(await openRepository(second.name, second.factory));
    const secondHandover = await createdHandover(secondRepository);
    const rawSecond = await rawDatabase(second.factory, second.name);
    await rawPut(rawSecond, "importRecords", { handoverId: secondHandover.id, foreignReview: "bad", foreignSources: [] });
    rawSecond.close();
    await expect(secondRepository.getImportRecord(secondHandover.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    void valid;
  });

  it("snapshots import input across deferred hashing and deletes both workspace stores", async () => {
    const { name, factory } = freshDatabase();
    const repository = trackRepository(await openRepository(name, factory));
    const seed = await createdHandover(repository);
    const packet = await imported("import-snapshot", seed.createdAt);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      started();
      await gate;
      return originalDigest(algorithm, data);
    });
    const pending = repository.commitImport(packet);
    await begun;
    packet.handover.tasks[0].state = "approved";
    packet.handover.tasks[0].reviewedAt = seed.createdAt;
    release();
    const stored = await pending;
    expect(stored.tasks[0]).toMatchObject({ state: "draft", reviewedAt: null });
    await repository.deleteHandover(stored.id, 1);
    await expect(repository.getHandover(stored.id)).resolves.toBeNull();
    await expect(repository.getImportRecord(stored.id)).resolves.toBeNull();
  });
});
