import { IDBFactory } from "fake-indexeddb";
import { openRepository, type Repository } from "../../src/storage/indexeddb-repository";

let databaseSequence = 0;

export async function populatedRepository(): Promise<{
  name: string;
  factory: IDBFactory;
  repository: Repository;
  approvedTaskId: string;
  handoverId: string;
}> {
  databaseSequence += 1;
  const name = `kindrelay-codec-${databaseSequence}`;
  const factory = new IDBFactory();
  const repository = await openRepository(name, factory);
  let handover = await repository.createHandover({
    title: "Operations & <Safety>",
    organization: "Kind Org",
  });
  handover = await repository.addSource(handover.id, handover.revision, {
    title: "Shift notes",
    text: "Return the laptop. PRIVATE-MARKER-DO-NOT-SHARE",
  });
  const citedSource = handover.sources[0];
  handover = await repository.addSource(handover.id, handover.revision, {
    title: "Uncited private notes",
    text: "UNCITED-PRIVATE-MARKER",
  });
  handover = await repository.addTask(handover.id, handover.revision, {
    title: "Return *the* laptop",
    owner: "Alex",
    dueDate: "2026-09-06",
    citations: [{
      sourceId: citedSource.id,
      sourceRevision: citedSource.revision,
      quote: "Return the laptop.",
    }],
  });
  const approvedTaskId = handover.tasks.find(
    (task) => task.title === "Return *the* laptop",
  )!.id;
  handover = await repository.reviewTask(
    handover.id,
    approvedTaskId,
    handover.revision,
    "approved",
  );
  handover = await repository.addTask(handover.id, handover.revision, {
    title: "Draft private follow-up",
    citations: [],
  });
  handover = await repository.addTask(handover.id, handover.revision, {
    title: "Rejected private follow-up",
    citations: [{
      sourceId: citedSource.id,
      sourceRevision: citedSource.revision,
      quote: "Return the laptop.",
    }],
  });
  const rejectedTaskId = handover.tasks.find(
    (task) => task.title === "Rejected private follow-up",
  )!.id;
  await repository.reviewTask(
    handover.id,
    rejectedTaskId,
    handover.revision,
    "rejected",
  );

  return { name, factory, repository, approvedTaskId, handoverId: handover.id };
}

export function clonePacket<T>(packet: T): T {
  return JSON.parse(JSON.stringify(packet)) as T;
}
