import { ValidationError } from "../domain/errors";
import { validateSourceText } from "../domain/validation";
import type {
  Citation,
  CreateHandoverInput,
  CreateSourceInput,
  CreateTaskInput,
  ForeignReviewRecord,
  Handover,
  HandoverPatch,
  ImportResult,
  Revision,
  SourcePatch,
  TaskPatch,
} from "../domain/types";
import type { ImportRecord } from "./schema";

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export function throwValidationError(message: string): never {
  throw new ValidationError(message);
}

const invalid = throwValidationError;

export function cloneValue<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    return throwValidationError(label + " must be cloneable.");
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid(label + " must be a plain object.");
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = plainRecord(value, label);
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) {
      invalid(label + " contains unknown field " + key + ".");
    }
  }
  return result;
}

export function validateNonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(label + " must be a nonempty string.");
  }
  return value as string;
}

function validateNullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") {
    invalid(label + " must be a string or null.");
  }
  return value as string | null;
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    invalid(label + " must be a string.");
  }
  return value as string;
}

export function validateRevision(value: unknown, label: string): Revision {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid(label + " must be a positive safe integer.");
  }
  return value as Revision;
}

function validateDate(value: unknown, label: string): string {
  const result = validateNonempty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    invalid(label + " must be an ISO date.");
  }
  const parts = result.split("-").map(Number);
  const actual = new Date(0);
  actual.setUTCHours(0, 0, 0, 0);
  actual.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  if (
    actual.getUTCFullYear() !== parts[0] ||
    actual.getUTCMonth() !== parts[1] - 1 ||
    actual.getUTCDate() !== parts[2]
  ) {
    invalid(label + " must be a real ISO date.");
  }
  return result;
}

function validateTimestamp(value: unknown, label: string): string {
  const result = validateNonempty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) {
    invalid(label + " must be an ISO UTC timestamp.");
  }
  const parsed = Date.parse(result);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== result) {
    invalid(label + " must be an ISO UTC timestamp.");
  }
  return result;
}

function validateHash(value: unknown, label: string): string {
  const result = validateNonempty(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) {
    invalid(label + " must be a lowercase SHA-256 digest.");
  }
  return result;
}

export function prepareHandoverInput(value: unknown): CreateHandoverInput {
  const input = exactRecord(
    value,
    ["title", "organization"],
    "CreateHandoverInput",
  );
  return {
    title: validateNonempty(input.title, "CreateHandoverInput.title"),
    organization: validateNonempty(
      input.organization,
      "CreateHandoverInput.organization",
    ),
  };
}

export function prepareSourceInput(value: unknown): CreateSourceInput {
  const input = exactRecord(value, ["title", "text"], "CreateSourceInput");
  const text = validateString(input.text, "CreateSourceInput.text");
  validateSourceText(text);
  return {
    title: validateNonempty(input.title, "CreateSourceInput.title"),
    text,
  };
}

export function prepareHandoverPatch(value: unknown): HandoverPatch {
  const input = exactRecord(value, ["title", "organization"], "HandoverPatch");
  const result: HandoverPatch = {};
  if (hasOwn(input, "title"))
    result.title = validateNonempty(input.title, "HandoverPatch.title");
  if (hasOwn(input, "organization"))
    result.organization = validateNonempty(
      input.organization,
      "HandoverPatch.organization",
    );
  return result;
}

export function prepareSourcePatch(value: unknown): SourcePatch {
  const input = exactRecord(value, ["title", "text"], "SourcePatch");
  const result: SourcePatch = {};
  if (hasOwn(input, "title"))
    result.title = validateNonempty(input.title, "SourcePatch.title");
  if (hasOwn(input, "text")) {
    result.text = validateString(input.text, "SourcePatch.text");
    validateSourceText(result.text);
  }
  return result;
}

function prepareCitations(value: unknown, label: string): Citation[] {
  if (!Array.isArray(value)) invalid(label + " must be an array.");
  return (value as unknown[]).map((item) => {
    const citation = exactRecord(
      item,
      ["sourceId", "sourceRevision", "quote"],
      "citation",
    );
    return {
      sourceId: validateNonempty(citation.sourceId, "citation.sourceId"),
      sourceRevision: validateRevision(
        citation.sourceRevision,
        "citation.sourceRevision",
      ),
      quote: validateNonempty(citation.quote, "citation.quote"),
    };
  });
}

