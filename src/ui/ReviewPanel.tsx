import { useEffect, useMemo, useState } from "react";
import type { Handover } from "../domain/types";
import { sha256Utf8 } from "../domain/hash";
import type { AppServices } from "./types";

type Props = {
  handover: Handover;
  services: AppServices;
  pending: boolean;
  commit(operation: () => Promise<Handover>, success: string): Promise<boolean>;
  onReturnToEditor(): void;
};

const sensitivity = (
  <p>
    Local browser storage is not encrypted. This app cannot guarantee pasted notes contain no secrets. Inspect every shared field before acting.
  </p>
);

export function ReviewPanel({ handover, services, pending, commit, onReturnToEditor }: Props) {
  const [taskId, setTaskId] = useState(handover.tasks[0]?.id ?? "");
  const [acknowledged, setAcknowledged] = useState(false);
  const [excerptHashes, setExcerptHashes] = useState<Record<string, string>>({});
  const task = handover.tasks.find((item) => item.id === taskId) ?? handover.tasks[0];
  const gaps = useMemo(() => services.gaps.scan(handover), [handover, services]);
  const invalidCitation = task && gaps.some((gap) => gap.taskId === task.id && gap.kind === "missing-citation");

  useEffect(() => {
    setAcknowledged(false);
    if (!handover.tasks.some((item) => item.id === taskId)) setTaskId(handover.tasks[0]?.id ?? "");
  }, [handover.revision, taskId, handover.tasks]);
  useEffect(() => {
    void Promise.all(task?.citations.map(async (citation) => [citation.quote, await sha256Utf8(citation.quote)] as const) ?? [])
      .then((items) => setExcerptHashes(Object.fromEntries(items)));
  }, [task]);

  if (!task) return null;
  const decide = (decision: "approved" | "rejected") =>
    void commit(
      () => services.repository.reviewTask(handover.id, task.id, handover.revision, decision),
      decision === "approved" ? "Task approved" : "Task rejected",
    ).then(() => setAcknowledged(false));

  return (
    <section aria-labelledby="review-tasks">
      <h2 id="review-tasks">Review tasks</h2>
      {sensitivity}
      <label>
        Task to review
        <select value={task.id} disabled={pending} onChange={(event) => setTaskId(event.target.value)}>
          {handover.tasks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      <article>
        <h3>{task.title}</h3>
        <dl>
          <dt>Task ID</dt><dd>{task.id}</dd>
          <dt>Owner</dt><dd>{task.owner || "No owner"}</dd>
          <dt>Due date</dt><dd>{task.dueDate || "No due date"}</dd>
          <dt>State</dt><dd>{task.state}</dd>
          <dt>Provenance</dt><dd>{task.provenance}</dd>
          <dt>Review time</dt><dd>{task.reviewedAt || "Not reviewed"}</dd>
        </dl>
        {task.citations.map((citation) => {
          const source = handover.sources.find((item) => item.id === citation.sourceId);
          return <dl key={`${citation.sourceId}-${citation.quote}`}>
            <dt>Exact quote</dt><dd>{citation.quote}</dd>
            <dt>Source ID</dt><dd>{citation.sourceId}</dd>
            <dt>Source title</dt><dd>{source?.title ?? "Missing source"}</dd>
            <dt>Source revision</dt><dd>{citation.sourceRevision}</dd>
            <dt>Full-source hash</dt><dd>{source?.sha256 ?? "Missing source digest"}</dd>
            <dt>Excerpt hash</dt><dd>{excerptHashes[citation.quote] ?? "Calculating excerpt digest…"}</dd>
          </dl>;
        })}
        <p>
          The full-source hash is provenance metadata, not proof of excerpt authenticity. The excerpt hash covers this quote only.
        </p>
        {invalidCitation && <><p>Citation no longer matches the current source.</p><button disabled={pending} onClick={onReturnToEditor}>Return to editor</button></>}
      </article>
      <ul>{gaps.filter((gap) => gap.taskId === task.id).map((gap) => <li key={gap.kind}>Gap: {gap.kind.replace("-", " ")} — {gap.message}</li>)}</ul>
      <label><input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => setAcknowledged(event.target.checked)} /> I acknowledge the sensitive information notice.</label>
      <button disabled={pending || !acknowledged || Boolean(invalidCitation)} onClick={() => decide("approved")}>Approve {task.title}</button>
      <button disabled={pending} onClick={() => decide("rejected")}>Reject {task.title}</button>
    </section>
  );
}
