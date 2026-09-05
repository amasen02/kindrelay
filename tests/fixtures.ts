import { createHash } from 'node:crypto';
import type { Handover, Source, Task } from '../src/domain/types';
export const NOW = '2026-09-05T00:00:00.000Z';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function source(overrides: Partial<Source> = {}): Source { const text = overrides.text ?? 'ACTION: Return the laptop.'; return { id: 'source-1', title: 'Notes', text, sha256: digest(text), revision: 1, ...overrides }; }
export function task(overrides: Partial<Task> = {}): Task { return { id: 'task-1', title: 'Return laptop', owner: 'Alex', dueDate: '2026-09-06', state: 'approved', citations: [{ sourceId: 'source-1', sourceRevision: 1, quote: 'Return the laptop.' }], reviewedAt: NOW, provenance: 'manual', ...overrides }; }
export function handover(overrides: Partial<Handover> = {}): Handover { return { id: 'handover-1', title: 'Volunteer handover', organization: 'Kind Org', createdAt: NOW, updatedAt: NOW, sources: [source()], tasks: [task()], events: [], revision: 1, ...overrides }; }
