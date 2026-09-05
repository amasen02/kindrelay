import { afterEach, describe, expect, it } from "vitest";
import {
  exportApproved,
  exportPrivateBackup,
  importPacket,
  packetCodec,
  renderPacket,
} from "../../src/import-export/codec";
import { sha256Utf8 } from "../../src/domain/hash";
import { openRepository } from "../../src/storage/indexeddb-repository";
import { populatedRepository } from "./helpers";

const repositories: Array<{ close(): void }> = [];
afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
});

describe("PacketCodec approved exports", () => {
  it("exports only approved selected tasks and cited source metadata from a real workspace", async () => {
    const fixture = await populatedRepository();
    repositories.push(fixture.repository);
    const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
    const beforeExport = JSON.stringify(handover);

    const packet = await exportApproved(handover, "json", [fixture.approvedTaskId]);
    const serialized = JSON.stringify(packet);

    expect(packet).toMatchObject({ format: "json", schemaVersion: 1 });
    expect(packet.tasks).toHaveLength(1);
    expect(packet.tasks[0]).toMatchObject({
      id: fixture.approvedTaskId,
      state: "approved",
    });
    expect(packet.sources).toHaveLength(1);
    expect(packet.sources[0]).not.toHaveProperty("text");
    expect(packet.sources[0]).not.toHaveProperty("events");
    expect(serialized).not.toContain("PRIVATE-MARKER-DO-NOT-SHARE");
    expect(serialized).not.toContain("UNCITED-PRIVATE-MARKER");
    expect(serialized).not.toContain("Draft private follow-up");
    expect(serialized).not.toContain("Rejected private follow-up");
    expect(packet.tasks[0].citations[0].excerptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.sources[0].sha256).toBe(await sha256Utf8(handover.sources[0].text));
    expect(packet.tasks[0].citations[0].excerptSha256).toBe(
      await sha256Utf8(packet.tasks[0].citations[0].quote),
    );
    expect(JSON.parse(renderPacket(packet))).toEqual(packet);
    expect(JSON.stringify(handover)).toBe(beforeExport);
  });

  it("defaults to every approved task and refuses empty, duplicate, missing, draft, or rejected selections", async () => {
    const fixture = await populatedRepository();
    repositories.push(fixture.repository);
    const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
    const draft = handover.tasks.find((task) => task.state === "draft")!;
    const rejected = handover.tasks.find((task) => task.state === "rejected")!;

    await expect(exportApproved(handover, "json")).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: fixture.approvedTaskId })],
    });
    await expect(exportApproved(handover, "json", [])).rejects.toThrow();
    await expect(exportApproved(handover, "json", [fixture.approvedTaskId, fixture.approvedTaskId])).rejects.toThrow();
    await expect(exportApproved(handover, "json", ["missing-task"])).rejects.toThrow();
    await expect(exportApproved(handover, "json", [draft.id])).rejects.toThrow();
    await expect(exportApproved(handover, "json", [rejected.id])).rejects.toThrow();
  });

  it("renders a readable inert Markdown artifact with provenance, review, owner, and date", async () => {
    const fixture = await populatedRepository();
    repositories.push(fixture.repository);
    const handover = (await fixture.repository.getHandover(fixture.handoverId))!;
    const packet = await packetCodec.exportApproved(handover, "markdown");
    const markdown = renderPacket(packet);

    expect(markdown).toContain("Return \\*the\\* laptop");
    expect(markdown).toContain("Alex");
    expect(markdown).toContain("2026\\-09\\-06");
    expect(markdown).toContain("approved");
    expect(markdown).toContain("Shift notes");
    expect(markdown).toContain("Return the laptop\\.");
    expect(markdown).toContain(packet.sources[0].sha256);
    expect(markdown).toContain(packet.tasks[0].citations[0].excerptSha256);
    expect(markdown).not.toContain("PRIVATE-MARKER-DO-NOT-SHARE");
    expect(markdown).not.toMatch(/<[^>]+>/);
  });
});

