import { IDBFactory, IDBDatabase, IDBObjectStore } from "fake-indexeddb";
import { afterEach, vi } from "vitest";
import type { Handover, HandoverRepository } from "../../src/domain/types";
import type { Repository } from "../../src/storage/indexeddb-repository";

(globalThis as unknown as { IDBDatabase: typeof IDBDatabase }).IDBDatabase = IDBDatabase;
(globalThis as unknown as { IDBObjectStore: typeof IDBObjectStore }).IDBObjectStore = IDBObjectStore;


let sequence = 0;
const repositories = new Set<Repository>();

export function freshDatabase(): { name: string; factory: IDBFactory } {
  sequence += 1;
  return { name: `kindrelay-storage-${sequence}`, factory: new IDBFactory() };
}

export function createRepository(
  openRepository: (name: string, factory: IDBFactory) => Promise<Repository>,
): Promise<Repository> {
  const { name, factory } = freshDatabase();
  return openRepository(name, factory).then(trackRepository);
}

export function trackRepository(repository: Repository): Repository {
  repositories.add(repository);
  return repository;
}

export async function createdHandover(
  repository: HandoverRepository,
): Promise<Handover> {
  return repository.createHandover({
    title: "Volunteer handover",
    organization: "Kind Org",
  });
}

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.clear();
  vi.restoreAllMocks();
});
