import { describe, expect, it } from "vitest";
import {
  exportApproved,
  exportPrivateBackup,
  importPacket,
  renderPacket,
} from "../../src/import-export/codec";
import { sha256Utf8 } from "../../src/domain/hash";
import { validateHandover } from "../../src/domain/validation";
import { clonePacket, populatedRepository } from "./helpers";

async function actualShare() {
  const fixture = await populatedRepository();
  const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
  const packet = await exportApproved(handover, "json");
  return { fixture, packet: clonePacket(packet) };
}

describe("PacketCodec untrusted-packet validation", () => {
  it("rejects malformed UTF-8 and unsupported Markdown before attempting an import", async () => {
    await expect(importPacket(new Uint8Array([0xc3, 0x28]).buffer)).rejects.toThrow();
    await expect(importPacket("# not a JSON packet")).rejects.toThrow();
  });

  it("rejects one-at-a-time unknown, prototype, duplicate, reference, revision, date, state, and digest corruptions of actual share output", async () => {
    const { fixture, packet } = await actualShare();
    try {
      const cases: Array<[string, (value: any) => void]> = [
        ["root extra field", (value) => { value.action = "fetch"; }],
        ["nested extra field", (value) => { value.tasks[0].script = "alert(1)"; }],
        ["prototype key", (value) => {
          Object.defineProperty(value, "__proto__", {
            configurable: true,
            enumerable: true,
            value: { polluted: true },
          });
        }],
        ["duplicate task", (value) => { value.tasks.push(structuredClone(value.tasks[0])); }],
        ["duplicate source", (value) => { value.sources.push(structuredClone(value.sources[0])); }],
        ["missing source", (value) => { value.tasks[0].citations[0].sourceId = "missing"; }],
        ["invalid revision", (value) => { value.tasks[0].citations[0].sourceRevision = 0; }],
        ["invalid review date", (value) => { value.tasks[0].reviewedAt = "2026-02-30T00:00:00.000Z"; }],
        ["invalid state", (value) => { value.tasks[0].state = "executed"; }],
        ["wrong format", (value) => { value.format = "markdown"; }],
        ["wrong schema version", (value) => { value.schemaVersion = 2; }],
        ["missing required warning", (value) => { delete value.warning; }],
        ["wrong task array type", (value) => { value.tasks = {}; }],
        ["uppercase digest", (value) => { value.sources[0].sha256 = value.sources[0].sha256.toUpperCase(); }],
        ["tampered excerpt", (value) => { value.tasks[0].citations[0].quote = "Different quote"; }],
      ];
      for (const [label, corrupt] of cases) {
        const candidate = clonePacket(packet);
        corrupt(candidate);
        await expect(importPacket(JSON.stringify(candidate)), label).rejects.toThrow();
      }
    } finally {
      fixture.repository.close();
    }
  });

  it("rejects a tampered full-source digest in a private backup produced from a real workspace", async () => {
    const fixture = await populatedRepository();
    try {
      const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const backup = clonePacket(await exportPrivateBackup(handover));
      backup.handover.sources[0].sha256 = "0".repeat(64);

      await expect(importPacket(JSON.stringify(backup))).rejects.toThrow();
    } finally {
      fixture.repository.close();
    }
  });

  it("accepts an unverifiable share full-source hash as provenance while rejecting its tampered excerpt hash", async () => {
    const { fixture, packet } = await actualShare();
    try {
      const provenanceOnly = clonePacket(packet);
      provenanceOnly.sources[0].sha256 = "0".repeat(64);
      const imported = await importPacket(JSON.stringify(provenanceOnly));
      expect(imported.foreignSources).toEqual([
        expect.objectContaining({ originalSourceSha256: "0".repeat(64) }),
      ]);

      const tamperedExcerpt = clonePacket(provenanceOnly);
      tamperedExcerpt.tasks[0].citations[0].excerptSha256 = "0".repeat(64);
      await expect(importPacket(JSON.stringify(tamperedExcerpt))).rejects.toThrow();
    } finally {
      fixture.repository.close();
    }
  });

  it("verifies every repeated citation tuple instead of trusting the first digest", async () => {
    const { fixture, packet } = await actualShare();
    try {
      const repeated = clonePacket(packet);
      const secondTask = structuredClone(repeated.tasks[0]);
      secondTask.id = "independent-approved-task";
      secondTask.citations[0].excerptSha256 = "0".repeat(64);
      repeated.tasks.push(secondTask);

      await expect(importPacket(JSON.stringify(repeated))).rejects.toThrow(/excerpt|hash/i);
    } finally {
      fixture.repository.close();
    }
  });

  it("keeps markup and URI-looking data inert in actual rendered export instead of rejecting ordinary backup text", async () => {
    const fixture = await populatedRepository();
    try {
      let handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      handover = await fixture.repository.addSource(handover.id, handover.revision, {
        title: "<img src=x onerror=alert(1)> https://example.test/# source",
        text: "<script>alert(1)</script> https://example.test/# quote",
      });
      const maliciousSource = handover.sources.at(-1)!;
      handover = await fixture.repository.addTask(handover.id, handover.revision, {
        title: "<img src=x onerror=alert(1)> https://example.test/# task",
        citations: [{
          sourceId: maliciousSource.id,
          sourceRevision: maliciousSource.revision,
          quote: "<script>alert(1)</script> https://example.test/# quote",
        }],
      });
      const maliciousTask = handover.tasks.at(-1)!;
      handover = await fixture.repository.reviewTask(
        handover.id,
        maliciousTask.id,
        handover.revision,
        "approved",
      );
      const packet = await exportApproved(handover, "markdown", [maliciousTask.id]);
      const markdown = (await import("../../src/import-export/codec")).renderPacket(packet);

      expect(markdown).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
      expect(markdown).toContain("&lt;script&gt;alert\\(1\\)&lt;\\/script&gt;");
      expect(markdown).toContain("https\\:\\/\\/example\\.test\\/\\#");
      expect(markdown).not.toContain("<img");
      expect(markdown).not.toContain("<script");
      expect(markdown).not.toContain("[https://example.test]");
      await expect(importPacket(JSON.stringify(await exportPrivateBackup(handover)))).resolves.toMatchObject({
        handover: expect.objectContaining({
          title: "Operations & <Safety>",
          tasks: expect.arrayContaining([expect.objectContaining({ title: maliciousTask.title })]),
        }),
      });
    } finally {
      fixture.repository.close();
    }
  });
});

