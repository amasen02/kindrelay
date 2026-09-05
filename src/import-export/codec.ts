import { sha256Utf8 } from "../domain/hash";
import { ValidationError } from "../domain/errors";
import type {
  ExportPacket,
  ForeignReviewRecord,
  ForeignSourceRecord,
  Handover,
  ImportResult,
  PacketCodec,
  PrivateBackupPacket,
  Source,
  Task,
} from "../domain/types";
import { validateHandover } from "../domain/validation";
import { renderMarkdown } from "./markdown";
import {
  parseInput,
  QUOTE_LIMIT,
  rawInputSize,
  tupleKey,
  utf8Size,
  validatePrivateBackup,
  validateSharePacket,
} from "./schema";

const SHARE_LIMIT = 1024 * 1024;
const DESTINATION_LIMIT = 8 * 1024 * 1024;
const PRIVATE_WARNING = "Private backup: contains the complete local workspace and may include sensitive notes.";
const SHARE_WARNING = "Share only with recipients authorized to receive approved task excerpts and provenance metadata.";

const fail = (message: string): never => {
  throw new ValidationError(message);
};
const now = () => new Date().toISOString();

const projectionId = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

async function verifiedHandover(value: Handover): Promise<Handover> {
  const snapshot = validateHandover(value);
  for (const source of snapshot.sources) {
    if ((await sha256Utf8(source.text)) !== source.sha256)
      fail("Source hash mismatch.");
  }
  return snapshot;
}

function selectedTasks(
  handover: Handover,
  selectedTaskIds?: ReadonlyArray<string>,
): Task[] {
  const approved = handover.tasks.filter((task) => task.state === "approved");
  const ids = selectedTaskIds === undefined ? approved.map((task) => task.id) : [...selectedTaskIds];
  if (ids.length === 0) fail("Select at least one approved task.");
  if (new Set(ids).size !== ids.length) fail("Selected task IDs must be unique.");
  const result = ids.map((id) => handover.tasks.find((task) => task.id === id));
  if (result.some((task) => !task || task.state !== "approved"))
    fail("Selected tasks must exist and be approved.");
  return result as Task[];
}

async function makeSharePacket(
  handover: Handover,
  selectedTaskIds?: ReadonlyArray<string>,
): Promise<ExportPacket> {
  const selected = selectedTasks(handover, selectedTaskIds);
  const citations = selected.flatMap((task) => task.citations);
  const tupleKeys = new Set<string>();
  for (const citation of citations) {
    if (utf8Size(citation.quote) > QUOTE_LIMIT)
      fail("Citation quote exceeds 65536 UTF-8 bytes; select fewer items.");
    tupleKeys.add(tupleKey(citation.sourceId, citation.sourceRevision, citation.quote));
  }
  if (tupleKeys.size > 50) fail("Share has more than 50 excerpts; select fewer items.");
  const sourceIds = new Set(citations.map((citation) => citation.sourceId));
  const sources = handover.sources
    .filter((source) => sourceIds.has(source.id))
    .map(({ id, title, sha256, revision }) => ({ id, title, sha256, revision }));
  const tasks = await Promise.all(selected.map(async (task) => ({
    id: task.id,
    title: task.title,
    owner: task.owner,
    dueDate: task.dueDate,
    state: task.state,
    citations: await Promise.all(task.citations.map(async (citation) => ({
      ...citation,
      excerptSha256: await sha256Utf8(citation.quote),
    }))),
    reviewedAt: task.reviewedAt,
    provenance: task.provenance,
  })));
  const packet: ExportPacket = {
    format: "json",
    schemaVersion: 1,
    handoverId: handover.id,
    tasks,
    sources,
    warning: SHARE_WARNING,
  };
  if (utf8Size(JSON.stringify(packet)) > SHARE_LIMIT)
    fail("Share packet exceeds 1 MiB; select fewer items.");
  assertDestinationBudget(packet);
  return packet;
}

