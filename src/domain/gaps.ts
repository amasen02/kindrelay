import type { Gap, Handover } from "./types";
import { verifyCitation } from "./validation";

export function scanGaps(handover: Handover): ReadonlyArray<Gap> {
  const gaps: Gap[] = [];
  for (const task of handover.tasks) {
    if (task.owner === null || task.owner.trim() === "")
      gaps.push({
        kind: "missing-owner",
        taskId: task.id,
        message: "Add an owner.",
      });
    if (task.dueDate === null)
      gaps.push({ kind: "missing-date", taskId: task.id, message: "Add a due date." });
    const citationOk = task.citations.length > 0 && task.citations.every((citation) => {
      const source = handover.sources.find((candidate) => candidate.id === citation.sourceId);
      if (!source) return false;
      try {
        verifyCitation(source, citation);
        return true;
      } catch {
        return false;
      }
    });
    if (!citationOk)
      gaps.push({
        kind: "missing-citation",
        taskId: task.id,
        message: "Add a current citation.",
      });
    if (task.state === "draft")
      gaps.push({ kind: "unreviewed", taskId: task.id, message: "Review this task." });
  }
  return gaps;
}
