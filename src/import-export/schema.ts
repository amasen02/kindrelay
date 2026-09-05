import { ValidationError } from "../domain/errors";
import type {
  ExportCitation,
  ExportPacket,
  PrivateBackupPacket,
  Task,
} from "../domain/types";
import { utf8Size, validateHandover } from "../domain/validation";

export { utf8Size } from "../domain/validation";

const SHARE_LIMIT = 1024 * 1024;
export const RAW_LIMIT = 16 * 1024 * 1024;
export const QUOTE_LIMIT = 65_536;

const fail = (message: string): never => {
  throw new ValidationError(message);
};
const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`);
  return value as Record<string, unknown>;
};
const fields = (value: Record<string, unknown>, allowed: readonly string[], name: string) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${name} contains unknown field ${key}.`);
};
const string = (value: unknown, name: string, nonempty = false): string => {
  if (typeof value !== "string" || (nonempty && value.trim() === ""))
    fail(`${name} must be${nonempty ? " a nonempty" : ""} string.`);
  return value as string;
};
const nullableString = (value: unknown, name: string) =>
  value === null ? null : string(value, name);
const array = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  return value as unknown[];
};
const revision = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1)
    fail(`${name} must be a positive safe integer.`);
  return value as number;
};
const digest = (value: unknown, name: string) => {
  const result = string(value, name);
  if (!/^[a-f0-9]{64}$/.test(result))
    fail(`${name} must be a lowercase SHA-256 digest.`);
  return result;
};
const iso = (value: unknown, name: string): string => {
  const result = string(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result))
    fail(`${name} must be an ISO UTC timestamp.`);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result)
    fail(`${name} is not a real calendar timestamp.`);
  return result;
};
const date = (value: unknown, name: string): string => {
  const result = string(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(`${name} must be an ISO date.`);
  const [year, month, day] = result.split("-").map(Number);
  const actual = new Date(0);
  actual.setUTCHours(0, 0, 0, 0);
  actual.setUTCFullYear(year, month - 1, day);
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() !== month - 1 || actual.getUTCDate() !== day)
    fail(`${name} is not a real calendar date.`);
  return result;
};
const unique = (values: readonly string[], name: string) => {
  if (new Set(values).size !== values.length) fail(`${name} contains duplicate IDs.`);
};

function citation(value: unknown): ExportCitation {
  const item = record(value, "citation");
  fields(item, ["sourceId", "sourceRevision", "quote", "excerptSha256"], "citation");
  const quote = string(item.quote, "citation.quote", true);
  if (utf8Size(quote) > QUOTE_LIMIT) fail("citation.quote exceeds 65536 UTF-8 bytes.");
  return {
    sourceId: string(item.sourceId, "citation.sourceId", true),
    sourceRevision: revision(item.sourceRevision, "citation.sourceRevision"),
    quote,
    excerptSha256: digest(item.excerptSha256, "citation.excerptSha256"),
  };
}

function source(value: unknown): ExportPacket["sources"][number] {
  const item = record(value, "source");
  fields(item, ["id", "title", "sha256", "revision"], "source");
  return {
    id: string(item.id, "source.id", true),
    title: string(item.title, "source.title", true),
    sha256: digest(item.sha256, "source.sha256"),
    revision: revision(item.revision, "source.revision"),
  };
}

function task(value: unknown): ExportPacket["tasks"][number] {
  const item = record(value, "task");
  fields(item, ["id", "title", "owner", "dueDate", "state", "citations", "reviewedAt", "provenance"], "task");
  const state = string(item.state, "task.state");
  if (state !== "approved") fail("share tasks must be approved.");
  const provenance = string(item.provenance, "task.provenance");
  if (!(["manual", "deterministic-suggestion", "imported"] as string[]).includes(provenance))
    fail("task.provenance is invalid.");
  const reviewedAt = iso(item.reviewedAt, "task.reviewedAt");
  return {
    id: string(item.id, "task.id", true),
    title: string(item.title, "task.title", true),
    owner: nullableString(item.owner, "task.owner"),
    dueDate: item.dueDate === null ? null : date(item.dueDate, "task.dueDate"),
    state: "approved",
    citations: array(item.citations, "task.citations").map(citation),
    reviewedAt,
    provenance: provenance as Task["provenance"],
  };
}

export function rawInputSize(input: ArrayBuffer | string): number {
  return typeof input === "string" ? utf8Size(input) : input.byteLength;
}

export function parseInput(input: ArrayBuffer | string): unknown {
  let text = "";
  if (typeof input === "string") {
    if (rawInputSize(input) > RAW_LIMIT) fail("Packet exceeds the 16 MiB raw input limit.");
    text = input;
  } else if (input instanceof ArrayBuffer) {
    if (rawInputSize(input) > RAW_LIMIT) fail("Packet exceeds the 16 MiB raw input limit.");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      fail("Packet is not valid UTF-8.");
    }
  } else {
    fail("Packet input must be a string or ArrayBuffer.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("Packet must be valid JSON; Markdown imports are unsupported.");
  }
}

export function validateSharePacket(value: unknown): ExportPacket {
  const item = record(value, "packet");
  fields(item, ["format", "schemaVersion", "handoverId", "tasks", "sources", "warning"], "packet");
  if (item.format !== "json") fail("Only JSON share packets can be imported.");
  if (item.schemaVersion !== 1) fail("Unsupported packet schema version.");
  const sources = array(item.sources, "packet.sources").map(source);
  const tasks = array(item.tasks, "packet.tasks").map(task);
  if (tasks.length === 0 || tasks.length > 500) fail("Share packet task count is invalid.");
  unique(sources.map((entry) => entry.id), "sources");
  unique(tasks.map((entry) => entry.id), "tasks");
  const tuples = new Set<string>();
  for (const entry of tasks) {
    if (entry.citations.length === 0) fail("Approved share tasks require a citation.");
    for (const cite of entry.citations) {
      const cited = sources.find((candidate) => candidate.id === cite.sourceId);
      if (!cited || cited.revision !== cite.sourceRevision)
        fail("citation source does not match provided source metadata.");
      tuples.add(tupleKey(cite.sourceId, cite.sourceRevision, cite.quote));
    }
  }
  if (tuples.size > 50) fail("Share has more than 50 excerpts; select fewer items.");
  const result: ExportPacket = {
    format: "json",
    schemaVersion: 1,
    handoverId: string(item.handoverId, "packet.handoverId", true),
    tasks,
    sources,
    warning: string(item.warning, "packet.warning", true),
  };
  if (utf8Size(JSON.stringify(result)) > SHARE_LIMIT)
    fail("Share packet exceeds 1 MiB; select fewer items.");
  return result;
}

export function validatePrivateBackup(value: unknown): PrivateBackupPacket {
  const item = record(value, "packet");
  fields(item, ["format", "schemaVersion", "privateWarning", "handover"], "packet");
  if (item.format !== "private-backup-json") fail("Packet format is not a private backup.");
  if (item.schemaVersion !== 1) fail("Unsupported packet schema version.");
  return {
    format: "private-backup-json",
    schemaVersion: 1,
    privateWarning: string(item.privateWarning, "packet.privateWarning", true),
    handover: validateHandover(item.handover),
  };
}

export function tupleKey(sourceId: string, sourceRevision: number, quote: string): string {
  return JSON.stringify([sourceId, sourceRevision, quote]);
}
