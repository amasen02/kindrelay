import type { Source, UnreviewedSuggestion } from "../domain/types";

export function suggest(source: Source): ReadonlyArray<UnreviewedSuggestion> {
  return source.text.split(/\r\n|\n|\r/).flatMap((line, lineIndex) => {
    const candidate = line.trimStart();
    const prefixes = ["ACTION:", "TODO:", "- [ ]"];
    const prefix = prefixes.find((value) => candidate.startsWith(value));
    if (!prefix) return [];
    const title = candidate.slice(prefix.length).trim();
    if (!title) return [];
    return [{ id: `suggestion:${JSON.stringify([source.id, source.revision, lineIndex])}`, title, owner: null, dueDate: null, citations: [{ sourceId: source.id, sourceRevision: source.revision, quote: title }], state: "draft", reviewedAt: null, provenance: "deterministic-suggestion" }];
  });
}
