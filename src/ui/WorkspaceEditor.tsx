import { useEffect, useMemo, useRef, useState } from "react";
import type { Handover } from "../domain/types";
import { RevisionConflictError } from "../domain/errors";
import type { AppServices } from "./types";
import { SourceEditor } from "./SourceEditor";
import { TaskEditor } from "./TaskEditor";
import { ReviewPanel } from "./ReviewPanel";
import { TransferPanel } from "./TransferPanel";

type Props = {
  services: AppServices;
  handover: Handover;
  onChange(next: Handover): void;
  onBack(): void;
};
const failureMessage = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "Storage failed; your edits are still in the form.";

export function WorkspaceEditor({
  services,
  handover,
  onChange,
  onBack,
}: Props) {
  const workspaceHeading = useRef<HTMLHeadingElement>(null);
  const [title, setTitle] = useState(handover.title);
  const [organization, setOrganization] = useState(handover.organization);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  useEffect(() => { workspaceHeading.current?.focus(); }, [handover.id]);
  const suggestions = useMemo(
    () =>
      handover.sources
        .flatMap((source) => services.suggestions.suggest(source))
        .filter((item) => !handover.tasks.some((task) => task.id === item.id)),
    [handover, services],
  );

  const commit = async (
    operation: () => Promise<Handover>,
    success: string,
  ) => {
    if (pending) return false;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const saved = await operation();
      onChange(saved);
      setNotice(success);
      setConflict(false);
      return true;
    } catch (reason) {
      setError(failureMessage(reason));
      setConflict(reason instanceof RevisionConflictError);
      return false;
    } finally {
      setPending(false);
    }
  };
  const runBusy = async <T,>(operation: () => Promise<T>): Promise<T> => {
    setPending(true);
    try {
      return await operation();
    } finally {
      setPending(false);
    }
  };
  const reload = async () => {
    if (
      !window.confirm(
        "Discard all unsaved form edits and reload saved workspace?",
      )
    )
      return;
    setPending(true);
    try {
      const fresh = await services.repository.getHandover(handover.id);
      if (!fresh) throw new Error("Workspace was not found.");
      setTitle(fresh.title);
      setOrganization(fresh.organization);
      setReloadVersion((version) => version + 1);
      onChange(fresh);
      setConflict(false);
      setError("");
      setNotice("Reloaded saved workspace.");
    } catch (reason) {
      setError(failureMessage(reason));
    } finally {
      setPending(false);
    }
  };
  const deleteWorkspace = async () => {
    if (!window.confirm(`Delete workspace ${handover.title}?`)) return;
    setPending(true);
    setError("");
    try {
      await services.repository.deleteHandover(handover.id, handover.revision);
      onBack();
    } catch (reason) {
      setError(failureMessage(reason));
      setConflict(reason instanceof RevisionConflictError);
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="app-shell workspace-editor">
      <header className="app-header">
        <button disabled={pending} onClick={onBack}>
          Back to workspaces
        </button>
        <div>
          <h1 ref={workspaceHeading} tabIndex={-1}>{handover.title}</h1>
          <p>Local browser storage is not encrypted.</p>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {conflict && (
        <button disabled={pending} onClick={() => void reload()}>
          Reload saved workspace
        </button>
      )}
      <fieldset disabled={pending}>
        <section aria-labelledby="workspace-details">
          <h2 id="workspace-details">Workspace details</h2>
          <label>
            Workspace title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Organization
            <input
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
            />
          </label>
          <button
            onClick={() =>
              void commit(
                () =>
                  services.repository.updateHandover(
                    handover.id,
                    handover.revision,
                    { title, organization },
                  ),
                "Workspace details saved",
              )
            }
          >
            Save workspace details
          </button>
          <button className="danger" onClick={() => void deleteWorkspace()}>
            Delete workspace
          </button>
        </section>
        <SourceEditor
          handover={handover}
          repository={services.repository}
          commit={commit}
          reloadVersion={reloadVersion}
        />
        <TaskEditor
          handover={handover}
          repository={services.repository}
          commit={commit}
          reloadVersion={reloadVersion}
        />
      </fieldset>
      <section aria-labelledby="draft-suggestions">
        <h2 id="draft-suggestions">Draft suggestions</h2>
        {suggestions.length === 0 && (
          <p>No unaccepted source-derived suggestions.</p>
        )}
        {suggestions.map((item) => (
          <article key={item.id}>
            <p>{item.title}</p>
            <p>Draft suggestion</p>
            <button
              disabled={pending}
              onClick={() =>
                void commit(
                  () =>
                    services.repository.addTask(
                      handover.id,
                      handover.revision,
                      {
                        title: item.title,
                        owner: item.owner,
                        dueDate: item.dueDate,
                        citations: item.citations,
                        provenance: item.provenance,
                      },
                    ),
                  "Suggestion accepted",
                )
              }
            >
              Accept suggestion
            </button>
          </article>
        ))}
      </section>
      <section aria-labelledby="gaps">
        <h2 id="gaps">Gaps</h2>
        <ul>
          {services.gaps.scan(handover).map((gap, index) => (
            <li key={`${gap.kind}-${index}`}>
              Gap: {gap.kind.replace("missing-", "missing ")} — {gap.message}
            </li>
          ))}
        </ul>
      </section>
      <ReviewPanel
        handover={handover}
        services={services}
        pending={pending}
        commit={commit}
        onReturnToEditor={() => document.getElementById("tasks")?.focus()}
      />
      <TransferPanel
        handover={handover}
        services={services}
        pending={pending}
        commit={commit}
        runBusy={runBusy}
      />
    </main>
  );
}
