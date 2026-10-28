import User, { IUser } from '../models/User';
import JobDescription, { IJobDescription, contentSnapshot } from '../models/JobDescription';
import { agentFire } from './agentClient';

/** Mongo filter for the JDs a user may see (HR: all; employee: own, direct reports', mentioned). */
export async function jdScopeFilter(me: IUser): Promise<Record<string, unknown>> {
  if (me.role === 'hr') return {};
  const subordinates = await User.find({ reportsTo: me._id }).select('_id');
  const subIds = subordinates.map((s) => s._id);
  return { $or: [{ createdBy: me._id }, { createdBy: { $in: subIds } }, { 'peerApprovals.user': me._id }] };
}

/** id of a ref that may or may not be populated */
export const idOf = (v: any): string => (v && typeof v === 'object' && v._id ? v._id.toString() : String(v));

export async function canView(me: IUser, jd: IJobDescription): Promise<boolean> {
  if (me.role === 'hr') return true;
  const myId = me._id.toString();
  if (idOf(jd.createdBy) === myId) return true;
  if (jd.peerApprovals.some((p) => idOf(p.user) === myId)) return true;
  const author = await User.findById(idOf(jd.createdBy)).select('reportsTo');
  return author?.reportsTo?.toString() === myId;
}

/** Push the JD's current content + discussion into the agent's knowledge base (async). */
export function syncJdToIndex(jd: IJobDescription) {
  const doc = {
    _id: jd._id.toString(),
    ...contentSnapshot(jd),
    status: jd.status,
    createdBy: jd.createdBy.toString(),
    history: jd.history.map((h) => ({ action: h.action, comment: h.comment, at: h.at })),
    peerApprovals: jd.peerApprovals.map((p) => ({ status: p.status, comment: p.comment })),
  };
  agentFire('POST', '/index/jd', { jd: doc });
}

export function lastRejectionComment(jd: IJobDescription): string | null {
  for (let i = jd.history.length - 1; i >= 0; i--) {
    if (jd.history[i].action === 'rejected') return jd.history[i].comment || '';
    if (['submitted', 'resubmitted'].includes(jd.history[i].action)) break;
  }
  return null;
}

export function lastSubmittedVersion(jd: IJobDescription, before = jd.versions.length) {
  for (let i = Math.min(before, jd.versions.length) - 1; i >= 0; i--) {
    if (jd.versions[i].origin === 'submission') return jd.versions[i];
  }
  return null;
}

export { JobDescription };
