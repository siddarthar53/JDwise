import { describe, it, expect } from 'vitest';
import { changeRatio, wordEditDistance } from '../src/utils/textMetrics';
import { ProposalFields } from '../src/utils/aiApply';
import { QUERIES } from '../src/analytics/queries';

describe('edit metrics', () => {
  it('word edit distance', () => {
    expect(wordEditDistance('a b c', 'a b c')).toBe(0);
    expect(wordEditDistance('a b c', 'a x c')).toBe(1);
    expect(wordEditDistance('', 'a b')).toBe(2);
  });
  it('change ratio is 0 for untouched and grows with edits', () => {
    const d = { title: 'Senior Engineer', summary: 'Build things for users', responsibilities: ['Own the API'], skills: ['Go'] };
    expect(changeRatio(d, d)).toBe(0);
    const r = changeRatio(d, { ...d, summary: 'Build reliable payment services for merchants' })!;
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe('AI proposal validation (nothing but content fields can be written)', () => {
  const ok = { title: 'Data Analyst', summary: 'x'.repeat(30), responsibilities: ['a'], qualifications: ['b'], skills: ['SQL'] };
  it('accepts a well-formed proposal', () => {
    expect(ProposalFields.safeParse(ok).success).toBe(true);
  });
  it('rejects status or other non-content keys', () => {
    expect(ProposalFields.safeParse({ ...ok, status: 'approved' }).success).toBe(false);
    expect(ProposalFields.safeParse({ ...ok, createdBy: 'x' }).success).toBe(false);
  });
  it('rejects oversized lists and wrong types', () => {
    expect(ProposalFields.safeParse({ ...ok, skills: Array(40).fill('x') }).success).toBe(false);
    expect(ProposalFields.safeParse({ ...ok, responsibilities: 'not a list' }).success).toBe(false);
  });
});

describe('analytics query catalog', () => {
  it('every query validates its params and supplies defaults', () => {
    for (const q of QUERIES) {
      expect(q.params.safeParse({}).success).toBe(true);
    }
    const stuck = QUERIES.find((q) => q.id === 'stuck_jds')!;
    expect(stuck.params.safeParse({ stage: 'drop table' }).success).toBe(false);
    expect(stuck.params.safeParse({ min_age_hours: -5 }).success).toBe(false);
  });
});
