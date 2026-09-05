import { useEffect, useState } from "react";
import type { Handover, ImportResult } from "../domain/types";
import type { AppServices } from "./types";

type Props = {
  handover?: Handover;
  services: AppServices;
  pending: boolean;
  commit(operation: () => Promise<Handover>, success: string): Promise<boolean>;
  runBusy<T>(operation: () => Promise<T>): Promise<T>;
};
const MAX_FILE = 16 * 1024 * 1024;
const readFile = (file: File) => new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(file); });
const download = (text: string, name: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  try {
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
};

export function TransferPanel({ handover, services, pending, commit, runBusy }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [shareAck, setShareAck] = useState(false);
  const [privateAck, setPrivateAck] = useState(false);
  const [restoreAck, setRestoreAck] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { setSelected([]); setShareAck(false); setPrivateAck(false); }, [handover?.id, handover?.revision]);
  const exportShare = async (format: "json" | "markdown") => {
    if (!handover) return; setError(""); setNotice("");
    try { const packet = await runBusy(() => services.codec.exportApproved(handover, format, selected)); const text = services.codec.renderPacket(packet); download(text, `kindrelay-approved.${format === "json" ? "json" : "md"}`, format === "json" ? "application/json" : "text/markdown"); setNotice(`${format === "json" ? "JSON" : "Markdown"} download prepared; save it securely.`); setShareAck(false); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to prepare download."); }
  };
  const backup = async () => { if (!handover) return; try { const packet = await runBusy(() => services.codec.exportPrivateBackup(handover)); download(JSON.stringify(packet), "kindrelay-private-backup.json", "application/json"); setNotice("Private backup download prepared; save it securely."); setPrivateAck(false); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to prepare backup."); } };
  const selectFile = async (file: File | undefined) => { setPreview(null); setRestoreAck(false); setError(""); if (!file) return; if (file.size > MAX_FILE) { setError("Import file exceeds 16 MiB."); return; } try { setPreview(await runBusy(async () => services.codec.importPacket(await readFile(file)))); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to read import file."); } };
  const restore = () => { if (!preview) return; void commit(() => services.repository.commitImport(preview), "Workspace restored").then((ok) => { if (ok) { setPreview(null); setRestoreAck(false); } }); };
  const approved = handover?.tasks.filter((task) => task.state === "approved") ?? [];
  return <section aria-labelledby="transfer-workspace"><h2 id="transfer-workspace">Transfer workspace</h2><p>Local browser storage is not encrypted. This app cannot guarantee notes contain no secrets; inspect every shared field.</p>{handover && <><h3>Export approved items</h3>{approved.map((task) => <label key={task.id}><input type="checkbox" checked={selected.includes(task.id)} disabled={pending} onChange={(event) => { setSelected(event.target.checked ? [...selected, task.id] : selected.filter((id) => id !== task.id)); setShareAck(false); }} /> Select {task.title}</label>)}<label><input type="checkbox" checked={shareAck} disabled={pending} onChange={(event) => setShareAck(event.target.checked)} /> I acknowledge the share sensitivity notice.</label><button disabled={pending || !shareAck || selected.length === 0} onClick={() => void exportShare("json")}>Download selected JSON</button><button disabled={pending || !shareAck || selected.length === 0} onClick={() => void exportShare("markdown")}>Download selected Markdown</button><h3>Private backup</h3><p>Private backup contains complete notes, drafts, rejected tasks and history. Use secure storage. v1 cannot preserve the earlier separate imported-provenance chain.</p><label><input type="checkbox" checked={privateAck} disabled={pending} onChange={(event) => setPrivateAck(event.target.checked)} /> I acknowledge the private backup warning.</label><button disabled={pending || !privateAck} onClick={() => void backup()}>Download private backup</button></>}<h3>Restore local JSON</h3><label>Import a local JSON file<input type="file" accept="application/json,.json" disabled={pending} onChange={(event) => void selectFile(event.target.files?.[0])} /></label>{preview && <><p>Preview: {preview.handover.title} — {preview.handover.tasks.length} task(s), {preview.handover.sources.length} source(s). Imported approvals reset to drafts; foreign review is historical.</p><label><input type="checkbox" checked={restoreAck} disabled={pending} onChange={(event) => setRestoreAck(event.target.checked)} /> I acknowledge the restore sensitivity notice.</label><button disabled={pending || !restoreAck} onClick={restore}>Restore as new workspace</button></>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>;
}
