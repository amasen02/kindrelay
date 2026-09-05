import { describe, expect, it } from "vitest";
import { handover, NOW, source, task } from "../fixtures";
import { NotFoundError, ValidationError } from "../../src/domain/errors";
import { applyMutation } from "../../src/domain/mutations";

const at = { at: "2026-09-05T01:00:00.000Z", eventId: "event-1" };
const addSource = (id = "source-2") => source({ id, title: "Other", text: "TODO: Check it." });
describe("applyMutation", () => {
  it("applies a header edit immutably with one revision and generic event", () => {
    const input = handover(); const before = structuredClone(input);
    const output = applyMutation(input, { kind: "update-handover", patch: { title: "New title" } }, at);
    expect(input).toEqual(before); expect(output.revision).toBe(2); expect(output.updatedAt).toBe(at.at);
    expect(output.events).toEqual([{ id: "event-1", at: at.at, kind: "edited", detail: '{"action":"update-handover","handoverId":"handover-1"}' }]);
    expect(output.tasks[0].state).toBe("approved");
  });
  it("applies an organization edit as one revision and event", () => {
    const result = applyMutation(
      handover(),
      { kind: "update-handover", patch: { organization: "New Org" } },
      at,
    );
    expect(result.organization).toBe("New Org");
    expect(result.revision).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].detail).toContain("update-handover");
  });
  it("increments revision and appends one generic event for each real mutation", () => {
    const source2 = source({ id: "source-2", text: "Other source." });
    const draft = task({
      id: "task-2",
      state: "draft",
      reviewedAt: null,
      citations: [],
    });
    const commands = [
      { kind: "add-source", source: source2 },
      { kind: "add-task", task: draft },
      { kind: "update-task", taskId: "task-2", patch: { title: "Edited" } },
      { kind: "review-task", taskId: "task-2", decision: "rejected" as const },
      { kind: "delete-task", taskId: "task-2" },
      { kind: "delete-source", sourceId: "source-2" },
    ] as const;
    let current = handover();
    commands.forEach((command, index) => {
      current = applyMutation(current, command as never, {
        at: `2026-09-05T01:00:0${index + 1}.000Z`,
        eventId: `event-${index + 1}`,
      });
      expect(current.revision).toBe(index + 2);
      expect(current.events).toHaveLength(index + 1);
      expect(current.events[index].detail).not.toMatch(/Other source|Edited/);
    });
  });
  it("makes equal patches and repeated reviews no-ops", () => {
    const input = handover();
    expect(applyMutation(input, { kind: "update-handover", patch: { title: input.title } }, at)).toBe(input);
    expect(applyMutation(input, { kind: "review-task", taskId: "task-1", decision: "approved" }, at)).toBe(input);
    expect(applyMutation(input, { kind: "update-task", taskId: "task-1", patch: {} }, at)).toBe(input);
  });
  it("adds, updates, and deletes sources while invalidating only citing tasks", () => {
    const other = task({ id: "task-2", citations: [], state: "draft", reviewedAt: null });
    const added = applyMutation(handover({ tasks: [task(), other] }), { kind: "add-source", source: addSource() }, at);
    expect(added.sources).toHaveLength(2);
    const updated = applyMutation(added, { kind: "update-source", sourceId: "source-1", source: source({ title: "Changed" }) }, { ...at, eventId: "event-2" });
    expect(updated.sources[0].revision).toBe(2); expect(updated.tasks[0].state).toBe("draft"); expect(updated.tasks[1].state).toBe("draft");
    const deleted = applyMutation(updated, { kind: "delete-source", sourceId: "source-1" }, { ...at, eventId: "event-3" });
    expect(deleted.sources.map((s) => s.id)).toEqual(["source-2"]); expect(deleted.tasks[0].citations).toEqual([]);
  });
  it("keeps an unrelated approved task approved when another source changes", () => {
    const secondSource = source({ id: "source-2", text: "Keep this." });
    const unrelated = task({ id: "task-2", citations: [{ sourceId: "source-2", sourceRevision: 1, quote: "Keep this." }] });
    const result = applyMutation(handover({ sources: [source(), secondSource], tasks: [task(), unrelated] }), { kind: "update-source", sourceId: "source-1", source: source({ text: "ACTION: Changed." }) }, at);
    expect(result.tasks[0].state).toBe("draft");
    expect(result.tasks[1].state).toBe("approved");
  });
  it("rejects unknown/duplicate targets and source ID changes", () => {
    expect(() => applyMutation(handover(), { kind: "delete-task", taskId: "missing" }, at)).toThrow(NotFoundError);
    expect(() => applyMutation(handover(), { kind: "add-source", source: source() }, at)).toThrow(/duplicate/i);
    expect(() => applyMutation(handover(), { kind: "update-source", sourceId: "source-1", source: source({ id: "other" }) }, at)).toThrow(/ID/);
  });
  it.each([null, []])(
    "rejects malformed %j patches with ValidationError",
    (patch) => {
      expect(() =>
        applyMutation(
          handover(),
          { kind: "update-handover", patch: patch as never },
          at,
        ),
      ).toThrow(ValidationError);
      expect(() =>
        applyMutation(
          handover(),
          { kind: "update-task", taskId: "task-1", patch: patch as never },
          at,
        ),
      ).toThrow(ValidationError);
    },
  );
  it("rejects unknown patch keys while preserving an empty no-op", () => {
    const input = handover();
    const result = applyMutation(
      input,
      { kind: "update-handover", patch: {} },
      at,
    );
    expect(result).toBe(input);
    expect(result.revision).toBe(input.revision);
    expect(result.events).toEqual(input.events);
    expect(() =>
      applyMutation(
        handover(),
        { kind: "update-handover", patch: { nope: "x" } as never },
        at,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      applyMutation(
        handover(),
        { kind: "update-task", taskId: "task-1", patch: { nope: "x" } as never },
        at,
      ),
    ).toThrow(ValidationError);
  });
  it("rejects supplied nullish header values and malformed allowed task values", () => {
    for (const value of [null, undefined]) {
      expect(() => applyMutation(handover(), { kind: "update-handover", patch: { title: value } as never }, at)).toThrow(ValidationError);
      expect(() => applyMutation(handover(), { kind: "update-handover", patch: { organization: value } as never }, at)).toThrow(ValidationError);
    }
    for (const patch of [{ owner: 42 }, { dueDate: "not-a-date" }, { citations: null }])
      expect(() => applyMutation(handover(), { kind: "update-task", taskId: "task-1", patch: patch as never }, at)).toThrow(ValidationError);
  });
  it("requires draft unreviewed new tasks, resets edits, and reviews all citations", () => {
    expect(() => applyMutation(handover(), { kind: "add-task", task: task() }, at)).toThrow(/draft/i);
    const edited = applyMutation(handover(), { kind: "update-task", taskId: "task-1", patch: { title: "Changed" } }, at);
    expect(edited.tasks[0]).toMatchObject({ title: "Changed", state: "draft", reviewedAt: null });
    const invalid = task({ state: "draft", reviewedAt: null, citations: [{ sourceId: "source-1", sourceRevision: 1, quote: "Return the laptop." }, { sourceId: "source-1", sourceRevision: 1, quote: "missing" }] });
    expect(() => applyMutation(handover({ tasks: [invalid] }), { kind: "review-task", taskId: "task-1", decision: "approved" }, at)).toThrow();
  });
  it("rejects every missing source and task target", () => {
    expect(() => applyMutation(handover(), { kind: "update-source", sourceId: "missing", source: source({ id: "missing" }) }, at)).toThrow(NotFoundError);
    expect(() => applyMutation(handover(), { kind: "delete-source", sourceId: "missing" }, at)).toThrow(NotFoundError);
    for (const command of [
      { kind: "update-task", taskId: "missing", patch: { title: "x" } },
      { kind: "review-task", taskId: "missing", decision: "rejected" },
      { kind: "delete-task", taskId: "missing" },
    ] as never[])
      expect(() => applyMutation(handover(), command, at)).toThrow(NotFoundError);
  });
  it("rejects normal duplicate task IDs and source revision overflow", () => {
    const draft = task({ state: "draft", reviewedAt: null });
    expect(() => applyMutation(handover({ tasks: [draft] }), { kind: "add-task", task: draft }, at)).toThrow(/duplicate/i);
    expect(() =>
      applyMutation(
        handover({
          sources: [source({ revision: Number.MAX_SAFE_INTEGER })],
          tasks: [],
        }),
        {
          kind: "update-source",
          sourceId: "source-1",
          source: source({ title: "changed" }),
        },
        at,
      ),
    ).toThrow(/revision overflow/);
  });
  it("accepts a deterministic suggestion ID idempotently after it was edited", () => {
    const accepted = task({ id: "suggestion:[\"source-1\",1,0]", provenance: "deterministic-suggestion", state: "approved" });
    const input = handover({ tasks: [accepted] });
    const command = { ...accepted, title: "Changed by editor", state: "draft" as const, reviewedAt: null };
    expect(applyMutation(input, { kind: "add-task", task: command }, at)).toBe(input);
  });
  it("allows missing owner/date on approval and records review timestamp", () => {
    const draft = task({ state: "draft", reviewedAt: null, owner: "", dueDate: null });
    const result = applyMutation(handover({ tasks: [draft] }), { kind: "review-task", taskId: "task-1", decision: "approved" }, at);
    expect(result.tasks[0]).toMatchObject({ state: "approved", reviewedAt: at.at, owner: "", dueDate: null });
  });
  it("cleans targeted task only and catches duplicate events/revision overflow", () => {
    const two = handover({ tasks: [task(), task({ id: "task-2" })] });
    const result = applyMutation(two, { kind: "delete-task", taskId: "task-1" }, at);
    expect(result.tasks.map((t) => t.id)).toEqual(["task-2"]);
    expect(() => applyMutation(handover(), { kind: "update-handover", patch: { title: "x" } }, { ...at, eventId: "old" })).not.toThrow();
    expect(() => applyMutation(handover({ events: [{ id: "event-1", at: NOW, kind: "edited", detail: "" }] }), { kind: "update-handover", patch: { title: "x" } }, at)).toThrow(/duplicate/i);
    expect(() => applyMutation(handover({ revision: Number.MAX_SAFE_INTEGER }), { kind: "update-handover", patch: { title: "x" } }, at)).toThrow(ValidationError);
  });
});
