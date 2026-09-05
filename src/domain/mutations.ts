import { NotFoundError, ValidationError } from "./errors";
import { validateHandover, verifyCitation } from "./validation";
import type {
  Handover,
  HandoverPatch,
  Source,
  Task,
  TaskPatch,
} from "./types";

export type PreparedMutation =
  | { kind: "update-handover"; patch: HandoverPatch }
  | { kind: "add-source"; source: Source }
  | { kind: "update-source"; sourceId: string; source: Source }
  | { kind: "delete-source"; sourceId: string }
  | { kind: "add-task"; task: Task }
  | { kind: "update-task"; taskId: string; patch: TaskPatch }
  | { kind: "review-task"; taskId: string; decision: "approved" | "rejected" }
  | { kind: "delete-task"; taskId: string };

type Context = { at: string; eventId: string };
const copy = <T>(value: T): T => structuredClone(value);
const fail = (message: string): never => {
  throw new ValidationError(message);
};
const nextRevision = (n: number): number => {
  if (n >= Number.MAX_SAFE_INTEGER) fail("revision overflow.");
  return n + 1;
};
const eventDetail = (kind: string, ids: Record<string, string>): string =>
  JSON.stringify({ action: kind, ...ids });
const assertKeys = (value: object, allowed: readonly string[], name: string): void => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !([Object.prototype, null] as unknown[]).includes(Object.getPrototypeOf(value))
  )
    fail(`${name} must be a plain object.`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${name} contains unknown field ${key}.`);
};

function finish(
  original: Handover,
  changed: Handover,
  context: Context,
  kind: string,
  ids: Record<string, string>,
): Handover {
  if (changed.events.some((event) => event.id === context.eventId))
    fail("duplicate event ID.");
  changed.revision = nextRevision(original.revision);
  changed.updatedAt = context.at;
  changed.events.push({
    id: context.eventId,
    at: context.at,
    kind: kind === "review-task" ? "reviewed" : "edited",
    detail: eventDetail(kind, ids),
  });
  validateHandover(changed);
  return changed;
}
function sourceFor(h: Handover, id: string): Source {
  const value = h.sources.find((source) => source.id === id);
  if (!value) throw new NotFoundError(`Source ${id} was not found.`);
  return value;
}
function taskFor(h: Handover, id: string): Task {
  const value = h.tasks.find((task) => task.id === id);
  if (!value) throw new NotFoundError(`Task ${id} was not found.`);
  return value;
}
function reset(task: Task): Task {
  return { ...task, state: "draft", reviewedAt: null };
}

export function applyMutation(
  handover: Handover,
  command: PreparedMutation,
  context: Context,
): Handover {
  validateHandover(handover);
  const original = copy(handover);
  const result = copy(handover);

  switch (command.kind) {
    case "update-handover": {
      const patch = command.patch;
      assertKeys(patch, ["title", "organization"], "handover patch");
      const patchValues = patch as Record<string, unknown>;
      const title = Object.prototype.hasOwnProperty.call(patch, "title")
        ? patchValues.title
        : result.title;
      const organization = Object.prototype.hasOwnProperty.call(
        patch,
        "organization",
      )
        ? patchValues.organization
        : result.organization;
      if (title === result.title && organization === result.organization) return handover;
      result.title = title as string;
      result.organization = organization as string;
      return finish(original, result, context, command.kind, { handoverId: handover.id });
    }
    case "add-source": {
      if (result.sources.some((source) => source.id === command.source.id)) {
        fail("duplicate source ID.");
      }
      if (command.source.revision !== 1) fail("new sources must start at revision 1.");
      result.sources.push(copy(command.source));
      return finish(original, result, context, command.kind, { sourceId: command.source.id });
    }
    case "update-source": {
      const current = sourceFor(result, command.sourceId);
      if (command.source.id !== command.sourceId) fail("source ID cannot change.");
      const changed = current.title !== command.source.title || current.text !== command.source.text;
      if (!changed) return handover;
      const replacement = { ...command.source, revision: nextRevision(current.revision) };
      result.sources = result.sources.map((source) =>
        source.id === command.sourceId ? replacement : source,
      );
      result.tasks = result.tasks.map((task) =>
        task.citations.some((citation) => citation.sourceId === command.sourceId)
          ? reset(task)
          : task,
      );
      return finish(original, result, context, command.kind, { sourceId: command.sourceId });
    }
    case "delete-source": {
      sourceFor(result, command.sourceId);
      result.sources = result.sources.filter((source) => source.id !== command.sourceId);
      result.tasks = result.tasks.map((task) =>
        task.citations.some((citation) => citation.sourceId === command.sourceId)
          ? {
              ...reset(task),
              citations: task.citations.filter(
                (citation) => citation.sourceId !== command.sourceId,
              ),
            }
          : task,
      );
      return finish(original, result, context, command.kind, { sourceId: command.sourceId });
    }
    case "add-task": {
      if (
        command.task.state !== "draft" ||
        command.task.reviewedAt !== null ||
        !["deterministic-suggestion", "manual", "imported"].includes(
          command.task.provenance,
        )
      )
        fail("new tasks must be draft and unreviewed with valid provenance.");
      if (result.tasks.some((task) => task.id === command.task.id)) {
        const existing = result.tasks.find((task) => task.id === command.task.id)!;
        if (existing.provenance === "deterministic-suggestion" && command.task.provenance === "deterministic-suggestion") return handover;
        fail("duplicate task ID.");
      }
      result.tasks.push(copy(command.task));
      return finish(original, result, context, command.kind, { taskId: command.task.id });
    }
    case "update-task": {
      const current = taskFor(result, command.taskId);
      const patch = command.patch;
      assertKeys(patch, ["title", "owner", "dueDate", "citations"], "task patch");
      const hasChange = (Object.keys(patch) as Array<keyof TaskPatch>).some((key) =>
        JSON.stringify(current[key]) !== JSON.stringify(patch[key]),
      );
      if (!hasChange) return handover;
      const next: Task = {
        ...current,
        ...patch,
        id: current.id,
        state: "draft",
        reviewedAt: null,
      };
      result.tasks = result.tasks.map((task) =>
        task.id === command.taskId ? next : task,
      );
      return finish(original, result, context, command.kind, { taskId: command.taskId });
    }
    case "review-task": {
      const current = taskFor(result, command.taskId);
      if (current.state === command.decision && current.reviewedAt !== null) return handover;
      if (command.decision === "approved") {
        if (current.citations.length === 0) fail("approved tasks require a citation.");
        current.citations.forEach((citation) => verifyCitation(sourceFor(result, citation.sourceId), citation));
      }
      result.tasks = result.tasks.map((task) =>
        task.id === command.taskId
          ? { ...task, state: command.decision, reviewedAt: context.at }
          : task,
      );
      return finish(original, result, context, command.kind, { taskId: command.taskId });
    }
    case "delete-task":
      taskFor(result, command.taskId);
      result.tasks = result.tasks.filter((task) => task.id !== command.taskId);
      return finish(original, result, context, command.kind, { taskId: command.taskId });
  }
}