function assertDestinationBudget(packet: ExportPacket): void {
  const importedSources = new Map<string, Source>();
  for (const task of packet.tasks) {
    for (const citation of task.citations) {
      const key = tupleKey(
        citation.sourceId,
        citation.sourceRevision,
        citation.quote,
      );
      if (importedSources.has(key)) continue;
      const source = packet.sources.find((item) => item.id === citation.sourceId)!;
      importedSources.set(key, {
        id: projectionId(importedSources.size),
        title: source.title,
        text: citation.quote,
        sha256: citation.excerptSha256,
        revision: 1,
      });
    }
  }
  const sourcesByTuple = [...importedSources.entries()];
  const destination = {
    id: projectionId(500),
    title: "Imported handover",
    organization: "Imported workspace",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    sources: sourcesByTuple.map(([, source]) => source),
    tasks: packet.tasks.map((task, index) => ({
      id: projectionId(600 + index),
      title: task.title,
      owner: task.owner,
      dueDate: task.dueDate,
      state: "draft" as const,
      citations: task.citations.map((citation) => ({
        sourceId: importedSources.get(
          tupleKey(citation.sourceId, citation.sourceRevision, citation.quote),
        )!.id,
        sourceRevision: 1,
        quote: citation.quote,
      })),
      reviewedAt: null,
      provenance: "imported" as const,
    })),
    events: [{
      id: projectionId(1_200),
      at: "2000-01-01T00:00:00.000Z",
      kind: "imported" as const,
      detail: JSON.stringify({ action: "imported" }),
    }],
    revision: 1,
  };
  if (utf8Size(JSON.stringify(destination)) > DESTINATION_LIMIT)
    fail("Import destination exceeds 8 MiB; select fewer items.");
}

export async function exportApproved(
  handover: Handover,
  format: "json" | "markdown",
  selectedTaskIds?: ReadonlyArray<string>,
): Promise<ExportPacket> {
  const snapshot = validateHandover(handover);
  const selectedSnapshot = selectedTaskIds === undefined ? undefined : [...selectedTaskIds];
  const verified = await verifiedHandover(snapshot);
  const packet = await makeSharePacket(verified, selectedSnapshot);
  if (format === "json") return packet;
  if (format !== "markdown") fail("Export format is unsupported.");
  const markdownPacket: ExportPacket = { ...packet, format: "markdown" };
  if (utf8Size(JSON.stringify(markdownPacket)) > SHARE_LIMIT)
    fail("Share packet exceeds 1 MiB; select fewer items.");
  if (utf8Size(renderMarkdown(markdownPacket)) > SHARE_LIMIT)
    fail("Rendered Markdown exceeds 1 MiB; select fewer items.");
  return markdownPacket;
}

export async function exportPrivateBackup(handover: Handover): Promise<PrivateBackupPacket> {
  const snapshot = validateHandover(handover);
  const verified = await verifiedHandover(snapshot);
  const packet: PrivateBackupPacket = {
    format: "private-backup-json",
    schemaVersion: 1,
    privateWarning: PRIVATE_WARNING,
    handover: verified,
  };
  if (utf8Size(JSON.stringify(packet)) > 16 * 1024 * 1024)
    fail("Private backup exceeds 16 MiB.");
  return packet;
}

function importedEvent() {
  const at = now();
  return { id: crypto.randomUUID(), at, kind: "imported" as const, detail: JSON.stringify({ action: "imported" }) };
}