describe("PacketCodec limits", () => {
  it("accepts an exact 65536-byte excerpt and rejects a recomputed-digest excerpt one byte over", async () => {
    const fixture = await populatedRepository();
    try {
      let handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const exactQuote = "q".repeat(65_536);
      handover = await fixture.repository.addSource(handover.id, handover.revision, {
        title: "Exact quote limit",
        text: exactQuote,
      });
      const exactSource = handover.sources.at(-1)!;
      handover = await fixture.repository.addTask(handover.id, handover.revision, {
        title: "Exact quote task",
        citations: [{
          sourceId: exactSource.id,
          sourceRevision: exactSource.revision,
          quote: exactQuote,
        }],
      });
      const exactTask = handover.tasks.at(-1)!;
      handover = await fixture.repository.reviewTask(
        handover.id,
        exactTask.id,
        handover.revision,
        "approved",
      );
      const exactPacket = await exportApproved(handover, "json", [exactTask.id]);
      await expect(importPacket(JSON.stringify(exactPacket))).resolves.toMatchObject({
        handover: expect.objectContaining({ sources: [expect.objectContaining({ text: exactQuote })] }),
      });

      const over = clonePacket(exactPacket);
      over.tasks[0].citations[0].quote = `${exactQuote}q`;
      over.tasks[0].citations[0].excerptSha256 = await sha256Utf8(
        over.tasks[0].citations[0].quote,
      );
      await expect(importPacket(JSON.stringify(over))).rejects.toThrow(/65536|quote|limit/i);
    } finally {
      fixture.repository.close();
    }
  });

  it("enforces share JSON and rendered Markdown 1 MiB caps independently without truncation", async () => {
    const { fixture, packet } = await actualShare();
    try {
      const oneMiB = 1024 * 1024;
      const exact = clonePacket(packet);
      exact.sources[0].title += "w".repeat(
        oneMiB - new TextEncoder().encode(JSON.stringify(exact)).byteLength,
      );
      const exactImported = await importPacket(JSON.stringify(exact));
      expect(exactImported.handover.sources[0].text).toBe(
        exact.tasks[0].citations[0].quote,
      );
      expect(exactImported.handover.sources[0].title).toBe(exact.sources[0].title);
      expect(exactImported.foreignSources[0]).toMatchObject({
        originalSourceSha256: exact.sources[0].sha256,
        excerptSha256: exact.tasks[0].citations[0].excerptSha256,
      });

      const smallJson = JSON.stringify(packet);
      const rawExact = smallJson + " ".repeat(
        oneMiB - new TextEncoder().encode(smallJson).byteLength,
      );
      await expect(importPacket(rawExact)).resolves.toMatchObject({
        handover: expect.objectContaining({ sources: [expect.objectContaining({ text: packet.tasks[0].citations[0].quote })] }),
      });
      await expect(importPacket(`${rawExact} `)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/1 MiB|select fewer/i),
      });

      const over = clonePacket(exact);
      over.sources[0].title += "x";
      await expect(importPacket(JSON.stringify(over))).rejects.toThrow(/select fewer|limit|MiB/i);

      let handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const citedSource = handover.sources[0];
      handover = await fixture.repository.updateSource(handover.id, citedSource.id, handover.revision, {
        title: "<".repeat(300_000),
      });
      const updatedSource = handover.sources.find((source) => source.id === citedSource.id)!;
      handover = await fixture.repository.updateTask(
        handover.id,
        fixture.approvedTaskId,
        handover.revision,
        {
          citations: [{
            sourceId: citedSource.id,
            sourceRevision: updatedSource.revision,
            quote: "Return the laptop.",
          }],
        },
      );
      handover = await fixture.repository.reviewTask(
        handover.id,
        fixture.approvedTaskId,
        handover.revision,
        "approved",
      );
      const jsonPacket = await exportApproved(handover, "json", [fixture.approvedTaskId]);
      expect(new TextEncoder().encode(JSON.stringify(jsonPacket)).byteLength).toBeLessThan(oneMiB);
      const rendered = renderPacket({ ...jsonPacket, format: "markdown" });
      expect(new TextEncoder().encode(rendered).byteLength).toBeGreaterThan(oneMiB);
      await expect(exportApproved(handover, "markdown", [fixture.approvedTaskId])).rejects.toThrow(
        /select fewer|limit|MiB/i,
      );
    } finally {
      fixture.repository.close();
    }
  });

  it("allows exactly 50 excerpt tuples from one source and refuses the 51st without truncating", async () => {
    const fixture = await populatedRepository();
    try {
      let handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const quoteText = Array.from(
        { length: 51 },
        (_, index) => `quote-${index}`,
      ).join("\n");
      handover = await fixture.repository.addSource(handover.id, handover.revision, {
        title: "Many citations",
        text: quoteText,
      });
      const manyCitationSource = handover.sources.at(-1)!;
      const taskIds: string[] = [];
      for (let index = 0; index < 51; index += 1) {
        handover = await fixture.repository.addTask(handover.id, handover.revision, {
          title: `Approved ${index}`,
          citations: [{
            sourceId: manyCitationSource.id,
            sourceRevision: manyCitationSource.revision,
            quote: `quote-${index}`,
          }],
        });
        const task = handover.tasks.at(-1)!;
        handover = await fixture.repository.reviewTask(handover.id, task.id, handover.revision, "approved");
        taskIds.push(task.id);
      }
      const fiftyPacket = await exportApproved(handover, "json", taskIds.slice(0, 50));
      expect(fiftyPacket).toMatchObject({
        tasks: expect.arrayContaining([expect.objectContaining({ id: taskIds[49] })]),
      });
      const fiftyImported = await importPacket(JSON.stringify(fiftyPacket));
      expect(fiftyImported.handover.sources).toHaveLength(50);
      expect(fiftyImported.foreignSources).toHaveLength(50);
      expect(new Set(fiftyImported.foreignSources.map((item) => item.localSourceId)).size).toBe(50);
      expect(fiftyImported.handover.tasks.every((task) =>
        fiftyImported.handover.sources.some((source) => source.id === task.citations[0].sourceId),
      )).toBe(true);
      const hostileFiftyOne = clonePacket(fiftyPacket);
      const extraTask = structuredClone(hostileFiftyOne.tasks[0]);
      extraTask.id = "hostile-fifty-first-task";
      extraTask.citations[0].quote = "quote-50";
      extraTask.citations[0].excerptSha256 = await sha256Utf8("quote-50");
      hostileFiftyOne.tasks.push(extraTask);
      await expect(importPacket(JSON.stringify(hostileFiftyOne))).rejects.toThrow(/50|select fewer|limit/i);
      await expect(exportApproved(handover, "json", taskIds)).rejects.toThrow(/select fewer|limit/i);
    } finally {
      fixture.repository.close();
    }
  });

  it("refuses a valid under-1-MiB share when 50 imported excerpt sources would exceed the 8 MiB destination", async () => {
    const fixture = await populatedRepository();
    try {
      let handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const sourceTitle = "t".repeat(200_000);
      const quoteText = Array.from({ length: 50 }, (_, index) => `budget-${index}`).join("\n");
      handover = await fixture.repository.addSource(handover.id, handover.revision, {
        title: sourceTitle,
        text: quoteText,
      });
      const source = handover.sources.at(-1)!;
      const taskIds: string[] = [];
      for (let index = 0; index < 50; index += 1) {
        handover = await fixture.repository.addTask(handover.id, handover.revision, {
          title: `Budget task ${index}`,
          citations: [{
            sourceId: source.id,
            sourceRevision: source.revision,
            quote: `budget-${index}`,
          }],
        });
        const task = handover.tasks.at(-1)!;
        handover = await fixture.repository.reviewTask(handover.id, task.id, handover.revision, "approved");
        taskIds.push(task.id);
      }

      const smaller = await exportApproved(handover, "json", taskIds.slice(0, 4));
      expect(new TextEncoder().encode(JSON.stringify(smaller)).byteLength).toBeLessThan(1024 * 1024);
      const smallerImported = await importPacket(JSON.stringify(smaller));
      expect(smallerImported.handover.sources).toHaveLength(4);

      const wouldBeFull = clonePacket(smaller);
      wouldBeFull.tasks = await Promise.all(taskIds.map(async (taskId) => {
        const task = handover.tasks.find((candidate) => candidate.id === taskId)!;
        return {
          ...task,
          citations: await Promise.all(task.citations.map(async (citation) => ({
            ...citation,
            excerptSha256: await sha256Utf8(citation.quote),
          }))),
        };
      }));
      expect(new TextEncoder().encode(JSON.stringify(wouldBeFull)).byteLength).toBeLessThan(1024 * 1024);
      await expect(exportApproved(handover, "json", taskIds)).rejects.toThrow(
        /destination exceeds 8 MiB; select fewer/i,
      );
    } finally {
      fixture.repository.close();
    }
  });

  it("keeps equal excerpt text distinct when the original source provenance differs", async () => {
    const fixture = await populatedRepository();
    try {
      let handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      handover = await fixture.repository.addSource(handover.id, handover.revision, {
        title: "Second copy",
        text: "Return the laptop.",
      });
      const secondSource = handover.sources.at(-1)!;
      handover = await fixture.repository.addTask(handover.id, handover.revision, {
        title: "Second approved task",
        citations: [{
          sourceId: secondSource.id,
          sourceRevision: secondSource.revision,
          quote: "Return the laptop.",
        }],
      });
      const secondTask = handover.tasks.at(-1)!;
      handover = await fixture.repository.reviewTask(handover.id, secondTask.id, handover.revision, "approved");

      const packet = await exportApproved(handover, "json", [
        fixture.approvedTaskId,
        secondTask.id,
      ]);
      const imported = await importPacket(JSON.stringify(packet));
      expect(imported.handover.sources).toHaveLength(2);
      expect(imported.handover.sources.map((source) => source.text)).toEqual([
        "Return the laptop.",
        "Return the laptop.",
      ]);
      expect(new Set(imported.foreignSources.map((source) => source.originalSourceId)).size).toBe(2);
    } finally {
      fixture.repository.close();
    }
  });

  it("accepts a valid private backup at the 16 MiB raw-input boundary and rejects one byte over", async () => {
    const fixture = await populatedRepository();
    try {
      const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const backup = await exportPrivateBackup(handover);
      const json = JSON.stringify(backup);
      const rawLimit = 16 * 1024 * 1024;
      const exact = json + " ".repeat(rawLimit - new TextEncoder().encode(json).byteLength);

      await expect(importPacket(exact)).resolves.toMatchObject({
        handover: expect.objectContaining({ revision: 1 }),
      });
      await expect(importPacket(`${exact} `)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/16 MiB/i),
      });
    } finally {
      fixture.repository.close();
    }
  });

  it("rejects a valid private backup whose imported workspace crosses the 8 MiB canonical destination cap", async () => {
    const fixture = await populatedRepository();
    try {
      const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
      const backup = clonePacket(await exportPrivateBackup(handover));
      const destinationLimit = 8 * 1024 * 1024;
      const currentBytes = new TextEncoder().encode(JSON.stringify(backup.handover)).byteLength;
      backup.handover.events[0].detail += "x".repeat(destinationLimit - currentBytes - 1);

      expect(new TextEncoder().encode(JSON.stringify(backup.handover)).byteLength).toBe(destinationLimit - 1);
      expect(() => validateHandover(backup.handover)).not.toThrow();
      expect(new TextEncoder().encode(JSON.stringify(backup)).byteLength).toBeLessThan(16 * 1024 * 1024);
      await expect(importPacket(JSON.stringify(backup))).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/8 MiB|destination|workspace|limit/i),
      });
    } finally {
      fixture.repository.close();
    }
  });
});
