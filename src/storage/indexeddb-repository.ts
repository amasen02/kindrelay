import { sha256Utf8 } from "../domain/hash";
import { NotFoundError, RevisionConflictError, StorageError, ValidationError } from "../domain/errors";
import { applyMutation, type PreparedMutation } from "../domain/mutations";
import { suggest } from "../suggestions/deterministic";
import type { CreateHandoverInput, CreateSourceInput, CreateTaskInput, ForeignReviewRecord, ForeignSourceRecord, Handover, HandoverId, HandoverPatch, HandoverRepository, HandoverSummary, ImportResult, Revision, Source, SourceId, SourcePatch, Task, TaskId, TaskPatch } from "../domain/types";
import { validateHandover, validateSourceText } from "../domain/validation";
import { DB_VERSION, STORE_HANDOVERS, STORE_IMPORT_RECORDS } from "./schema";
import { failOnRequestError, mapStorageError, runTransaction } from "./transactions";

export interface ImportRecord {
  handoverId: string;
  foreignReview: ReadonlyArray<ForeignReviewRecord>;
  foreignSources: ReadonlyArray<ForeignSourceRecord>;
}
export interface Repository extends HandoverRepository {
  close(): void;
  commitImport(result: ImportResult): Promise<Handover>;
  getImportRecord(id: string): Promise<ImportRecord | null>;
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const invalid = (message: string): never => { throw new ValidationError(message); };
function clone<T>(value: T, label: string): T {
  try { return structuredClone(value); } catch { return invalid(label + " must be cloneable."); }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(label + " must be a plain object.");
  return value as Record<string, unknown>;
}
function exact(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label);
  for (const key of Object.keys(result)) if (!allowed.includes(key)) invalid(label + " contains unknown field " + key + ".");
  return result;
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(label + " must be a nonempty string.");
  return value as string;
}
function nullable(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") invalid(label + " must be a string or null.");
  return value as string | null;
}
function revision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(label + " must be a positive safe integer.");
  return value as number;
}
function date(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) invalid(label + " must be an ISO date.");
  const parts = result.split("-").map(Number); const actual = new Date(0);
  actual.setUTCHours(0, 0, 0, 0); actual.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  if (actual.getUTCFullYear() !== parts[0] || actual.getUTCMonth() !== parts[1] - 1 || actual.getUTCDate() !== parts[2]) invalid(label + " must be a real ISO date.");
  return result;
}
function timestamp(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || new Date(result).toISOString() !== result) invalid(label + " must be an ISO UTC timestamp.");
  return result;
}
function hash(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(label + " must be a lowercase SHA-256 digest.");
  return result;
}
function handoverInput(value: unknown): CreateHandoverInput {
  const input = exact(value, ["title", "organization"], "CreateHandoverInput");
  return { title: nonempty(input.title, "CreateHandoverInput.title"), organization: nonempty(input.organization, "CreateHandoverInput.organization") };
}
function sourceInput(value: unknown): CreateSourceInput {
  const input = exact(value, ["title", "text"], "CreateSourceInput");
  const text = nonempty(input.text, "CreateSourceInput.text"); validateSourceText(text);
  return { title: nonempty(input.title, "CreateSourceInput.title"), text };
}
function hPatch(value: unknown): HandoverPatch {
  const input = exact(value, ["title", "organization"], "HandoverPatch"); const result: HandoverPatch = {};
  if (own(input, "title")) result.title = nonempty(input.title, "HandoverPatch.title");
  if (own(input, "organization")) result.organization = nonempty(input.organization, "HandoverPatch.organization");
  return result;
}
function sPatch(value: unknown): SourcePatch {
  const input = exact(value, ["title", "text"], "SourcePatch"); const result: SourcePatch = {};
  if (own(input, "title")) result.title = nonempty(input.title, "SourcePatch.title");
  if (own(input, "text")) { result.text = nonempty(input.text, "SourcePatch.text"); validateSourceText(result.text); }
  return result;
}
function tInput(value: unknown): CreateTaskInput {
  const input = exact(value, ["title", "owner", "dueDate", "citations", "provenance"], "CreateTaskInput");
  const provenance = own(input, "provenance") ? input.provenance : "manual";
  if (provenance !== "manual" && provenance !== "deterministic-suggestion") invalid("CreateTaskInput.provenance is invalid.");
  if (!Array.isArray(input.citations)) invalid("CreateTaskInput.citations must be an array.");
  const result: CreateTaskInput = { title: nonempty(input.title, "CreateTaskInput.title"), citations: clone(input.citations, "CreateTaskInput.citations") as CreateTaskInput["citations"], provenance: provenance as CreateTaskInput["provenance"] };
  if (own(input, "owner")) result.owner = nullable(input.owner, "CreateTaskInput.owner");
  if (own(input, "dueDate")) result.dueDate = input.dueDate === null ? null : date(input.dueDate, "CreateTaskInput.dueDate");
  return result;
}
function tPatch(value: unknown): TaskPatch {
  const input = exact(value, ["title", "owner", "dueDate", "citations"], "TaskPatch"); const result: TaskPatch = {};
  if (own(input, "title")) result.title = nonempty(input.title, "TaskPatch.title");
  if (own(input, "owner")) result.owner = nullable(input.owner, "TaskPatch.owner");
  if (own(input, "dueDate")) result.dueDate = input.dueDate === null ? null : date(input.dueDate, "TaskPatch.dueDate");
  if (own(input, "citations")) { if (!Array.isArray(input.citations)) invalid("TaskPatch.citations must be an array."); result.citations = clone(input.citations, "TaskPatch.citations") as TaskPatch["citations"]; }
  return result;
}
function metadata(value: unknown, handover: Handover): ImportRecord {
  const input = exact(value, ["handoverId", "foreignReview", "foreignSources"], "import record");
  const handoverId = nonempty(input.handoverId, "import record.handoverId");
  if (handoverId !== handover.id || !Array.isArray(input.foreignReview) || !Array.isArray(input.foreignSources)) invalid("import record is invalid.");
  const tasks = new Set(handover.tasks.map((task) => task.id)); const sources = new Set(handover.sources.map((source) => source.id));
  const reviewSeen = new Set<string>(); const sourceSeen = new Set<string>();
  const foreignReview = (input.foreignReview as unknown[]).map((value) => {
    const row = exact(value, ["taskId", "importedState", "importedReviewedAt"], "foreign review");
    const taskId = nonempty(row.taskId, "foreign review.taskId");
    if (!tasks.has(taskId) || reviewSeen.has(taskId)) invalid("foreign review references an invalid or duplicate task.");
    reviewSeen.add(taskId);
    if (row.importedState !== "draft" && row.importedState !== "approved" && row.importedState !== "rejected") invalid("foreign review state is invalid.");
    const importedReviewedAt = row.importedReviewedAt === null ? null : timestamp(row.importedReviewedAt, "foreign review.importedReviewedAt");
    if ((row.importedState === "draft") !== (importedReviewedAt === null)) invalid("foreign review state and timestamp disagree.");
    return { taskId, importedState: row.importedState as ForeignReviewRecord["importedState"], importedReviewedAt };
  });
  const foreignSources = (input.foreignSources as unknown[]).map((value) => {
    const row = exact(value, ["localSourceId", "originalSourceId", "originalSourceRevision", "originalSourceSha256", "excerptSha256"], "foreign source");
    const localSourceId = nonempty(row.localSourceId, "foreign source.localSourceId");
    if (!sources.has(localSourceId) || sourceSeen.has(localSourceId)) invalid("foreign source references an invalid or duplicate source.");
    sourceSeen.add(localSourceId);
    return { localSourceId, originalSourceId: nonempty(row.originalSourceId, "foreign source.originalSourceId"), originalSourceRevision: revision(row.originalSourceRevision, "foreign source.originalSourceRevision"), originalSourceSha256: hash(row.originalSourceSha256, "foreign source.originalSourceSha256"), excerptSha256: hash(row.excerptSha256, "foreign source.excerptSha256") };
  });
  return { handoverId, foreignReview, foreignSources };
}
let lastTime = 0;
function now(): string { lastTime = Math.max(lastTime + 1, Date.now()); return new Date(lastTime).toISOString(); }

