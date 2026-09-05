import { sha256Utf8 } from "../domain/hash";
import {
  NotFoundError,
  RevisionConflictError,
  StorageError,
  ValidationError,
} from "../domain/errors";
import { applyMutation, type PreparedMutation } from "../domain/mutations";
import { suggest } from "../suggestions/deterministic";
import type {
  Handover,
  HandoverId,
  HandoverRepository,
  HandoverSummary,
  ImportResult,
  Revision,
  Source,
  Task,
} from "../domain/types";
import { validateHandover } from "../domain/validation";
import {
  DB_VERSION,
  type ImportRecord,
  STORE_HANDOVERS,
  STORE_IMPORT_RECORDS,
} from "./schema";
import {
  failOnRequestError,
  mapStorageError,
  runTransaction,
} from "./transactions";
import {
  cloneValue,
  prepareHandoverInput,
  prepareHandoverPatch,
  prepareImportResult,
  prepareSourceInput,
  prepareSourcePatch,
  prepareTaskInput,
  prepareTaskPatch,
  validateImportMetadata,
  validateNonempty,
  validateRevision,
  validateReviewDecision,
  throwValidationError,
} from "./validation";

export type { ImportRecord } from "./schema";
export interface Repository extends HandoverRepository {
  close(): void;
  commitImport(result: ImportResult): Promise<Handover>;
  getImportRecord(id: string): Promise<ImportRecord | null>;
}

const equal = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
let lastTime = 0;
function now(): string {
  lastTime = Math.max(lastTime + 1, Date.now());
  return new Date(lastTime).toISOString();
}

