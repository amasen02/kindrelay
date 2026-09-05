import { useEffect, useState } from "react";
import type {
  Citation,
  CreateTaskInput,
  Handover,
  Task,
} from "../domain/types";
import type { Repository } from "../storage/indexeddb-repository";

type Props = {
  handover: Handover;
  repository: Repository;
  commit(operation: () => Promise<Handover>, success: string): Promise<boolean>;
  reloadVersion: number;
};
const taskState = (task: Task) =>
  task.state === "draft"
    ? "Needs review"
    : task.state === "approved"
      ? "Approved"
      : "Rejected";
export function TaskEditor({
  handover,
  repository,
  commit,
  reloadVersion,
}: Props) {
  const [taskTitle, setTaskTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [citationSource, setCitationSource] = useState("");
  const [citationQuote, setCitationQuote] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const reset = () => {
    setTaskTitle("");
    setOwner("");
    setDueDate("");
    setCitations([]);
    setCitationSource("");
    setCitationQuote("");
    setEditing(null);
  };
  useEffect(() => {
    if (reloadVersion > 0) reset();
  }, [reloadVersion]);
  const addCitation = () => {
    const source = handover.sources.find((item) => item.id === citationSource);
    if (!source || citationQuote.trim() === "") return;
    setCitations((current) => [
      ...current,
      {
        sourceId: source.id,
        sourceRevision: source.revision,
        quote: citationQuote,
      },
    ]);
    setCitationQuote("");
  };
  const updateCitation = (index: number) => {
    const source = handover.sources.find((item) => item.id === citationSource);
    if (!source) return;
    setCitations((current) =>
      current.map((citation, itemIndex) =>
        itemIndex === index
          ? {
              sourceId: source.id,
              sourceRevision: source.revision,
              quote: citationQuote || citation.quote,
            }
          : citation,
      ),
    );
  };
  const startEdit = (task: Task) => {
    setEditing(task);
    setTaskTitle(task.title);
    setOwner(task.owner ?? "");
    setDueDate(task.dueDate ?? "");
    setCitations(task.citations);
    setCitationSource(task.citations[0]?.sourceId ?? "");
    setCitationQuote(task.citations[0]?.quote ?? "");
  };
  const save = async () => {
    if (!editing && citations.length === 0) return;
    const input: CreateTaskInput = {
      title: taskTitle,
      owner: owner || null,
      dueDate: dueDate || null,
      citations,
    };
    const saved = await commit(
      () =>
        editing
          ? repository.updateTask(
              handover.id,
              editing.id,
              handover.revision,
              input,
            )
          : repository.addTask(handover.id, handover.revision, input),
      editing ? "Task saved" : "Task added",
    );
    if (saved) reset();
  };
  const removeTask = async (task: Task) => {
    if (!window.confirm(`Delete task ${task.title}?`)) return;
    const saved = await commit(
      () => repository.deleteTask(handover.id, task.id, handover.revision),
      "Task deleted",
    );
    if (saved && editing?.id === task.id) reset();
  };
  const citationStatus = (citation: Citation) => {
    const source = handover.sources.find(
      (item) => item.id === citation.sourceId,
    );
    return source &&
      source.revision === citation.sourceRevision &&
      source.text.includes(citation.quote)
      ? "Current citation"
      : "Stale citation";
  };
  const chooseCitationSource = (sourceId: string) =>
    setCitationSource(sourceId);
  const changeCitationQuote = (quote: string) => setCitationQuote(quote);
  return (
    <section aria-labelledby="tasks">
      <h2 id="tasks">Tasks</h2>
      <label>
        Task title
        <input
          value={taskTitle}
          onChange={(event) => setTaskTitle(event.target.value)}
        />
      </label>
      <label>
        Owner
        <input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
        />
      </label>
      <label>
        Due date
        <input
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
        />
      </label>
      <label>
        Citation source
        <select
          value={citationSource}
          onChange={(event) => chooseCitationSource(event.target.value)}
        >
          <option value="">Choose source</option>
          {handover.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Citation quote
        <input
          value={citationQuote}
          onChange={(event) => changeCitationQuote(event.target.value)}
        />
      </label>
      <button onClick={addCitation}>Add citation</button>
      {!editing && citations.length === 0 && (
        <p>Manual tasks require at least one user-chosen citation.</p>
      )}
      <ul>
        {citations.map((citation, index) => (
          <li key={`${citation.sourceId}-${index}`}>
            <span>
              {citation.quote} — {citationStatus(citation)}
            </span>
            {editing && (
              <button onClick={() => updateCitation(index)}>
                Update citation {index + 1}
              </button>
            )}
            <button
              onClick={() =>
                setCitations((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              Remove citation {index + 1}
            </button>
          </li>
        ))}
      </ul>
      <button
        disabled={!editing && citations.length === 0}
        onClick={() => void save()}
      >
        {editing ? "Save task" : "Add task"}
      </button>
      {editing && <button onClick={reset}>Cancel task edit</button>}
      {handover.tasks.map((task) => (
        <article key={task.id}>
          <h3>{task.title}</h3>
          <p>{taskState(task)}</p>
          <p>
            {task.owner ?? "No owner"} · {task.dueDate ?? "No due date"}
          </p>
          <ul>
            {task.citations.map((citation, index) => (
              <li key={index}>
                {citation.quote} (revision {citation.sourceRevision}) —{" "}
                {citationStatus(citation)}
              </li>
            ))}
          </ul>
          <button onClick={() => startEdit(task)}>
            Edit task {task.title}
          </button>
          <button className="danger" onClick={() => void removeTask(task)}>
            Delete task {task.title}
          </button>
        </article>
      ))}
    </section>
  );
}