export function prepareTaskInput(value: unknown): CreateTaskInput {
  const input = exactRecord(
    value,
    ["title", "owner", "dueDate", "citations", "provenance"],
    "CreateTaskInput",
  );
  const provenance = hasOwn(input, "provenance") ? input.provenance : "manual";
  if (
    provenance !== "manual" &&
    provenance !== "deterministic-suggestion" &&
    provenance !== "imported"
  )
    invalid("CreateTaskInput.provenance is invalid.");
  const result: CreateTaskInput = {
    title: validateNonempty(input.title, "CreateTaskInput.title"),
    citations: prepareCitations(input.citations, "CreateTaskInput.citations"),
    provenance: provenance as CreateTaskInput["provenance"],
  };
  if (hasOwn(input, "owner"))
    result.owner = validateNullableString(input.owner, "CreateTaskInput.owner");
  if (hasOwn(input, "dueDate"))
    result.dueDate =
      input.dueDate === null
        ? null
        : validateDate(input.dueDate, "CreateTaskInput.dueDate");
  return result;
}

export function prepareTaskPatch(value: unknown): TaskPatch {
  const input = exactRecord(
    value,
    ["title", "owner", "dueDate", "citations"],
    "TaskPatch",
  );
  const result: TaskPatch = {};
  if (hasOwn(input, "title"))
    result.title = validateNonempty(input.title, "TaskPatch.title");
  if (hasOwn(input, "owner"))
    result.owner = validateNullableString(input.owner, "TaskPatch.owner");
  if (hasOwn(input, "dueDate"))
    result.dueDate =
      input.dueDate === null
        ? null
        : validateDate(input.dueDate, "TaskPatch.dueDate");
  if (hasOwn(input, "citations"))
    result.citations = prepareCitations(input.citations, "TaskPatch.citations");
  return result;
}

export function prepareImportResult(value: unknown): ImportResult {
  return exactRecord(
    value,
    ["handover", "foreignReview", "foreignSources"],
    "ImportResult",
  ) as unknown as ImportResult;
}

export function validateImportMetadata(
  value: unknown,
  handover: Handover,
): ImportRecord {
  const input = exactRecord(
    value,
    ["handoverId", "foreignReview", "foreignSources"],
    "import record",
  );
  const handoverId = validateNonempty(
    input.handoverId,
    "import record.handoverId",
  );
  if (
    handoverId !== handover.id ||
    !Array.isArray(input.foreignReview) ||
    !Array.isArray(input.foreignSources)
  )
    invalid("import record is invalid.");
  const tasks = new Set(handover.tasks.map((task) => task.id));
  const sources = new Set(handover.sources.map((source) => source.id));
  const reviewSeen = new Set<string>();
  const sourceSeen = new Set<string>();
  const foreignReview = (input.foreignReview as unknown[]).map((item) => {
    const row = exactRecord(
      item,
      ["taskId", "importedState", "importedReviewedAt"],
      "foreign review",
    );
    const taskId = validateNonempty(row.taskId, "foreign review.taskId");
    if (!tasks.has(taskId) || reviewSeen.has(taskId))
      invalid("foreign review references an invalid or duplicate task.");
    reviewSeen.add(taskId);
    if (
      row.importedState !== "draft" &&
      row.importedState !== "approved" &&
      row.importedState !== "rejected"
    )
      invalid("foreign review state is invalid.");
    const importedReviewedAt =
      row.importedReviewedAt === null
        ? null
        : validateTimestamp(
            row.importedReviewedAt,
            "foreign review.importedReviewedAt",
          );
    if ((row.importedState === "draft") !== (importedReviewedAt === null))
      invalid("foreign review state and timestamp disagree.");
    return {
      taskId,
      importedState: row.importedState as ForeignReviewRecord["importedState"],
      importedReviewedAt,
    };
  });
  const foreignSources = (input.foreignSources as unknown[]).map((item) => {
    const row = exactRecord(
      item,
      [
        "localSourceId",
        "originalSourceId",
        "originalSourceRevision",
        "originalSourceSha256",
        "excerptSha256",
      ],
      "foreign source",
    );
    const localSourceId = validateNonempty(
      row.localSourceId,
      "foreign source.localSourceId",
    );
    if (!sources.has(localSourceId) || sourceSeen.has(localSourceId))
      invalid("foreign source references an invalid or duplicate source.");
    sourceSeen.add(localSourceId);
    return {
      localSourceId,
      originalSourceId: validateNonempty(
        row.originalSourceId,
        "foreign source.originalSourceId",
      ),
      originalSourceRevision: validateRevision(
        row.originalSourceRevision,
        "foreign source.originalSourceRevision",
      ),
      originalSourceSha256: validateHash(
        row.originalSourceSha256,
        "foreign source.originalSourceSha256",
      ),
      excerptSha256: validateHash(
        row.excerptSha256,
        "foreign source.excerptSha256",
      ),
    };
  });
  return { handoverId, foreignReview, foreignSources };
}

export function validateReviewDecision(
  value: unknown,
): "approved" | "rejected" {
  if (value !== "approved" && value !== "rejected")
    invalid("review decision is invalid.");
  return value as "approved" | "rejected";
}