export function openRepository(
  name: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<Repository> {
  return new Promise((resolve, reject) => {
    let terminal = false;
    const rejectOnce = (error: unknown) => {
      if (!terminal) {
        terminal = true;
        reject(mapStorageError(error));
      }
    };
    let open: IDBOpenDBRequest;
    try {
      open = factory.open(name, DB_VERSION);
    } catch (error) {
      rejectOnce(error);
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_HANDOVERS))
        db.createObjectStore(STORE_HANDOVERS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_IMPORT_RECORDS))
        db.createObjectStore(STORE_IMPORT_RECORDS, { keyPath: "handoverId" });
    };
    open.onerror = () => rejectOnce(open.error ?? new StorageError());
    open.onblocked = () =>
      rejectOnce(new StorageError("Database open blocked."));
    open.onsuccess = () => {
      const db = open.result;
      if (terminal) {
        db.close();
        return;
      }
      terminal = true;
      db.onversionchange = () => db.close();
      const read = (handoverId: HandoverId) =>
        runTransaction<Handover | null>(
          db,
          [STORE_HANDOVERS],
          "readonly",
          (tx, control) => {
            const get = failOnRequestError(
              tx.objectStore(STORE_HANDOVERS).get(handoverId),
              control.fail,
            );
            get.onsuccess = () => {
              try {
                control.succeed(
                  get.result === undefined
                    ? null
                    : validateHandover(get.result),
                );
              } catch (error) {
                control.fail(error);
              }
            };
          },
        );
      const check = async (handoverId: HandoverId, expected: Revision) => {
        const current = await read(handoverId);
        if (!current) throw new NotFoundError("Handover was not found.");
        if (current.revision !== expected)
          throw new RevisionConflictError(
            undefined,
            expected,
            current.revision,
          );
        return current;
      };
      const mutate = (
        handoverId: HandoverId,
        expected: Revision,
        command: PreparedMutation,
        filter?: "source" | "task",
      ) =>
        runTransaction<Handover>(
          db,
          filter ? [STORE_HANDOVERS, STORE_IMPORT_RECORDS] : [STORE_HANDOVERS],
          "readwrite",
          (tx, control) => {
            const handovers = tx.objectStore(STORE_HANDOVERS);
            const get = failOnRequestError(
              handovers.get(handoverId),
              control.fail,
            );
            get.onsuccess = () => {
              try {
                if (get.result === undefined)
                  return control.fail(
                    new NotFoundError("Handover was not found."),
                  );
                const current = validateHandover(get.result);
                if (current.revision !== expected)
                  return control.fail(
                    new RevisionConflictError(
                      undefined,
                      expected,
                      current.revision,
                    ),
                  );
                const next = applyMutation(current, command, {
                  at: now(),
                  eventId: crypto.randomUUID(),
                });
                if (next === current) return control.succeed(current);
                failOnRequestError(handovers.put(next), control.fail);
                if (!filter) return control.succeed(next);
                const records = tx.objectStore(STORE_IMPORT_RECORDS);
                const recordGet = failOnRequestError(
                  records.get(handoverId),
                  control.fail,
                );
                recordGet.onsuccess = () => {
                  try {
                    if (recordGet.result !== undefined) {
                      const currentRecord = validateImportMetadata(
                        recordGet.result,
                        current,
                      );
                      const updated: ImportRecord =
                        filter === "source"
                          ? {
                              ...currentRecord,
                              foreignSources:
                                currentRecord.foreignSources.filter(
                                  (item) =>
                                    item.localSourceId !==
                                    (command as { sourceId: string }).sourceId,
                                ),
                            }
                          : {
                              ...currentRecord,
                              foreignReview: currentRecord.foreignReview.filter(
                                (item) =>
                                  item.taskId !==
                                  (command as { taskId: string }).taskId,
                              ),
                            };
                      failOnRequestError(records.put(updated), control.fail);
                    }
                    control.succeed(next);
                  } catch (error) {
                    control.fail(error);
                  }
                };
              } catch (error) {
                control.fail(error);
              }
            };
          },
        );
      const repository: Repository = {
        close: () => db.close(),
        async createHandover(input) {
          const prepared = cloneValue(
            prepareHandoverInput(input),
            "CreateHandoverInput",
          );
          const at = now();
          const handover: Handover = {
            id: crypto.randomUUID(),
            title: prepared.title,
            organization: prepared.organization,
            createdAt: at,
            updatedAt: at,
            sources: [],
            tasks: [],
            events: [
              {
                id: crypto.randomUUID(),
                at,
                kind: "created",
                detail: JSON.stringify({ action: "created" }),
              },
            ],
            revision: 1,
          };
          validateHandover(handover);
          return runTransaction(
            db,
            [STORE_HANDOVERS],
            "readwrite",
            (tx, control) => {
              failOnRequestError(
                tx.objectStore(STORE_HANDOVERS).add(handover),
                control.fail,
              );
              control.succeed(handover);
            },
          );
        },
        getHandover(handoverId) {
          validateNonempty(handoverId, "handover ID");
          return read(handoverId);
        },
        listHandovers() {
          return runTransaction<ReadonlyArray<HandoverSummary>>(
            db,
            [STORE_HANDOVERS],
            "readonly",
            (tx, control) => {
              const getAll = failOnRequestError(
                tx.objectStore(STORE_HANDOVERS).getAll(),
                control.fail,
              );
              getAll.onsuccess = () => {
                try {
                  const result = getAll.result.map((value) => {
                    const handover = validateHandover(value);
                    return {
                      id: handover.id,
                      title: handover.title,
                      organization: handover.organization,
                      updatedAt: handover.updatedAt,
                      revision: handover.revision,
                    };
                  });
                  result.sort(
                    (left, right) =>
                      right.updatedAt.localeCompare(left.updatedAt) ||
                      right.id.localeCompare(left.id),
                  );
                  control.succeed(result);
                } catch (error) {
                  control.fail(error);
                }
              };
            },
          );
        },
        async updateHandover(handoverId, expected, patch) {
          validateNonempty(handoverId, "handover ID");
          validateRevision(expected, "expectedRevision");
          const prepared = cloneValue(
            prepareHandoverPatch(patch),
            "HandoverPatch",
          );
          await check(handoverId, expected);
          return mutate(handoverId, expected, {
            kind: "update-handover",
            patch: prepared,
          });
        },
        async addSource(handoverId, expected, input) {
          validateNonempty(handoverId, "handover ID");
          validateRevision(expected, "expectedRevision");
          const prepared = cloneValue(
            prepareSourceInput(input),
            "CreateSourceInput",
          );
          await check(handoverId, expected);
          const source: Source = {
            id: crypto.randomUUID(),
            title: prepared.title,
            text: prepared.text,
            sha256: await sha256Utf8(prepared.text),
            revision: 1,
          };
          return mutate(handoverId, expected, { kind: "add-source", source });
        },
        async updateSource(handoverId, sourceId, expected, patch) {
          validateNonempty(handoverId, "handover ID");
          validateNonempty(sourceId, "source ID");
          validateRevision(expected, "expectedRevision");
          const prepared = cloneValue(prepareSourcePatch(patch), "SourcePatch");
          const handover = await check(handoverId, expected);
          const current = handover.sources.find(
            (source) => source.id === sourceId,
          );
          if (!current) throw new NotFoundError("Source was not found.");
          const nextText = prepared.text ?? current.text;
          const source: Source = {
            id: sourceId,
            title: prepared.title ?? current.title,
            text: nextText,
            sha256:
              nextText === current.text
                ? current.sha256
                : await sha256Utf8(nextText),
            revision: current.revision,
          };
          return mutate(handoverId, expected, {
            kind: "update-source",
            sourceId,
            source,
          });
        },
        async addTask(handoverId, expected, input) {
          validateNonempty(handoverId, "handover ID");
          validateRevision(expected, "expectedRevision");
          const prepared = cloneValue(
            prepareTaskInput(input),
            "CreateTaskInput",
          );
          const handover = await check(handoverId, expected);
          const task: Task =
            prepared.provenance === "deterministic-suggestion"
              ? (() => {
                  const candidate = handover.sources
                    .flatMap(suggest)
                    .find(
                      (item) =>
                        item.title === prepared.title &&
                        item.owner === (prepared.owner ?? null) &&
                        item.dueDate === (prepared.dueDate ?? null) &&
                        equal(item.citations, prepared.citations),
                    );
                  if (!candidate)
                    return throwValidationError(
                      "Deterministic suggestion does not match current sources.",
                    );
                  return cloneValue(candidate, "deterministic suggestion");
                })()
              : {
                  id: crypto.randomUUID(),
                  title: prepared.title,
                  owner: prepared.owner ?? null,
                  dueDate: prepared.dueDate ?? null,
                  citations: prepared.citations,
                  state: "draft",
                  reviewedAt: null,
                  provenance: prepared.provenance ?? "manual",
                };
          return mutate(handoverId, expected, { kind: "add-task", task });
        },
        async updateTask(handoverId, taskId, expected, patch) {
          validateNonempty(handoverId, "handover ID");
          validateNonempty(taskId, "task ID");
          validateRevision(expected, "expectedRevision");
          const prepared = cloneValue(prepareTaskPatch(patch), "TaskPatch");
          await check(handoverId, expected);
          return mutate(handoverId, expected, {
            kind: "update-task",
            taskId,
            patch: prepared,
          });
        },
        async reviewTask(handoverId, taskId, expected, decision) {
          validateNonempty(handoverId, "handover ID");
          validateNonempty(taskId, "task ID");
          validateRevision(expected, "expectedRevision");
          validateReviewDecision(decision);
          await check(handoverId, expected);
          return mutate(handoverId, expected, {
            kind: "review-task",
            taskId,
            decision,
          });
        },
        async deleteHandover(handoverId, expected) {
          validateNonempty(handoverId, "handover ID");
          validateRevision(expected, "expectedRevision");
          await check(handoverId, expected);
          await runTransaction<void>(
            db,
            [STORE_HANDOVERS, STORE_IMPORT_RECORDS],
            "readwrite",
            (tx, control) => {
              const handovers = tx.objectStore(STORE_HANDOVERS);
              const get = failOnRequestError(
                handovers.get(handoverId),
                control.fail,
              );
              get.onsuccess = () => {
                try {
                  if (get.result === undefined)
                    return control.fail(
                      new NotFoundError("Handover was not found."),
                    );
                  const current = validateHandover(get.result);
                  if (current.revision !== expected)
                    return control.fail(
                      new RevisionConflictError(
                        undefined,
                        expected,
                        current.revision,
                      ),
                    );
                  failOnRequestError(
                    handovers.delete(handoverId),
                    control.fail,
                  );
                  failOnRequestError(
                    tx.objectStore(STORE_IMPORT_RECORDS).delete(handoverId),
                    control.fail,
                  );
                  control.succeed(undefined);
                } catch (error) {
                  control.fail(error);
                }
              };
            },
          );
        },
        async deleteSource(handoverId, sourceId, expected) {
          validateNonempty(handoverId, "handover ID");
          validateNonempty(sourceId, "source ID");
          validateRevision(expected, "expectedRevision");
          await check(handoverId, expected);
          return mutate(
            handoverId,
            expected,
            { kind: "delete-source", sourceId },
            "source",
          );
        },
        async deleteTask(handoverId, taskId, expected) {
          validateNonempty(handoverId, "handover ID");
          validateNonempty(taskId, "task ID");
          validateRevision(expected, "expectedRevision");
          await check(handoverId, expected);
          return mutate(
            handoverId,
            expected,
            { kind: "delete-task", taskId },
            "task",
          );
        },
        async commitImport(result) {
          const packet = cloneValue(
            prepareImportResult(result),
            "ImportResult",
          );
          const handover = validateHandover(packet.handover);
          if (handover.revision !== 1)
            throwValidationError(
              "Imported workspace must start at revision 1.",
            );
          for (const task of handover.tasks)
            if (
              task.state !== "draft" ||
              task.reviewedAt !== null ||
              task.provenance !== "imported"
            )
              throwValidationError(
                "Imported tasks must be draft, unreviewed, and imported.",
              );
          const importRecord = validateImportMetadata(
            {
              handoverId: handover.id,
              foreignReview: packet.foreignReview,
              foreignSources: packet.foreignSources,
            },
            handover,
          );
          for (const source of handover.sources)
            if ((await sha256Utf8(source.text)) !== source.sha256)
              throwValidationError("Source hash mismatch.");
          if (await read(handover.id))
            throwValidationError("Handover ID already exists.");
          return runTransaction(
            db,
            [STORE_HANDOVERS, STORE_IMPORT_RECORDS],
            "readwrite",
            (tx, control) => {
              failOnRequestError(
                tx.objectStore(STORE_HANDOVERS).add(handover),
                control.fail,
              );
              failOnRequestError(
                tx.objectStore(STORE_IMPORT_RECORDS).add(importRecord),
                control.fail,
              );
              control.succeed(handover);
            },
          );
        },
        getImportRecord(handoverId) {
          validateNonempty(handoverId, "handover ID");
          return runTransaction<ImportRecord | null>(
            db,
            [STORE_HANDOVERS, STORE_IMPORT_RECORDS],
            "readonly",
            (tx, control) => {
              const recordGet = failOnRequestError(
                tx.objectStore(STORE_IMPORT_RECORDS).get(handoverId),
                control.fail,
              );
              recordGet.onsuccess = () => {
                try {
                  if (recordGet.result === undefined)
                    return control.succeed(null);
                  const handoverGet = failOnRequestError(
                    tx.objectStore(STORE_HANDOVERS).get(handoverId),
                    control.fail,
                  );
                  handoverGet.onsuccess = () => {
                    try {
                      if (handoverGet.result === undefined)
                        return control.fail(
                          new ValidationError(
                            "Import metadata references a missing handover.",
                          ),
                        );
                      control.succeed(
                        validateImportMetadata(
                          recordGet.result,
                          validateHandover(handoverGet.result),
                        ),
                      );
                    } catch (error) {
                      control.fail(error);
                    }
                  };
                } catch (error) {
                  control.fail(error);
                }
              };
            },
          );
        },
      };
      resolve(repository);
    };
  });
}
