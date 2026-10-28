import { describe, it, expect } from 'vitest';
import { transition, canEdit } from '../src/utils/stateMachine';

const author = 'u-author';
const manager = 'u-manager';
const hr = { id: 'u-hr', role: 'hr' as const };
const emp = (id: string) => ({ id, role: 'employee' as const });

describe('JD state machine', () => {
  it('routes submit to the manager when the author has one', () => {
    const r = transition('submit', { status: 'draft', authorId: author, authorManagerId: manager, actor: emp(author) });
    expect(r).toMatchObject({ ok: true, next: 'pending_manager', notify: 'manager', historyAction: 'submitted' });
  });

  it('skips straight to HR when the author has no manager', () => {
    const r = transition('submit', { status: 'draft', authorId: author, authorManagerId: null, actor: emp(author) });
    expect(r).toMatchObject({ ok: true, next: 'pending_hr', notify: 'hr' });
  });

  it('refuses to submit a JD that is already in review or approved (old bug)', () => {
    for (const status of ['pending_manager', 'pending_hr', 'approved'] as const) {
      const r = transition('submit', { status, authorId: author, authorManagerId: manager, actor: emp(author) });
      expect(r.ok).toBe(false);
    }
  });

  it('allows resubmission after rejection and records it', () => {
    const r = transition('submit', { status: 'rejected', authorId: author, authorManagerId: manager, actor: emp(author) });
    expect(r).toMatchObject({ ok: true, next: 'pending_manager', historyAction: 'resubmitted' });
  });

  it('only the owner can submit', () => {
    const r = transition('submit', { status: 'draft', authorId: author, authorManagerId: manager, actor: emp('someone-else') });
    expect(r).toMatchObject({ ok: false, code: 403 });
  });

  it('only the specific manager can act at pending_manager', () => {
    expect(transition('approve', { status: 'pending_manager', authorId: author, authorManagerId: manager, actor: emp('other-mgr') }).ok).toBe(false);
    expect(transition('approve', { status: 'pending_manager', authorId: author, authorManagerId: manager, actor: hr }).ok).toBe(false);
    expect(transition('approve', { status: 'pending_manager', authorId: author, authorManagerId: manager, actor: emp(manager) })).toMatchObject({ ok: true, next: 'pending_hr' });
    expect(transition('reject', { status: 'pending_manager', authorId: author, authorManagerId: manager, actor: emp(manager) })).toMatchObject({ ok: true, next: 'rejected' });
  });

  it('only HR can act at pending_hr', () => {
    expect(transition('approve', { status: 'pending_hr', authorId: author, authorManagerId: manager, actor: emp(manager) }).ok).toBe(false);
    expect(transition('approve', { status: 'pending_hr', authorId: author, authorManagerId: manager, actor: hr })).toMatchObject({ ok: true, next: 'approved' });
  });

  it('terminal and draft states cannot be approved/rejected', () => {
    for (const status of ['draft', 'approved', 'rejected'] as const) {
      expect(transition('approve', { status, authorId: author, authorManagerId: manager, actor: hr }).ok).toBe(false);
      expect(transition('reject', { status, authorId: author, authorManagerId: manager, actor: hr }).ok).toBe(false);
    }
  });

  it('editing is allowed only for the owner in draft/rejected', () => {
    expect(canEdit('draft', author, author)).toBe(true);
    expect(canEdit('rejected', author, author)).toBe(true);
    expect(canEdit('pending_hr', author, author)).toBe(false);
    expect(canEdit('draft', 'x', author)).toBe(false);
  });
});
