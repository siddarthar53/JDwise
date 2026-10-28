/**
 * The JD approval state machine — the single source of truth for status
 * transitions. Route handlers call `transition()` and never assign `status`
 * directly. The AI layer has no path into this module: it can only propose
 * content; humans drive every transition.
 *
 *   draft ──submit──▶ pending_manager ──approve──▶ pending_hr ──approve──▶ approved
 *     ▲                     │                           │
 *     │                     └──reject──▶ rejected ◀─────┘
 *     └────────(edit)──────────────────────┘ (rejected JDs can be edited and resubmitted)
 *   (no manager) draft ──submit──▶ pending_hr
 */
import type { JDStatus } from '../models/JobDescription';

export type Action = 'submit' | 'approve' | 'reject';

export interface Actor {
  id: string;
  role: 'hr' | 'employee';
}

export interface TransitionContext {
  status: JDStatus;
  authorId: string;
  authorManagerId: string | null;
  actor: Actor;
}

export type TransitionResult =
  | { ok: true; next: JDStatus; historyAction: string; notify: 'manager' | 'hr' | 'author' }
  | { ok: false; code: 400 | 403; message: string };

export const EDITABLE_STATUSES: JDStatus[] = ['draft', 'rejected'];

export function canEdit(status: JDStatus, actorId: string, authorId: string): boolean {
  return actorId === authorId && EDITABLE_STATUSES.includes(status);
}

export function transition(action: Action, ctx: TransitionContext): TransitionResult {
  const { status, authorId, authorManagerId, actor } = ctx;

  if (action === 'submit') {
    if (actor.id !== authorId) return { ok: false, code: 403, message: 'Not your job description' };
    if (!EDITABLE_STATUSES.includes(status)) {
      return { ok: false, code: 400, message: `Cannot submit a JD with status "${status}"` };
    }
    if (authorManagerId) {
      return { ok: true, next: 'pending_manager', historyAction: status === 'rejected' ? 'resubmitted' : 'submitted', notify: 'manager' };
    }
    return { ok: true, next: 'pending_hr', historyAction: status === 'rejected' ? 'resubmitted' : 'submitted', notify: 'hr' };
  }

  if (action === 'approve' || action === 'reject') {
    if (status === 'pending_manager') {
      if (!authorManagerId || authorManagerId !== actor.id) {
        return { ok: false, code: 403, message: "Only this employee's manager can act at this stage" };
      }
      return action === 'approve'
        ? { ok: true, next: 'pending_hr', historyAction: 'manager_approved', notify: 'hr' }
        : { ok: true, next: 'rejected', historyAction: 'rejected', notify: 'author' };
    }
    if (status === 'pending_hr') {
      if (actor.role !== 'hr') return { ok: false, code: 403, message: 'Only HR can act at this stage' };
      return action === 'approve'
        ? { ok: true, next: 'approved', historyAction: 'hr_approved', notify: 'author' }
        : { ok: true, next: 'rejected', historyAction: 'rejected', notify: 'author' };
    }
    return { ok: false, code: 400, message: `Cannot ${action} a JD with status "${status}"` };
  }

  return { ok: false, code: 400, message: 'Unknown action' };
}

/** Who must act next (for copilot access and stuck-JD reminders). */
export function currentApproverKind(status: JDStatus): 'manager' | 'hr' | null {
  if (status === 'pending_manager') return 'manager';
  if (status === 'pending_hr') return 'hr';
  return null;
}