async function importShare(packet: ExportPacket): Promise<ImportResult> {
  const sources = new Map(packet.sources.map((source) => [source.id, source]));
  const localSources = new Map<string, Source>();
  const foreignSources: ForeignSourceRecord[] = [];
  for (const task of packet.tasks) for (const citation of task.citations) {
    const key = tupleKey(citation.sourceId, citation.sourceRevision, citation.quote);
    if ((await sha256Utf8(citation.quote)) !== citation.excerptSha256)
      fail("Citation excerpt hash mismatch.");
    if (localSources.has(key)) continue;
    const original = sources.get(citation.sourceId)!;
    const local: Source = {
      id: crypto.randomUUID(),
      title: original.title,
      text: citation.quote,
      sha256: await sha256Utf8(citation.quote),
      revision: 1,
    };
    localSources.set(key, local);
    foreignSources.push({
      localSourceId: local.id,
      originalSourceId: original.id,
      originalSourceRevision: original.revision,
      originalSourceSha256: original.sha256,
      excerptSha256: citation.excerptSha256,
    });
  }
  const foreignReview: ForeignReviewRecord[] = [];
  const tasks: Task[] = packet.tasks.map((task) => {
    const localTask: Task = {
      id: crypto.randomUUID(), title: task.title, owner: task.owner, dueDate: task.dueDate,
      state: "draft", citations: task.citations.map((citation) => ({
        sourceId: localSources.get(tupleKey(citation.sourceId, citation.sourceRevision, citation.quote))!.id,
        sourceRevision: 1, quote: citation.quote,
      })), reviewedAt: null, provenance: "imported",
    };
    foreignReview.push({ taskId: localTask.id, importedState: task.state, importedReviewedAt: task.reviewedAt });
    return localTask;
  });
  const at = now();
  const handover = validateHandover({
    id: crypto.randomUUID(), title: "Imported handover", organization: "Imported workspace",
    createdAt: at, updatedAt: at, sources: [...localSources.values()], tasks,
    events: [importedEvent()], revision: 1,
  });
  return { handover, foreignReview, foreignSources };
}

async function importBackup(packet: PrivateBackupPacket): Promise<ImportResult> {
  const original = await verifiedHandover(packet.handover);
  const sources = new Map<string, Source>();
  for (const source of original.sources) sources.set(source.id, {
    ...source,
    id: crypto.randomUUID(),
  });
  const foreignReview: ForeignReviewRecord[] = [];
  const foreignSources: ForeignSourceRecord[] = original.sources.map((source) => ({
    localSourceId: sources.get(source.id)!.id,
    originalSourceId: source.id,
    originalSourceRevision: source.revision,
    originalSourceSha256: source.sha256,
    excerptSha256: source.sha256,
  }));
  const tasks = original.tasks.map((task) => {
    const local: Task = {
      ...task,
      id: crypto.randomUUID(),
      state: "draft",
      reviewedAt: null,
      provenance: "imported",
      citations: task.citations.map((citation) => ({
        ...citation,
        sourceId: sources.get(citation.sourceId)!.id,
      })),
    };
    foreignReview.push({ taskId: local.id, importedState: task.state, importedReviewedAt: task.reviewedAt });
    return local;
  });
  const at = now();
  const handover = validateHandover({
    id: crypto.randomUUID(), title: original.title, organization: original.organization,
    createdAt: at, updatedAt: at, sources: [...sources.values()], tasks,
    events: [...original.events.map((event) => ({ ...event, id: crypto.randomUUID() })), importedEvent()],
    revision: 1,
  });
  return { handover, foreignReview, foreignSources };
}

export async function importPacket(input: ArrayBuffer | string): Promise<ImportResult> {
  const parsed = parseInput(input);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    fail("Packet must be an object.");
  const format = (parsed as Record<string, unknown>).format;
  if (format === "json") {
    if (rawInputSize(input) > SHARE_LIMIT)
      fail("Share packet exceeds 1 MiB; select fewer items.");
    return importShare(validateSharePacket(parsed));
  }
  if (format === "private-backup-json") return importBackup(validatePrivateBackup(parsed));
  if (format === "markdown") fail("Markdown imports are unsupported.");
  return fail("Packet format is unsupported.");
}

export function renderPacket(packet: ExportPacket): string {
  return packet.format === "json" ? JSON.stringify(packet) : renderMarkdown(packet);
}

export const packetCodec: PacketCodec = {
  exportApproved,
  exportPrivateBackup,
  importPacket,
  renderPacket,
};
