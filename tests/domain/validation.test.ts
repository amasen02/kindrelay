import { describe, expect, it } from "vitest";
import { handover, source, task } from "../fixtures";
import {
  canonicalHandoverJson,
  validateHandover,
  validateSourceText,
  verifyCitation,
  utf8Size,
} from "../../src/domain/validation";
describe("validation", () => {
  it("accepts a valid handover without mutating input", () => {
    const value = handover();
    const before = structuredClone(value);
    expect(validateHandover(value)).toEqual(value);
    expect(value).toEqual(before);
  });
  it("enforces UTF-8 source byte limit exactly", () => {
    validateSourceText("a".repeat(65536));
    expect(() => validateSourceText("a".repeat(65537))).toThrow();
    expect(utf8Size("é")).toBe(2);
  });
  it("rejects malformed dates, revisions, state, digest, and unknown keys", () => {
    expect(() =>
      validateHandover({
        ...handover(),
        updatedAt: "2026-02-30T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() => validateHandover({ ...handover(), revision: 0 })).toThrow();
    expect(() =>
      validateHandover({ ...handover(), tasks: [{ ...task(), state: "wat" }] }),
    ).toThrow();
    expect(() =>
      validateHandover({
        ...handover(),
        sources: [{ ...source(), sha256: "BAD" }],
      }),
    ).toThrow();
    expect(() => validateHandover({ ...handover(), extra: true })).toThrow();
  });
  it("requires current exact citations only for approved tasks", () => {
    expect(() =>
      verifyCitation(source(), {
        sourceId: "source-1",
        sourceRevision: 1,
        quote: "missing",
      }),
    ).toThrow();
    expect(() =>
      validateHandover(handover({ tasks: [task({ citations: [] })] })),
    ).toThrow();
    expect(
      validateHandover(
        handover({
          tasks: [
            task({
              state: "draft",
              reviewedAt: null,
              citations: [
                { sourceId: "source-1", sourceRevision: 9, quote: "stale" },
              ],
            }),
          ],
        }),
      ),
    ).toBeDefined();
  });
  it("rejects duplicate IDs, empty titles, invalid reviewedAt, and unsafe integers", () => {
    expect(() =>
      validateHandover(
        handover({ sources: [source(), source({ id: "source-1" })] }),
      ),
    ).toThrow();
    expect(() => validateHandover(handover({ title: " " }))).toThrow();
    expect(() =>
      validateHandover(handover({ revision: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow();
  });
  it("enforces source and task collection limits", () => {
    const sources = Array.from({ length: 51 }, (_, i) =>
      source({ id: `source-${i}`, text: `source ${i}` }),
    );
    expect(() => validateHandover(handover({ sources }))).toThrow();
    const tasks = Array.from({ length: 501 }, (_, i) =>
      task({
        id: `task-${i}`,
        state: "draft",
        reviewedAt: null,
        citations: [],
      }),
    );
    expect(() => validateHandover(handover({ tasks }))).toThrow();
  });

  it("accepts exactly 50 sources and rejects 51", () => {
    const sources = Array.from({ length: 50 }, (_, i) =>
      source({ id: `source-${i}`, text: `source ${i}` }),
    );
    const draft = task({ state: "draft", reviewedAt: null, citations: [] });
    expect(
      validateHandover(handover({ sources, tasks: [draft] })).sources,
    ).toHaveLength(50);
    expect(() =>
      validateHandover(
        handover({
          sources: [...sources, source({ id: "source-50", text: "source 50" })],
          tasks: [draft],
        }),
      ),
    ).toThrow(/50/);
  });

  it("accepts exactly 500 tasks and rejects 501", () => {
    const tasks = Array.from({ length: 500 }, (_, i) =>
      task({
        id: `task-${i}`,
        state: "draft",
        reviewedAt: null,
        citations: [],
      }),
    );
    expect(validateHandover(handover({ tasks })).tasks).toHaveLength(500);
    expect(() =>
      validateHandover(
        handover({
          tasks: [
            ...tasks,
            task({
              id: "task-500",
              state: "draft",
              reviewedAt: null,
              citations: [],
            }),
          ],
        }),
      ),
    ).toThrow(/500/);
  });

  it("enforces exact UTF-8 source bytes and accepts Unicode", () => {
    validateSourceText("é".repeat(32768));
    expect(utf8Size("é".repeat(32768))).toBe(65536);
    expect(() => validateSourceText(`é${"a".repeat(65535)}`)).toThrow(/65536/);
    expect(validateHandover(handover({ title: "Übergabe 日本語" })).title).toBe(
      "Übergabe 日本語",
    );
  });

  it("enforces the serialized handover envelope at exactly 8 MiB and plus one", () => {
    const sizeFor = (length: number) =>
      utf8Size(JSON.stringify(handover({ organization: "x".repeat(length) })));
    let low = 0;
    let high = 8388608;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (sizeFor(middle) <= 8388608) low = middle;
      else high = middle - 1;
    }
    const exact = handover({ organization: "x".repeat(low) });
    expect(utf8Size(JSON.stringify(exact))).toBe(8388608);
    expect(validateHandover(exact)).toBeDefined();
    expect(() =>
      validateHandover(handover({ organization: `${"x".repeat(low)}x` })),
    ).toThrow(/8 MiB/);
  });

  it.each([
    ["root null", null],
    ["root array", []],
    ["root primitive", "handover"],
  ])("rejects %s", (_name, value) => {
    expect(() => validateHandover(value)).toThrow();
  });

  it("rejects null, arrays, and unknown keys at nested levels", () => {
    const validEvent = {
      id: "event-1",
      at: "2026-09-05T00:00:00.000Z",
      kind: "created" as const,
      detail: "created",
    };
    expect(() => validateHandover({ ...handover(), sources: null })).toThrow();
    expect(() => validateHandover({ ...handover(), tasks: {} })).toThrow();
    expect(() =>
      validateHandover({
        ...handover(),
        events: [{ ...validEvent, extra: true }],
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateHandover({
        ...handover(),
        sources: [{ ...source(), extra: true }],
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateHandover({ ...handover(), tasks: [{ ...task(), extra: true }] }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateHandover({ ...handover(), tasks: [{ ...task(), owner: [] }] }),
    ).toThrow();
    expect(() =>
      validateHandover({
        ...handover(),
        tasks: [
          {
            ...task(),
            citations: [
              {
                sourceId: "source-1",
                sourceRevision: 1,
                quote: "Return the laptop.",
                extra: true,
              },
            ],
          },
        ],
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateHandover({
        ...handover(),
        tasks: [{ ...task(), citations: [null] }],
      }),
    ).toThrow();
  });

  it("validates real leap days, date-only values, UTC timestamps, and year 0001", () => {
    expect(
      validateHandover(handover({ tasks: [task({ dueDate: "2024-02-29" })] })),
    ).toBeDefined();
    expect(
      validateHandover(handover({ tasks: [task({ dueDate: "0001-01-01" })] })),
    ).toBeDefined();
    for (const dueDate of [
      "2023-02-29",
      "2026-02-30",
      "2026-1-01",
      "2026-09-05T00:00:00.000Z",
    ])
      expect(() =>
        validateHandover(handover({ tasks: [task({ dueDate })] })),
      ).toThrow();
    for (const timestamp of [
      "2026-09-05Z",
      "2026-09-05T00:00:00Z",
      "2026-02-30T00:00:00.000Z",
      "2026-09-05T00:00:00.000+00:00",
    ])
      expect(() =>
        validateHandover(handover({ updatedAt: timestamp })),
      ).toThrow();
  });

  it("rejects zero, negative, unsafe, and nested revisions", () => {
    for (const value of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateHandover(handover({ revision: value }))).toThrow();
      expect(() =>
        validateHandover(handover({ sources: [source({ revision: value })] })),
      ).toThrow();
      expect(() =>
        validateHandover(
          handover({
            tasks: [
              task({
                citations: [
                  {
                    sourceId: "source-1",
                    sourceRevision: value,
                    quote: "Return the laptop.",
                  },
                ],
              }),
            ],
          }),
        ),
      ).toThrow();
    }
  });

  it("rejects duplicate source, task, and event IDs", () => {
    expect(() =>
      validateHandover(
        handover({
          sources: [source(), source({ id: "source-1", text: "other" })],
        }),
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateHandover(handover({ tasks: [task(), task({ id: "task-1" })] })),
    ).toThrow(/duplicate/i);
    const event = {
      id: "event-1",
      at: "2026-09-05T00:00:00.000Z",
      kind: "created" as const,
      detail: "created",
    };
    expect(() =>
      validateHandover(handover({ events: [event, event] })),
    ).toThrow(/duplicate/i);
  });

  it("rejects empty titles and invalid state, provenance, and event kind", () => {
    expect(() => validateHandover(handover({ title: "  " }))).toThrow();
    expect(() =>
      validateHandover(handover({ sources: [source({ title: "" })] })),
    ).toThrow();
    expect(() =>
      validateHandover(handover({ tasks: [task({ title: "" })] })),
    ).toThrow();
    expect(() =>
      validateHandover(
        handover({ tasks: [task({ state: "invalid" as never })] }),
      ),
    ).toThrow();
    expect(() =>
      validateHandover(
        handover({ tasks: [task({ provenance: "invalid" as never })] }),
      ),
    ).toThrow();
    expect(() =>
      validateHandover(
        handover({
          events: [
            {
              id: "e",
              at: "2026-09-05T00:00:00.000Z",
              kind: "invalid" as never,
              detail: "",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("requires approved citations all to be current exact matches", () => {
    const valid = {
      sourceId: "source-1",
      sourceRevision: 1,
      quote: "Return the laptop.",
    };
    for (const citations of [
      [],
      [{ ...valid, sourceId: "missing" }],
      [{ ...valid, sourceRevision: 2 }],
      [{ ...valid, quote: "not present" }],
      [valid, { ...valid, quote: "not present" }],
    ]) {
      expect(() =>
        validateHandover(handover({ tasks: [task({ citations })] })),
      ).toThrow();
    }
    expect(
      validateHandover(
        handover({
          tasks: [
            task({
              state: "rejected",
              reviewedAt: "2026-09-05T00:00:00.000Z",
              citations: [{ ...valid, sourceRevision: 2, quote: "stale" }],
            }),
          ],
        }),
      ),
    ).toBeDefined();
    expect(
      validateHandover(
        handover({
          tasks: [task({ state: "draft", reviewedAt: null, citations: [] })],
        }),
      ),
    ).toBeDefined();
  });

  it("enforces review timestamp consistency and preserves input through canonical projection", () => {
    expect(() =>
      validateHandover(
        handover({
          tasks: [
            task({ state: "draft", reviewedAt: "2026-09-05T00:00:00.000Z" }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      validateHandover(
        handover({ tasks: [task({ state: "rejected", reviewedAt: null })] }),
      ),
    ).toThrow();
    const value = handover();
    const before = structuredClone(value);
    const json = canonicalHandoverJson(value);
    expect(value).toEqual(before);
    expect(Object.keys(JSON.parse(json))).toEqual([
      "id",
      "title",
      "organization",
      "createdAt",
      "updatedAt",
      "sources",
      "tasks",
      "events",
      "revision",
    ]);
  });
});