describe("PacketCodec imports", () => {
  it("imports actual share output as fresh draft IDs, remaps sources, and persists after commit/reopen", async () => {
    const fixture = await populatedRepository();
    repositories.push(fixture.repository);
    const original = (await fixture.repository.getHandover(fixture.handoverId))!;
    const packet = await exportApproved(original, "json");
    const inputBeforeImport = JSON.stringify(packet);
    const imported = await importPacket(JSON.stringify(packet));

    expect(imported.handover.id).not.toBe(original.id);
    expect(imported.handover).toMatchObject({
      title: "Imported handover",
      organization: "Imported workspace",
      revision: 1,
    });
    expect(imported.handover.tasks).toEqual([
      expect.objectContaining({ state: "draft", reviewedAt: null, provenance: "imported" }),
    ]);
    expect(imported.handover.tasks[0].id).not.toBe(original.tasks[0].id);
    expect(imported.handover.sources[0]).toMatchObject({
      text: "Return the laptop.",
      revision: 1,
    });
    expect(imported.foreignReview).toEqual([
      expect.objectContaining({ importedState: "approved" }),
    ]);
    expect(imported.foreignSources).toEqual([
      expect.objectContaining({ originalSourceId: original.sources[0].id }),
    ]);
    expect(JSON.stringify(packet)).toBe(inputBeforeImport);

    const committed = await fixture.repository.commitImport(imported);
    fixture.repository.close();
    const reopened = await openRepository(fixture.name, fixture.factory);
    repositories.push(reopened);
    await expect(reopened.getHandover(committed.id)).resolves.toEqual(committed);
    await expect(reopened.getImportRecord(committed.id)).resolves.toMatchObject({
      foreignReview: imported.foreignReview,
      foreignSources: imported.foreignSources,
    });
  });

  it("backs up the full workspace and restores actual output with new IDs after commit/reopen", async () => {
    const fixture = await populatedRepository();
    repositories.push(fixture.repository);
    const original = (await fixture.repository.getHandover(fixture.handoverId))!;
    const backup = await exportPrivateBackup(original);
    const restored = await importPacket(JSON.stringify(backup));

    expect(backup.privateWarning).toEqual(expect.any(String));
    expect(JSON.stringify(backup)).toContain("UNCITED-PRIVATE-MARKER");
    expect(restored.handover.id).not.toBe(original.id);
    expect(restored.handover.sources.map((source) => source.id)).not.toEqual(
      original.sources.map((source) => source.id),
    );
    expect(restored.handover.sources).toHaveLength(original.sources.length);
    expect(restored.handover.tasks).toHaveLength(original.tasks.length);
    expect(restored.handover.tasks.every((task) => task.state === "draft" && task.reviewedAt === null)).toBe(true);
    expect(restored.foreignReview).toHaveLength(original.tasks.length);
    expect(restored.foreignSources).toHaveLength(original.sources.length);
    expect(restored.foreignSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originalSourceId: original.sources[1].id,
        originalSourceSha256: original.sources[1].sha256,
        excerptSha256: original.sources[1].sha256,
      }),
    ]));

    const committed = await fixture.repository.commitImport(restored);
    fixture.repository.close();
    const reopened = await openRepository(fixture.name, fixture.factory);
    repositories.push(reopened);
    await expect(reopened.getHandover(committed.id)).resolves.toEqual(committed);
  });

  it("preserves stale draft citation revisions while remapping every source and task ID in a real private restore", async () => {
    const fixture = await populatedRepository();
    repositories.push(fixture.repository);
    let original = (await fixture.repository.getHandover(fixture.handoverId))!;
    const source = original.sources[0];
    original = await fixture.repository.updateSource(original.id, source.id, original.revision, {
      text: "Replacement text that leaves the old quote stale.",
    });
    original = await fixture.repository.addTask(original.id, original.revision, {
      title: "Draft retaining an old citation revision",
      citations: [{
        sourceId: source.id,
        sourceRevision: 1,
        quote: "Return the laptop.",
      }],
    });
    const staleDraft = original.tasks.find(
      (task) => task.title === "Draft retaining an old citation revision",
    )!;
    const backup = await exportPrivateBackup(original);
    const restored = await importPacket(JSON.stringify(backup));
    const restoredSource = restored.handover.sources.find(
      (item) => item.title === source.title,
    )!;
    const restoredDraft = restored.handover.tasks.find(
      (task) => task.title === staleDraft.title,
    )!;

    expect(restoredSource).toMatchObject({ revision: 2 });
    expect(restoredSource.id).not.toBe(source.id);
    expect(restoredDraft.id).not.toBe(staleDraft.id);
    expect(restoredDraft.citations).toEqual([{
      sourceId: restoredSource.id,
      sourceRevision: 1,
      quote: "Return the laptop.",
    }]);
    expect(restored.foreignReview.map((record) => record.taskId)).toEqual(
      expect.arrayContaining(restored.handover.tasks.map((task) => task.id)),
    );
  });
});
