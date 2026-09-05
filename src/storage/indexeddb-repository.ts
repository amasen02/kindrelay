import { sha256Utf8 } from "../domain/hash";
import {
  NotFoundError,
  QuotaError,
  RevisionConflictError,
  StorageError,
  ValidationError,
} from "../domain/errors";
import { applyMutation, type PreparedMutation } from "../domain/mutations";
import { suggest } from "../suggestions/deterministic";
import type {
  CreateHandoverInput,
  CreateSourceInput,
  CreateTaskInput,
  ForeignReviewRecord,
  ForeignSourceRecord,
  Handover,
  HandoverId,
  HandoverPatch,
  HandoverRepository,
  HandoverSummary,
  ImportResult,
  Revision,
  Source,
  SourceId,
  SourcePatch,
  Task,
  TaskId,
  TaskPatch,
} from "../domain/types";
import { validateHandover, validateSourceText } from "../domain/validation";
import { DB_VERSION, STORE_HANDOVERS, STORE_IMPORT_RECORDS } from "./schema";

export interface ImportRecord {
  handoverId: string;
  foreignReview: ReadonlyArray<ForeignReviewRecord>;
  foreignSources: ReadonlyArray<ForeignSourceRecord>;
}

export interface ImportPersistence {
  commitImport(result: ImportResult): Promise<Handover>;
  getImportRecord(id: string): Promise<ImportRecord | null>;
}

export type Repository = HandoverRepository &
  ImportPersistence & {
    close(): void;
    database: IDBDatabase;
  };

