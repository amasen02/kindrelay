import { useEffect, useState } from "react";
import type { Handover, Source } from "../domain/types";
import type { Repository } from "../storage/indexeddb-repository";

type Props = {
  handover: Handover;
  repository: Repository;
  commit(operation: () => Promise<Handover>, success: string): Promise<boolean>;
  reloadVersion: number;
};
export function SourceEditor({
  handover,
  repository,
  commit,
  reloadVersion,
}: Props) {
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [editing, setEditing] = useState<Source | null>(null);
  const reset = () => {
    setSourceTitle("");
    setSourceText("");
    setEditing(null);
  };
  useEffect(() => {
    if (reloadVersion > 0) reset();
  }, [reloadVersion]);
  const save = async () => {
    const saved = await commit(
      () =>
        editing
          ? repository.updateSource(
              handover.id,
              editing.id,
              handover.revision,
              { title: sourceTitle, text: sourceText },
            )
          : repository.addSource(handover.id, handover.revision, {
              title: sourceTitle,
              text: sourceText,
            }),
      editing ? "Source saved; related approvals need review." : "Source added",
    );
    if (saved) reset();
  };
  const remove = async (source: Source) => {
    if (!window.confirm(`Delete source ${source.title}?`)) return;
    const saved = await commit(
      () => repository.deleteSource(handover.id, source.id, handover.revision),
      "Source deleted",
    );
    if (saved && editing?.id === source.id) reset();
  };
  return (
    <section aria-labelledby="sources">
      <h2 id="sources">Sources</h2>
      <p>
        Draft suggestions use ACTION:, TODO:, or - [ ] at the beginning of a
        line.
      </p>
      <label>
        Source title
        <input
          value={sourceTitle}
          onChange={(event) => setSourceTitle(event.target.value)}
        />
      </label>
      <label>
        Source text
        <textarea
          value={sourceText}
          onChange={(event) => setSourceText(event.target.value)}
        />
      </label>
      <button onClick={() => void save()}>
        {editing ? "Save source" : "Add source"}
      </button>
      {editing && <button onClick={reset}>Cancel source edit</button>}
      {handover.sources.map((source) => (
        <article key={source.id}>
          <h3>{source.title}</h3>
          <p>Revision {source.revision}</p>
          <pre>{source.text}</pre>
          <button
            onClick={() => {
              setEditing(source);
              setSourceTitle(source.title);
              setSourceText(source.text);
            }}
          >
            Edit source {source.title}
          </button>
          <button className="danger" onClick={() => void remove(source)}>
            Delete source {source.title}
          </button>
        </article>
      ))}
    </section>
  );
}