export function openRepository(name: string, factory: IDBFactory = globalThis.indexedDB): Promise<Repository> {
  return new Promise((resolve, reject) => {
    let terminal = false; const rejectOnce = (error: unknown) => { if (!terminal) { terminal = true; reject(mapStorageError(error)); } };
    let open: IDBOpenDBRequest; try { open = factory.open(name, DB_VERSION); } catch (error) { rejectOnce(error); return; }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_HANDOVERS)) db.createObjectStore(STORE_HANDOVERS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_IMPORT_RECORDS)) db.createObjectStore(STORE_IMPORT_RECORDS, { keyPath: "handoverId" });
    };
    open.onerror = () => rejectOnce(open.error ?? new StorageError());
    open.onblocked = () => rejectOnce(new StorageError("Database open blocked."));
    open.onsuccess = () => {
      const db = open.result; if (terminal) { db.close(); return; } terminal = true; db.onversionchange = () => db.close();
      const read = (handoverId: HandoverId) => runTransaction<Handover | null>(db, [STORE_HANDOVERS], "readonly", (tx, control) => {
        const get = failOnRequestError(tx.objectStore(STORE_HANDOVERS).get(handoverId), control.fail);
        get.onsuccess = () => { try { control.succeed(get.result === undefined ? null : validateHandover(get.result)); } catch (error) { control.fail(error); } };
      });
      const check = async (handoverId: HandoverId, expected: Revision) => {
        const current = await read(handoverId);
        if (!current) throw new NotFoundError("Handover was not found.");
        if (current.revision !== expected) throw new RevisionConflictError(undefined, expected, current.revision);
        return current;
      };
      const mutate = (handoverId: HandoverId, expected: Revision, command: PreparedMutation, filter?: "source" | "task") =>
        runTransaction<Handover>(db, filter ? [STORE_HANDOVERS, STORE_IMPORT_RECORDS] : [STORE_HANDOVERS], "readwrite", (tx, control) => {
          const handovers = tx.objectStore(STORE_HANDOVERS); const get = failOnRequestError(handovers.get(handoverId), control.fail);
          get.onsuccess = () => {
            try {
              if (get.result === undefined) return control.fail(new NotFoundError("Handover was not found."));
              const current = validateHandover(get.result);
              if (current.revision !== expected) return control.fail(new RevisionConflictError(undefined, expected, current.revision));
              const next = applyMutation(current, command, { at: now(), eventId: crypto.randomUUID() });
              if (next === current) return control.succeed(current);
              failOnRequestError(handovers.put(next), control.fail);
              if (!filter) return control.succeed(next);
              const records = tx.objectStore(STORE_IMPORT_RECORDS); const recordGet = failOnRequestError(records.get(handoverId), control.fail);
              recordGet.onsuccess = () => {
                try {
                  if (recordGet.result !== undefined) {
                    const currentRecord = metadata(recordGet.result, current);
                    const updated: ImportRecord = filter === "source"
                      ? { ...currentRecord, foreignSources: currentRecord.foreignSources.filter((item) => item.localSourceId !== (command as { sourceId: string }).sourceId) }
                      : { ...currentRecord, foreignReview: currentRecord.foreignReview.filter((item) => item.taskId !== (command as { taskId: string }).taskId) };
                    failOnRequestError(records.put(updated), control.fail);
                  }
                  control.succeed(next);
                } catch (error) { control.fail(error); }
              };
            } catch (error) { control.fail(error); }
          };
        });
      const repository: Repository = {
        close: () => db.close(),
        async createHandover(input) {
          const prepared = handoverInput(clone(input, "CreateHandoverInput")); const at = now();
          const handover: Handover = { id: crypto.randomUUID(), title: prepared.title, organization: prepared.organization, createdAt: at, updatedAt: at, sources: [], tasks: [], events: [{ id: crypto.randomUUID(), at, kind: "created", detail: JSON.stringify({ action: "created" }) }], revision: 1 };
          validateHandover(handover);
          return runTransaction(db, [STORE_HANDOVERS], "readwrite", (tx, control) => { failOnRequestError(tx.objectStore(STORE_HANDOVERS).add(handover), control.fail); control.succeed(handover); });
        },
        getHandover(handoverId) { nonempty(handoverId, "handover ID"); return read(handoverId); },
        listHandovers() {
          return runTransaction<ReadonlyArray<HandoverSummary>>(db, [STORE_HANDOVERS], "readonly", (tx, control) => {
            const getAll = failOnRequestError(tx.objectStore(STORE_HANDOVERS).getAll(), control.fail);
            getAll.onsuccess = () => { try {
              const result = getAll.result.map((value) => { const handover = validateHandover(value); return { id: handover.id, title: handover.title, organization: handover.organization, updatedAt: handover.updatedAt, revision: handover.revision }; });
              result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)); control.succeed(result);
            } catch (error) { control.fail(error); } };
          });
        },
        async updateHandover(handoverId, expected, patch) { nonempty(handoverId, "handover ID"); revision(expected, "expectedRevision"); const prepared = hPatch(clone(patch, "HandoverPatch")); await check(handoverId, expected); return mutate(handoverId, expected, { kind: "update-handover", patch: prepared }); },
        async addSource(handoverId, expected, input) {
          nonempty(handoverId, "handover ID"); revision(expected, "expectedRevision"); const prepared = sourceInput(clone(input, "CreateSourceInput")); await check(handoverId, expected);
          const source: Source = { id: crypto.randomUUID(), title: prepared.title, text: prepared.text, sha256: await sha256Utf8(prepared.text), revision: 1 };
          return mutate(handoverId, expected, { kind: "add-source", source });
        },
        async updateSource(handoverId, sourceId, expected, patch) {
          nonempty(handoverId, "handover ID"); nonempty(sourceId, "source ID"); revision(expected, "expectedRevision"); const prepared = sPatch(clone(patch, "SourcePatch"));
          const handover = await check(handoverId, expected); const current = handover.sources.find((source) => source.id === sourceId);
          if (!current) throw new NotFoundError("Source was not found.");
          const nextText = prepared.text ?? current.text;
          const source: Source = { id: sourceId, title: prepared.title ?? current.title, text: nextText, sha256: nextText === current.text ? current.sha256 : await sha256Utf8(nextText), revision: current.revision };
          return mutate(handoverId, expected, { kind: "update-source", sourceId, source });
        },
        async addTask(handoverId, expected, input) {
          nonempty(handoverId, "handover ID"); revision(expected, "expectedRevision"); const prepared = tInput(clone(input, "CreateTaskInput")); const handover = await check(handoverId, expected);
          const task: Task = prepared.provenance === "deterministic-suggestion"
            ? (() => { const candidate = handover.sources.flatMap(suggest).find((item) => item.title === prepared.title && item.owner === (prepared.owner ?? null) && item.dueDate === (prepared.dueDate ?? null) && equal(item.citations, prepared.citations)); if (!candidate) return invalid("Deterministic suggestion does not match current sources."); return clone(candidate, "deterministic suggestion"); })()
            : { id: crypto.randomUUID(), title: prepared.title, owner: prepared.owner ?? null, dueDate: prepared.dueDate ?? null, citations: prepared.citations, state: "draft", reviewedAt: null, provenance: "manual" };
          return mutate(handoverId, expected, { kind: "add-task", task });
        },
        async updateTask(handoverId, taskId, expected, patch) { nonempty(handoverId, "handover ID"); nonempty(taskId, "task ID"); revision(expected, "expectedRevision"); const prepared = tPatch(clone(patch, "TaskPatch")); await check(handoverId, expected); return mutate(handoverId, expected, { kind: "update-task", taskId, patch: prepared }); },
        async reviewTask(handoverId, taskId, expected, decision) { nonempty(handoverId, "handover ID"); nonempty(taskId, "task ID"); revision(expected, "expectedRevision"); if (decision !== "approved" && decision !== "rejected") invalid("review decision is invalid."); await check(handoverId, expected); return mutate(handoverId, expected, { kind: "review-task", taskId, decision }); },
        async deleteHandover(handoverId, expected) {
          nonempty(handoverId, "handover ID"); revision(expected, "expectedRevision"); await check(handoverId, expected);
          await runTransaction<void>(db, [STORE_HANDOVERS, STORE_IMPORT_RECORDS], "readwrite", (tx, control) => {
            const handovers = tx.objectStore(STORE_HANDOVERS); const get = failOnRequestError(handovers.get(handoverId), control.fail);
            get.onsuccess = () => { try {
              if (get.result === undefined) return control.fail(new NotFoundError("Handover was not found."));
              const current = validateHandover(get.result); if (current.revision !== expected) return control.fail(new RevisionConflictError(undefined, expected, current.revision));
              failOnRequestError(handovers.delete(handoverId), control.fail); failOnRequestError(tx.objectStore(STORE_IMPORT_RECORDS).delete(handoverId), control.fail); control.succeed(undefined);
            } catch (error) { control.fail(error); } };
          });
        },
        async deleteSource(handoverId, sourceId, expected) { nonempty(handoverId, "handover ID"); nonempty(sourceId, "source ID"); revision(expected, "expectedRevision"); await check(handoverId, expected); return mutate(handoverId, expected, { kind: "delete-source", sourceId }, "source"); },
        async deleteTask(handoverId, taskId, expected) { nonempty(handoverId, "handover ID"); nonempty(taskId, "task ID"); revision(expected, "expectedRevision"); await check(handoverId, expected); return mutate(handoverId, expected, { kind: "delete-task", taskId }, "task"); },
        async commitImport(result) {
          const packet = exact(clone(result, "ImportResult"), ["handover", "foreignReview", "foreignSources"], "ImportResult"); const handover = validateHandover(packet.handover);
          if (handover.revision !== 1) invalid("Imported workspace must start at revision 1.");
          for (const task of handover.tasks) if (task.state !== "draft" || task.reviewedAt !== null || task.provenance !== "imported") invalid("Imported tasks must be draft, unreviewed, and imported.");
          const importRecord = metadata({ handoverId: handover.id, foreignReview: packet.foreignReview, foreignSources: packet.foreignSources }, handover);
          for (const source of handover.sources) if (await sha256Utf8(source.text) !== source.sha256) invalid("Source hash mismatch.");
          if (await read(handover.id)) invalid("Handover ID already exists.");
          return runTransaction(db, [STORE_HANDOVERS, STORE_IMPORT_RECORDS], "readwrite", (tx, control) => { failOnRequestError(tx.objectStore(STORE_HANDOVERS).add(handover), control.fail); failOnRequestError(tx.objectStore(STORE_IMPORT_RECORDS).add(importRecord), control.fail); control.succeed(handover); });
        },
        getImportRecord(handoverId) {
          nonempty(handoverId, "handover ID");
          return runTransaction<ImportRecord | null>(db, [STORE_HANDOVERS, STORE_IMPORT_RECORDS], "readonly", (tx, control) => {
            const recordGet = failOnRequestError(tx.objectStore(STORE_IMPORT_RECORDS).get(handoverId), control.fail);
            recordGet.onsuccess = () => { try {
              if (recordGet.result === undefined) return control.succeed(null);
              const handoverGet = failOnRequestError(tx.objectStore(STORE_HANDOVERS).get(handoverId), control.fail);
              handoverGet.onsuccess = () => { try { if (handoverGet.result === undefined) return control.fail(new ValidationError("Import metadata references a missing handover.")); control.succeed(metadata(recordGet.result, validateHandover(handoverGet.result))); } catch (error) { control.fail(error); } };
            } catch (error) { control.fail(error); } };
          });
        },
      };
      resolve(repository);
    };
  });
}