function assertKnownKeys(obj: object, allowed: string[], name: string): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new ValidationError(`${name} must be a plain object.`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${name} contains unknown field ${key}.`);
    }
  }
}

function mapError(err: unknown): Error {
  if (
    err instanceof ValidationError ||
    err instanceof RevisionConflictError ||
    err instanceof NotFoundError ||
    err instanceof QuotaError ||
    err instanceof StorageError
  ) {
    return err;
  }
  if (err instanceof DOMException && err.name === "QuotaExceededError") {
    return new QuotaError();
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StorageError(message);
}

function runTransaction<T>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let opError: unknown = null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      return reject(mapError(err));
    }

    tx.oncomplete = () => {
      if (opError !== null) {
        reject(mapError(opError));
      } else {
        resolve(result);
      }
    };

    tx.onerror = () => {
      const errorToReject = opError ?? tx.error;
      reject(mapError(errorToReject));
    };

    tx.onabort = () => {
      const errorToReject = opError ?? tx.error ?? new StorageError("Transaction aborted");
      reject(mapError(errorToReject));
    };

    try {
      const maybePromise = operation(tx);
      if (maybePromise && typeof (maybePromise as Promise<T>).then === "function") {
        (maybePromise as Promise<T>).then(
          (val) => {
            result = val;
          },
          (err) => {
            opError = err;
            try {
              tx.abort();
            } catch {
              // Ignore if already aborted
            }
          },
        );
      } else {
        result = maybePromise as T;
      }
    } catch (err) {
      opError = err;
      try {
        tx.abort();
      } catch {
        // Ignore if already aborted
      }
    }
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openRepository(
  name: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<Repository> {
  return new Promise((resolve, reject) => {
    const openReq = factory.open(name, DB_VERSION);

    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(STORE_HANDOVERS)) {
        db.createObjectStore(STORE_HANDOVERS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_IMPORT_RECORDS)) {
        db.createObjectStore(STORE_IMPORT_RECORDS, { keyPath: "handoverId" });
      }
    };

    openReq.onerror = () => reject(mapError(openReq.error));
    openReq.onblocked = () => reject(new StorageError("Database open blocked"));

    openReq.onsuccess = () => {
      const db = openReq.result;

      db.onversionchange = () => {
        db.close();
      };

      async function readSnapshot(id: HandoverId): Promise<Handover | null> {
        return runTransaction(db, [STORE_HANDOVERS], "readonly", (tx) => {
          const store = tx.objectStore(STORE_HANDOVERS);
          const req = store.get(id);
          return new Promise<Handover | null>((res, rej) => {
            req.onsuccess = () => {
              if (!req.result) {
                res(null);
              } else {
                try {
                  const val = validateHandover(req.result);
                  res(val);
                } catch (e) {
                  rej(e);
                }
              }
            };
            req.onerror = () => rej(req.error);
          });
        });
      }

let lastTimestamp = 0;
function nextIsoTimestamp(): string {
  let now = Date.now();
  if (now <= lastTimestamp) {
    now = lastTimestamp + 1;
  }
  lastTimestamp = now;
  return new Date(now).toISOString();
}

      async function executeMutation(
        id: HandoverId,
        expectedRevision: Revision,
        command: PreparedMutation,
        extraStoreNames: string[] = [],
      ): Promise<Handover> {
        const at = nextIsoTimestamp();
        const eventId = crypto.randomUUID();
        const context = { at, eventId };
        const stores = Array.from(new Set([STORE_HANDOVERS, ...extraStoreNames]));

        return runTransaction(db, stores, "readwrite", (tx) => {
          const store = tx.objectStore(STORE_HANDOVERS);
          const req = store.get(id);

          return new Promise<Handover>((res, rej) => {
            req.onsuccess = () => {
              const current = req.result as Handover | undefined;
              if (!current) {
                return rej(new NotFoundError(`Handover ${id} was not found.`));
              }
              if (current.revision !== expectedRevision) {
                return rej(
                  new RevisionConflictError(
                    undefined,
                    expectedRevision,
                    current.revision,
                  ),
                );
              }

              let next: Handover;
              try {
                next = applyMutation(current, command, context);
              } catch (err) {
                return rej(err);
              }

              if (next === current) {
                return res(current);
              }

              try {
                validateHandover(next);
                store.put(next);
              } catch (err) {
                return rej(err);
              }

              if (command.kind === "delete-source" && tx.objectStoreNames.contains(STORE_IMPORT_RECORDS)) {
                const impStore = tx.objectStore(STORE_IMPORT_RECORDS);
                const impReq = impStore.get(id);
                impReq.onsuccess = () => {
                  const impRec = impReq.result as ImportRecord | undefined;
                  if (impRec) {
                    const filtered = {
                      ...impRec,
                      foreignSources: impRec.foreignSources.filter(
                        (fs) => fs.localSourceId !== command.sourceId,
                      ),
                    };
                    impStore.put(filtered);
                  }
                };
              } else if (command.kind === "delete-task" && tx.objectStoreNames.contains(STORE_IMPORT_RECORDS)) {
                const impStore = tx.objectStore(STORE_IMPORT_RECORDS);
                const impReq = impStore.get(id);
                impReq.onsuccess = () => {
                  const impRec = impReq.result as ImportRecord | undefined;
                  if (impRec) {
                    const filtered = {
                      ...impRec,
                      foreignReview: impRec.foreignReview.filter(
                        (fr) => fr.taskId !== command.taskId,
                      ),
                    };
                    impStore.put(filtered);
                  }
                };
              }

              res(next);
            };
            req.onerror = () => rej(req.error);
          });
        });
      }

      const repository: Repository = {
        database: db,

        close() {
          db.close();
        },

        async createHandover(input: CreateHandoverInput): Promise<Handover> {
          assertKnownKeys(input, ["title", "organization"], "CreateHandoverInput");
          if (!input.title || !input.organization) {
            throw new ValidationError("Title and organization are required.");
          }
          const id = crypto.randomUUID();
          const createdAt = nextIsoTimestamp();
          const initial: Handover = {
            id,
            title: input.title,
            organization: input.organization,
            createdAt,
            updatedAt: createdAt,
            sources: [],
            tasks: [],
            events: [
              {
                id: crypto.randomUUID(),
                at: createdAt,
                kind: "created",
                detail: JSON.stringify({ action: "created", handoverId: id }),
              },
            ],
            revision: 1,
          };
          validateHandover(initial);

          await runTransaction(db, [STORE_HANDOVERS], "readwrite", (tx) => {
            const store = tx.objectStore(STORE_HANDOVERS);
            store.add(initial);
          });

          return initial;
        },

        async getHandover(id: HandoverId): Promise<Handover | null> {
          return readSnapshot(id);
        },

        async listHandovers(): Promise<ReadonlyArray<HandoverSummary>> {
          const list = await runTransaction(
            db,
            [STORE_HANDOVERS],
            "readonly",
            (tx) => {
              const store = tx.objectStore(STORE_HANDOVERS);
              return reqToPromise(store.getAll());
            },
          );

          const summaries: HandoverSummary[] = list.map((h: Handover) => ({
            id: h.id,
            title: h.title,
            organization: h.organization,
            updatedAt: h.updatedAt,
            revision: h.revision,
          }));

          summaries.sort((a, b) => {
            const timeDiff =
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
            if (timeDiff !== 0) return timeDiff;
            return b.id.localeCompare(a.id);
          });

          return summaries;
        },

        async updateHandover(
          id: HandoverId,
          expectedRevision: Revision,
          patch: HandoverPatch,
        ): Promise<Handover> {
          assertKnownKeys(patch, ["title", "organization"], "HandoverPatch");
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          return executeMutation(id, expectedRevision, {
            kind: "update-handover",
            patch,
          });
        },

        async addSource(
          id: HandoverId,
          expectedRevision: Revision,
          input: CreateSourceInput,
        ): Promise<Handover> {
          assertKnownKeys(input, ["title", "text"], "CreateSourceInput");
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          validateSourceText(input.text);
          const sha = await sha256Utf8(input.text);

          const source: Source = {
            id: crypto.randomUUID(),
            title: input.title,
            text: input.text,
            sha256: sha,
            revision: 1,
          };

          return executeMutation(id, expectedRevision, {
            kind: "add-source",
            source,
          });
        },

        async updateSource(
          id: HandoverId,
          sourceId: SourceId,
          expectedRevision: Revision,
          patch: SourcePatch,
        ): Promise<Handover> {
          assertKnownKeys(patch, ["title", "text"], "SourcePatch");
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          const existingSource = snapshot.sources.find((s) => s.id === sourceId);
          if (!existingSource) {
            throw new NotFoundError(`Source ${sourceId} was not found.`);
          }

          const nextTitle = patch.title !== undefined ? patch.title : existingSource.title;
          const nextText = patch.text !== undefined ? patch.text : existingSource.text;
          if (patch.text !== undefined) {
            validateSourceText(nextText);
          }

          const nextSha =
            patch.text !== undefined && patch.text !== existingSource.text
              ? await sha256Utf8(nextText)
              : existingSource.sha256;

          const source: Source = {
            id: sourceId,
            title: nextTitle,
            text: nextText,
            sha256: nextSha,
            revision: existingSource.revision,
          };

          return executeMutation(id, expectedRevision, {
            kind: "update-source",
            sourceId,
            source,
          });
        },

        async addTask(
          id: HandoverId,
          expectedRevision: Revision,
          input: CreateTaskInput,
        ): Promise<Handover> {
          if (input.provenance === "deterministic-suggestion") {
            assertKnownKeys(
              input,
              ["id", "title", "owner", "dueDate", "citations", "state", "reviewedAt", "provenance"],
              "CreateTaskInput",
            );
            if ((input as { state?: string }).state !== "draft") {
              throw new ValidationError("Deterministic suggestion state must be draft.");
            }
            if ((input as { reviewedAt?: string | null }).reviewedAt !== null) {
              throw new ValidationError("Deterministic suggestion reviewedAt must be null.");
            }
          } else {
            assertKnownKeys(
              input,
              ["id", "title", "owner", "dueDate", "citations", "provenance"],
              "CreateTaskInput",
            );
          }

          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          let taskId: string;
          let provenance: Task["provenance"];

          if (input.provenance === "deterministic-suggestion") {
            const rawId = (input as { id?: string }).id;
            if (!rawId) {
              throw new ValidationError("Deterministic suggestion missing ID.");
            }
            taskId = rawId;
            provenance = "deterministic-suggestion";
          } else {
            const rawId = (input as { id?: string }).id;
            if (rawId) {
              taskId = rawId;
            } else {
              let count = 1;
              while (snapshot.tasks.some((t) => t.id === `task-${count}`)) {
                count++;
              }
              taskId = `task-${count}`;
            }
            provenance = input.provenance ?? "manual";
          }

          const task: Task = {
            id: taskId,
            title: input.title,
            owner: input.owner ?? null,
            dueDate: input.dueDate ?? null,
            state: "draft",
            citations: input.citations ?? [],
            reviewedAt: null,
            provenance,
          };

          return executeMutation(id, expectedRevision, {
            kind: "add-task",
            task,
          });
        },

        async updateTask(
          id: HandoverId,
          taskId: TaskId,
          expectedRevision: Revision,
          patch: TaskPatch,
        ): Promise<Handover> {
          assertKnownKeys(
            patch,
            ["title", "owner", "dueDate", "citations"],
            "TaskPatch",
          );
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          return executeMutation(id, expectedRevision, {
            kind: "update-task",
            taskId,
            patch,
          });
        },

        async reviewTask(
          id: HandoverId,
          taskId: TaskId,
          expectedRevision: Revision,
          decision: "approved" | "rejected",
        ): Promise<Handover> {
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          return executeMutation(id, expectedRevision, {
            kind: "review-task",
            taskId,
            decision,
          });
        },

        async deleteHandover(
          id: HandoverId,
          expectedRevision: Revision,
        ): Promise<void> {
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          await runTransaction(
            db,
            [STORE_HANDOVERS, STORE_IMPORT_RECORDS],
            "readwrite",
            (tx) => {
              const hStore = tx.objectStore(STORE_HANDOVERS);
              const impStore = tx.objectStore(STORE_IMPORT_RECORDS);

              const req = hStore.get(id);
              req.onsuccess = () => {
                const curr = req.result as Handover | undefined;
                if (!curr) throw new NotFoundError(`Handover ${id} not found.`);
                if (curr.revision !== expectedRevision) {
                  throw new RevisionConflictError(
                    undefined,
                    expectedRevision,
                    curr.revision,
                  );
                }
                hStore.delete(id);
                impStore.delete(id);
              };
            },
          );
        },

        async deleteSource(
          id: HandoverId,
          sourceId: SourceId,
          expectedRevision: Revision,
        ): Promise<Handover> {
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          return executeMutation(
            id,
            expectedRevision,
            { kind: "delete-source", sourceId },
            [STORE_IMPORT_RECORDS],
          );
        },

        async deleteTask(
          id: HandoverId,
          taskId: TaskId,
          expectedRevision: Revision,
        ): Promise<Handover> {
          const snapshot = await readSnapshot(id);
          if (!snapshot) throw new NotFoundError(`Handover ${id} was not found.`);
          if (snapshot.revision !== expectedRevision) {
            throw new RevisionConflictError(
              undefined,
              expectedRevision,
              snapshot.revision,
            );
          }

          return executeMutation(
            id,
            expectedRevision,
            { kind: "delete-task", taskId },
            [STORE_IMPORT_RECORDS],
          );
        },

        async commitImport(result: ImportResult): Promise<Handover> {
          validateHandover(result.handover);

          if (result.handover.revision !== 1) {
            throw new ValidationError("Imported workspace must start at revision 1.");
          }

          for (const task of result.handover.tasks) {
            if (
              task.state !== "draft" ||
              task.reviewedAt !== null ||
              task.provenance !== "imported"
            ) {
              throw new ValidationError(
                "All imported tasks must be draft, unreviewed, and have imported provenance.",
              );
            }
          }

          for (const source of result.handover.sources) {
            const actualSha = await sha256Utf8(source.text);
            if (actualSha !== source.sha256) {
              throw new ValidationError(`Source hash mismatch for ${source.id}`);
            }
          }

          const existingSnapshot = await readSnapshot(result.handover.id);
          if (existingSnapshot) {
            throw new ValidationError(`Handover with ID ${result.handover.id} already exists.`);
          }

          const importRecord: ImportRecord = {
            handoverId: result.handover.id,
            foreignReview: result.foreignReview,
            foreignSources: result.foreignSources,
          };

          await runTransaction(
            db,
            [STORE_HANDOVERS, STORE_IMPORT_RECORDS],
            "readwrite",
            (tx) => {
              const hStore = tx.objectStore(STORE_HANDOVERS);
              const impStore = tx.objectStore(STORE_IMPORT_RECORDS);

              hStore.add(result.handover);
              impStore.add(importRecord);
            },
          );

          return result.handover;
        },

        async getImportRecord(id: string): Promise<ImportRecord | null> {
          return runTransaction(
            db,
            [STORE_IMPORT_RECORDS],
            "readonly",
            (tx) => {
              const store = tx.objectStore(STORE_IMPORT_RECORDS);
              const req = store.get(id);
              return new Promise<ImportRecord | null>((res, rej) => {
                req.onsuccess = () => res(req.result ?? null);
                req.onerror = () => rej(req.error);
              });
            },
          );
        },
      };

      resolve(repository);
    };
  });
}
