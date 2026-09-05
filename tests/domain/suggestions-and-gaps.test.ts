import { describe, expect, it } from "vitest";
import { handover, source, task } from "../fixtures";
import { scanGaps } from "../../src/domain/gaps";
import { suggest } from "../../src/suggestions/deterministic";

describe("deterministic suggestions", () => {
  it("recognizes exact grammars after leading whitespace and ignores prose/empty forms", () => {
    const result = suggest(source({ text: " prose ACTION: no\n  ACTION: Do it.\nTODO: Ünicode\n- [ ] Tick\n action: lower\nTODO:\n- [ ]" }));
    expect(result.map((item) => item.title)).toEqual(["Do it.", "Ünicode", "Tick"]);
    expect(result.every((item) => item.owner === null && item.dueDate === null)).toBe(true);
  });
  it("uses stable collision-free physical line IDs and revision provenance", () => {
    const s = source({ id: "a", revision: 3, text: "TODO: Same\n\nTODO: Same" });
    const first = suggest(s); const second = suggest(s);
    expect(first).toEqual(second); expect(first[0].id).not.toBe(first[1].id);
    expect(first[0].citations[0]).toEqual({ sourceId: "a", sourceRevision: 3, quote: "Same" });
    expect(suggest({ ...s, revision: 4 })[0].id).not.toBe(first[0].id);
  });
});

describe("gap scanning", () => {
  it("reports four independent gaps in the required order", () => {
    const draft = task({ id: "draft", state: "draft", reviewedAt: null, owner: null, dueDate: null, citations: [] });
    expect(scanGaps(handover({ tasks: [draft] })).map((gap) => gap.kind)).toEqual(["missing-owner", "missing-date", "missing-citation", "unreviewed"]);
  });
  it("detects blank owners and stale/missing citations, but not rejected or approved review gaps", () => {
    const rejected = task({ id: "rejected", state: "rejected", owner: " ", dueDate: null, reviewedAt: "2026-09-05T00:00:00.000Z", citations: [{ sourceId: "source-1", sourceRevision: 9, quote: "stale" }] });
    const approved = task({ id: "approved", owner: "Alex", dueDate: null });
    const kinds = scanGaps(handover({ tasks: [rejected, approved] })).map((gap) => `${gap.taskId}:${gap.kind}`);
    expect(kinds).toEqual(["rejected:missing-owner", "rejected:missing-date", "rejected:missing-citation", "approved:missing-date"]);
  });
});
