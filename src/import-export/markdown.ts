import type { ExportPacket } from "../domain/types";

const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/([\\`*_{}\[\]()#+\-.!>~|:/])/g, "\\$1");

const optional = (value: string | null, fallback: string) =>
  value === null ? fallback : escape(value);

export function renderMarkdown(packet: ExportPacket): string {
  const lines = [
    "# KindRelay approved handover",
    "",
    escape(packet.warning),
    "",
  ];
  for (const task of packet.tasks) {
    lines.push(`## ${escape(task.title)}`);
    lines.push(`Task ID: ${escape(task.id)}`);
    lines.push(`State: ${escape(task.state)}`);
    lines.push(`Owner: ${optional(task.owner, "Not assigned")}`);
    lines.push(`Due date: ${optional(task.dueDate, "No due date")}`);
    lines.push(`Provenance: ${escape(task.provenance)}`);
    lines.push(`Reviewed: ${escape(task.reviewedAt ?? "Not reviewed")}`);
    lines.push("Citations:");
    for (const citation of task.citations) {
      const source = packet.sources.find((item) => item.id === citation.sourceId)!;
      lines.push(`- Quote: ${escape(citation.quote)}`);
      lines.push(`  Source: ${escape(source.title)}`);
      lines.push(`  Source ID: ${escape(source.id)}`);
      lines.push(`  Source revision: ${source.revision}`);
      lines.push(`  Source SHA-256: ${source.sha256}`);
      lines.push(`  Excerpt SHA-256: ${citation.excerptSha256}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
