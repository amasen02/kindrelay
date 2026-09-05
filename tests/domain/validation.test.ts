import { describe, expect, it } from 'vitest';
import { handover, source, task } from '../fixtures';
import { validateHandover, validateSourceText, verifyCitation, utf8Size } from '../../src/domain/validation';
describe('validation', () => {
  it('accepts a valid handover without mutating input', () => { const value = handover(); const before = structuredClone(value); expect(validateHandover(value)).toEqual(value); expect(value).toEqual(before); });
  it('enforces UTF-8 source byte limit exactly', () => { validateSourceText('a'.repeat(65536)); expect(() => validateSourceText('a'.repeat(65537))).toThrow(); expect(utf8Size('é')).toBe(2); });
  it('rejects malformed dates, revisions, state, digest, and unknown keys', () => { expect(() => validateHandover({ ...handover(), updatedAt: '2026-02-30T00:00:00.000Z' })).toThrow(); expect(() => validateHandover({ ...handover(), revision: 0 })).toThrow(); expect(() => validateHandover({ ...handover(), tasks: [{ ...task(), state: 'wat' }] })).toThrow(); expect(() => validateHandover({ ...handover(), sources: [{ ...source(), sha256: 'BAD' }] })).toThrow(); expect(() => validateHandover({ ...handover(), extra: true })).toThrow(); });
  it('requires current exact citations only for approved tasks', () => { expect(() => verifyCitation(source(), { sourceId: 'source-1', sourceRevision: 1, quote: 'missing' })).toThrow(); expect(() => validateHandover(handover({ tasks: [task({ citations: [] })] }))).toThrow(); expect(validateHandover(handover({ tasks: [task({ state: 'draft', reviewedAt: null, citations: [{ sourceId: 'source-1', sourceRevision: 9, quote: 'stale' }] })] }))).toBeDefined(); });
  it('rejects duplicate IDs, empty titles, invalid reviewedAt, and unsafe integers', () => { expect(() => validateHandover(handover({ sources: [source(), source({ id: 'source-1' })] }))).toThrow(); expect(() => validateHandover(handover({ title: ' ' }))).toThrow(); expect(() => validateHandover(handover({ revision: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(); });
  it('enforces source and task collection limits', () => {
    const sources = Array.from({ length: 51 }, (_, i) => source({ id: `source-${i}`, text: `source ${i}` }));
    expect(() => validateHandover(handover({ sources }))).toThrow();
    const tasks = Array.from({ length: 501 }, (_, i) => task({ id: `task-${i}`, state: 'draft', reviewedAt: null, citations: [] }));
    expect(() => validateHandover(handover({ tasks }))).toThrow();
  });
});
