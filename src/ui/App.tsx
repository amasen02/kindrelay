import { useEffect, useState } from "react";
import type { Handover } from "../domain/types";
import { WorkspaceEditor } from "./WorkspaceEditor";
import type { AppServices } from "./types";

export type { AppServices } from "./types";

export function App({ services }: { services: AppServices }) {
  const [items, setItems] = useState<ReadonlyArray<{ id: string; title: string; organization: string }>>([]);
  const [current, setCurrent] = useState<Handover | null>(null);
  const [title, setTitle] = useState("");
  const [organization, setOrganization] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => setItems(await services.repository.listHandovers());
  useEffect(() => { void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load local workspaces.")); }, [services]);
  const create = async () => {
    setBusy(true); setError(null);
    try { const handover = await services.repository.createHandover({ title, organization }); setCurrent(handover); setTitle(""); setOrganization(""); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create workspace."); }
    finally { setBusy(false); }
  };
  const open = async (id: string) => {
    setBusy(true); setError(null);
    try { const handover = await services.repository.getHandover(id); if (!handover) throw new Error("Workspace was not found."); setCurrent(handover); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to open workspace."); }
    finally { setBusy(false); }
  };
  if (current) return <WorkspaceEditor services={services} handover={current} onChange={(next) => { setCurrent(next); void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to refresh workspaces.")); }} onBack={() => { setCurrent(null); void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to refresh workspaces.")); }} />;
  return <main className="app-shell"><header><h1>KindRelay</h1><p>Local browser storage is not encrypted.</p></header>{error && <p role="alert">{error}</p>}<section aria-labelledby="create-workspace"><h2 id="create-workspace">Create workspace</h2><label>Workspace title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Organization<input value={organization} onChange={(event) => setOrganization(event.target.value)} /></label><button disabled={busy} onClick={() => void create()}>Create workspace</button></section><section aria-labelledby="workspaces"><h2 id="workspaces">Workspaces</h2>{items.length === 0 ? <p>No workspaces yet. Create one to record sources and tasks.</p> : <ul>{items.map((item) => <li key={item.id}><button disabled={busy} onClick={() => void open(item.id)}>{item.title}</button> <span>{item.organization}</span></li>)}</ul>}</section></main>;
}
