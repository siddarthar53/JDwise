import { Router, Response } from 'express';
import JobDescription, { IJobDescription, contentSnapshot } from '../models/JobDescription';
import User from '../models/User';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { notify } from '../utils/notify';
import { AGENT_OPENER, firstPrompt, processAnswer, summarizeDraft } from '../utils/jdAgent';
import { transition, canEdit, currentApproverKind } from '../utils/stateMachine';
import { agentAvailable, agentCall, AgentError, userHash } from '../utils/agentClient';
import { applyRunResult, ProposalFields } from '../utils/aiApply';
import { getPrefsFor, learnFromApproval } from '../utils/memory';
import { canView, jdScopeFilter, lastRejectionComment, syncJdToIndex } from '../utils/jdHelpers';

const router = Router();

const EDITABLE_FIELDS = [
  'title',
  'department',
  'level',
  'employmentType',
  'location',
  'workMode',
  'summary',
  'responsibilities',
  'qualifications',
  'skills',
  'benefits',
  'salaryRange',
];

function fail(res: Response, err: any) {
  if (err instanceof AgentError) return res.status(err.status).json({ message: err.message });
  console.error(err);
  return res.status(500).json({ message: 'Something went wrong' });
}

async function loadOwned(req: AuthedRequest, res: Response): Promise<IJobDescription | null> {
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) {
    res.status(404).json({ message: 'Job description not found' });
    return null;
  }
  if (jd.createdBy.toString() !== req.userId) {
    res.status(403).json({ message: 'Not your job description' });
    return null;
  }
  return jd;
}

async function populated(id: unknown) {
  return JobDescription.findById(id)
    .populate('createdBy', 'name email department')
    .populate('peerApprovals.user', 'name email')
    .populate('history.byUser', 'name email');
}

// GET /api/jds - role-scoped list
router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const me = await User.findById(req.userId);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const jds = await JobDescription.find(await jdScopeFilter(me))
    .select('-aiRuns -versions -appliedRunIds')
    .populate('createdBy', 'name email department')
    .populate('peerApprovals.user', 'name email')
    .sort({ updatedAt: -1 });
  res.json({ jds });
});

// GET /api/jds/:id
router.get('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await populated(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  const me = await User.findById(req.userId);
  if (!me || !(await canView(me, jd))) return res.status(403).json({ message: 'Not allowed to view this JD' });
  res.json({ jd });
});

// GET /api/jds/:id/versions - content snapshots (for diff view)
router.get('/:id/versions', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await JobDescription.findById(req.params.id).select('versions createdBy peerApprovals').populate('versions.byUser', 'name');
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  const me = await User.findById(req.userId);
  if (!me || !(await canView(me, jd as any))) return res.status(403).json({ message: 'Not allowed' });
  res.json({ versions: jd.versions });
});

// POST /api/jds - create a new draft and open the assistant conversation
router.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const useAgent = await agentAvailable();
  const jd = await JobDescription.create({
    createdBy: req.userId,
    status: 'draft',
    agentState: useAgent ? 'collecting' : 'legacy',
    conversation: [{ role: 'assistant', content: useAgent ? AGENT_OPENER : firstPrompt(), kind: useAgent ? 'question' : 'legacy', at: new Date() }],
    conversationStep: 0,
    history: [{ action: 'created', byUser: req.userId, at: new Date() }],
  });
  res.status(201).json({ jd });
});

// POST /api/jds/:id/agent-message - send a message to the drafting agent
router.post('/:id/agent-message', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ message: 'Message is required' });
    if (String(message).length > 20000) return res.status(400).json({ message: 'Message is too long' });
    const jd = await loadOwned(req, res);
    if (!jd) return;
    if (!canEdit(jd.status, req.userId!, jd.createdBy.toString())) {
      return res.status(400).json({ message: 'This JD is in review and can no longer be edited' });
    }
    const pending = jd.aiRuns[jd.aiRuns.length - 1];
    const stale = pending && Date.now() - new Date(pending.startedAt).getTime() > 3 * 60_000;
    if (jd.agentState === 'running' && !stale) {
      return res.status(409).json({ message: 'The assistant is still working on your last message', runId: pending?.runId });
    }

    jd.conversation.push({ role: 'user', content: String(message), at: new Date() } as any);

    if (jd.agentState !== 'legacy' && (await agentAvailable())) {
      const author = await User.findById(jd.createdBy).populate('reportsTo', 'name title');
      const teammates = author?.reportsTo ? await User.find({ reportsTo: (author.reportsTo as any)._id }).select('title department') : [];
      const context = {
        existing: contentSnapshot(jd),
        org: {
          author_department: author?.department,
          author_title: author?.title,
          manager: (author?.reportsTo as any)?.name || null,
          team_titles: teammates.map((t) => t.title).filter(Boolean).slice(0, 12),
        },
        prefs: await getPrefsFor(req.userId!, jd.department || author?.department || ''),
      };
      try {
        const r = await agentCall<{ run_id: string; status: string }>('POST', `/threads/${jd._id}/messages`, {
          message: String(message),
          idempotency_key: `${jd._id}:${jd.conversation.length}`,
          user_hash: userHash(req.userId!),
          context,
        });
        jd.aiRuns.push({ runId: r.run_id, kind: 'draft', status: r.status, applied: false, startedAt: new Date() } as any);
        jd.agentState = 'running';
        jd.activeRunId = r.run_id;
        await jd.save();
        return res.json({ jd, runId: r.run_id, mode: 'agent' });
      } catch (err: any) {
        console.warn('[agent] falling back to legacy flow:', err.message);
        jd.conversation.push({
          role: 'assistant',
          content: "The AI drafting service is unavailable right now, so I've switched to the guided question flow.",
          kind: 'legacy',
          at: new Date(),
        } as any);
        jd.agentState = 'legacy';
        jd.conversationStep = 0;
        jd.conversation.push({ role: 'assistant', content: firstPrompt(), kind: 'legacy', at: new Date() } as any);
        await jd.save();
        return res.json({ jd, mode: 'legacy' });
      }
    }

    // ---- Baseline v0: deterministic question flow (final fallback)
    jd.agentState = 'legacy';
    const result = processAnswer(jd.conversationStep, String(message));
    Object.entries(result.patch).forEach(([key, value]) => {
      (jd as any)[key] = value;
    });
    jd.conversationStep = result.nextStep;
    let reply = result.reply;
    if (result.done) {
      reply += `\n\n---\n${summarizeDraft(jd)}`;
      jd.versions.push({ version: jd.versions.length + 1, origin: 'manual', byUser: jd.createdBy, at: new Date(), fields: contentSnapshot(jd) } as any);
    }
    jd.conversation.push({ role: 'assistant', content: reply, kind: 'legacy', at: new Date() } as any);
    await jd.save();
    res.json({ jd, done: result.done, mode: 'legacy' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/jds/:id/runs/:runId - progress of an agent run (and backstop apply)
router.get('/:id/runs/:runId', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const jd = await loadOwned(req, res);
    if (!jd) return;
    const entry = jd.aiRuns.find((r) => r.runId === req.params.runId);
    if (!entry) return res.status(404).json({ message: 'Run not found' });
    const run = await agentCall<any>('GET', `/runs/${req.params.runId}`);
    let applied = entry.applied;
    if (!applied && ['completed', 'needs_input', 'failed'].includes(run.status)) {
      const r = await applyRunResult({ runId: run._id, jdId: jd._id.toString(), kind: run.kind, status: run.status, result: run.result, metrics: run.metrics });
      applied = r.applied || r.reason === 'already applied';
    }
    res.json({
      run: { id: run._id, status: run.status, events: run.events, metrics: run.metrics, provider: run.provider, error: run.error ? 'run failed' : null },
      applied,
    });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/jds/:id/agent-thread - start the assistant conversation over
router.delete('/:id/agent-thread', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const jd = await loadOwned(req, res);
    if (!jd) return;
    if (await agentAvailable()) await agentCall('DELETE', `/threads/${jd._id}`);
    jd.conversation = [{ role: 'assistant', content: AGENT_OPENER, kind: 'question', at: new Date() }] as any;
    jd.agentState = (await agentAvailable()) ? 'collecting' : 'legacy';
    jd.conversationStep = 0;
    jd.aiMeta = {};
    jd.markModified('aiMeta');
    await jd.save();
    res.json({ jd });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/jds/:id - manual edits (owner only, while draft/rejected)
router.patch('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await loadOwned(req, res);
  if (!jd) return;
  if (!canEdit(jd.status, req.userId!, jd.createdBy.toString())) {
    return res.status(400).json({ message: 'This JD is in review and can no longer be edited' });
  }
  const patch: Record<string, unknown> = {};
  EDITABLE_FIELDS.forEach((key) => {
    if (key in req.body) patch[key] = req.body[key];
  });
  const check = ProposalFields.partial().safeParse(patch);
  if (!check.success) return res.status(400).json({ message: 'Invalid fields', issues: check.error.issues.slice(0, 5) });
  Object.assign(jd, check.data);
  await jd.save();
  res.json({ jd });
});

// POST /api/jds/:id/critique - run the compliance/quality critic on the current content
router.post('/:id/critique', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const jd = await loadOwned(req, res);
    if (!jd) return;
    const r = await agentCall<any>('POST', '/critique', { jd: { _id: jd._id.toString(), ...contentSnapshot(jd) }, user_hash: userHash(req.userId!) });
    jd.aiMeta = { ...(jd.aiMeta || {}), critique: { findings: r.findings, rubric: r.rubric, passed: r.passed } };
    jd.markModified('aiMeta');
    await jd.save();
    res.json({ critique: jd.aiMeta.critique });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/jds/:id/submit - send for approval (manager first if one exists, else HR)
router.post('/:id/submit', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  const author = await User.findById(jd.createdBy);
  const me = await User.findById(req.userId);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const t = transition('submit', {
    status: jd.status,
    authorId: jd.createdBy.toString(),
    authorManagerId: author?.reportsTo ? author.reportsTo.toString() : null,
    actor: { id: req.userId!, role: me.role },
  });
  if (!t.ok) return res.status(t.code).json({ message: t.message });
  if (!jd.title || jd.title === 'Untitled Job Description' || !jd.summary || jd.responsibilities.length === 0) {
    return res.status(400).json({ message: 'Add a title, summary and at least one responsibility before submitting' });
  }

  jd.status = t.next;
  jd.history.push({ action: t.historyAction, byUser: req.userId!, at: new Date() } as any);
  jd.versions.push({ version: jd.versions.length + 1, origin: 'submission', byUser: req.userId, at: new Date(), fields: contentSnapshot(jd) } as any);
  await jd.save();
  syncJdToIndex(jd);

  if (t.notify === 'manager' && author?.reportsTo) {
    await notify({
      user: author.reportsTo,
      type: 'jd_submitted',
      title: 'JD awaiting your approval',
      message: `${author.name} ${t.historyAction} "${jd.title}" for your review.`,
      jd: jd._id,
    });
  } else {
    const hrUsers = await User.find({ role: 'hr' });
    await Promise.all(
      hrUsers.map((hr) =>
        notify({ user: hr._id, type: 'jd_submitted', title: 'JD awaiting HR approval', message: `${author?.name} submitted "${jd.title}" for HR review.`, jd: jd._id }),
      ),
    );
  }
  res.json({ jd });
});

async function decide(req: AuthedRequest, res: Response, action: 'approve' | 'reject') {
  const { comment } = req.body;
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  const me = await User.findById(req.userId);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const author = await User.findById(jd.createdBy);
  const stage = jd.status;
  const t = transition(action, {
    status: jd.status,
    authorId: jd.createdBy.toString(),
    authorManagerId: author?.reportsTo ? author.reportsTo.toString() : null,
    actor: { id: req.userId!, role: me.role },
  });
  if (!t.ok) return res.status(t.code).json({ message: t.message });
  if (action === 'reject' && !String(comment || '').trim()) {
    return res.status(400).json({ message: 'Please say what needs to change' });
  }

  jd.status = t.next;
  jd.history.push({ action: t.historyAction, byUser: req.userId!, comment, at: new Date() } as any);
  // reviewer timing (review-open → decision)
  const open = [...jd.reviewEvents].reverse().find((e) => e.stage === stage && e.user.toString() === req.userId && !e.decidedAt);
  if (open) {
    open.decidedAt = new Date();
    open.decision = action === 'approve' ? 'approved' : 'rejected';
  } else if (stage === 'pending_manager' || stage === 'pending_hr') {
    jd.reviewEvents.push({ stage, user: req.userId, openedAt: new Date(), decidedAt: new Date(), decision: action === 'approve' ? 'approved' : 'rejected' } as any);
  }
  await jd.save();
  syncJdToIndex(jd);

  if (t.next === 'approved') {
    learnFromApproval(jd).catch((e) => console.warn('[memory] learn failed', e.message));
  }

  if (t.notify === 'hr') {
    const hrUsers = await User.find({ role: 'hr' });
    await Promise.all(
      hrUsers.map((hr) =>
        notify({ user: hr._id, type: 'jd_submitted', title: 'JD awaiting HR approval', message: `"${jd.title}" was approved by the manager and now needs HR sign-off.`, jd: jd._id }),
      ),
    );
  } else if (t.next === 'approved') {
    await notify({ user: jd.createdBy, type: 'jd_approved', title: 'Your JD was approved', message: `"${jd.title}" has been fully approved.`, jd: jd._id });
  } else if (t.next === 'rejected') {
    await notify({
      user: jd.createdBy,
      type: 'jd_rejected',
      title: 'Your JD needs changes',
      message: `"${jd.title}" was sent back: ${comment}. Open it to let the assistant propose fixes.`,
      jd: jd._id,
    });
  }
  res.json({ jd });
}

router.post('/:id/approve', requireAuth, (req: AuthedRequest, res) => decide(req, res, 'approve').catch((e) => fail(res, e)));
router.post('/:id/reject', requireAuth, (req: AuthedRequest, res) => decide(req, res, 'reject').catch((e) => fail(res, e)));

// GET /api/jds/:id/copilot - reviewer copilot report (current approver or HR)
router.get('/:id/copilot', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const jd = await JobDescription.findById(req.params.id);
    if (!jd) return res.status(404).json({ message: 'Job description not found' });
    const me = await User.findById(req.userId);
    const author = await User.findById(jd.createdBy);
    if (!me) return res.status(404).json({ message: 'User not found' });
    const kind = currentApproverKind(jd.status);
    const isApprover =
      (kind === 'manager' && author?.reportsTo?.toString() === req.userId) || (kind === 'hr' && me.role === 'hr');
    if (!isApprover && me.role !== 'hr') return res.status(403).json({ message: 'Only the current reviewer can use the copilot' });

    if (isApprover && (jd.status === 'pending_manager' || jd.status === 'pending_hr')) {
      const already = jd.reviewEvents.some((e) => e.stage === jd.status && e.user.toString() === req.userId && !e.decidedAt);
      if (!already) jd.reviewEvents.push({ stage: jd.status, user: req.userId, openedAt: new Date(), usedCopilot: true } as any);
      await jd.save();
    }
    const subs = jd.versions.filter((v) => v.origin === 'submission');
    const previous = subs.length >= 2 ? subs[subs.length - 2].fields : null;
    let lastRejection: string | null = null;
    for (let i = jd.history.length - 1; i >= 0; i--) {
      if (jd.history[i].action === 'rejected') {
        lastRejection = jd.history[i].comment || null;
        break;
      }
    }
    const report = await agentCall<any>('POST', '/review', {
      jd: { _id: jd._id.toString(), ...contentSnapshot(jd) },
      previous,
      stage: jd.status,
      last_rejection: lastRejection,
      user_hash: userHash(req.userId!),
    });
    res.json({ report });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/jds/:id/revise - revision agent proposes edits for a rejection (owner)
router.post('/:id/revise', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const jd = await loadOwned(req, res);
    if (!jd) return;
    if (!canEdit(jd.status, req.userId!, jd.createdBy.toString())) return res.status(400).json({ message: 'JD is in review' });
    const comment = String(req.body.comment || lastRejectionComment(jd) || '').trim();
    if (!comment) return res.status(400).json({ message: 'No reviewer comment to address' });
    const proposal = await agentCall<any>('POST', '/revise', {
      jd: { _id: jd._id.toString(), ...contentSnapshot(jd) },
      comment,
      user_hash: userHash(req.userId!),
    });
    jd.aiMeta = { ...(jd.aiMeta || {}), pendingRevision: { ...proposal, comment, at: new Date() } };
    jd.markModified('aiMeta');
    await jd.save();
    res.json({ proposal: jd.aiMeta.pendingRevision });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/jds/:id/revise/apply - owner confirms the proposed revision (all or selected fields)
router.post('/:id/revise/apply', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await loadOwned(req, res);
  if (!jd) return;
  if (!canEdit(jd.status, req.userId!, jd.createdBy.toString())) return res.status(400).json({ message: 'JD is in review' });
  const pending = jd.aiMeta?.pendingRevision;
  if (!pending?.fields) return res.status(400).json({ message: 'No pending revision' });
  const accept: string[] | undefined = Array.isArray(req.body.fields) ? req.body.fields : undefined;
  const patch: Record<string, unknown> = {};
  EDITABLE_FIELDS.forEach((k) => {
    if (k in pending.fields && (!accept || accept.includes(k))) patch[k] = pending.fields[k];
  });
  const check = ProposalFields.partial().safeParse(patch);
  if (!check.success) return res.status(400).json({ message: 'Proposal failed validation' });
  Object.assign(jd, check.data);
  jd.history.push({ action: 'ai_revision_applied', byUser: req.userId!, comment: (pending.addressed || []).join('; ').slice(0, 500), at: new Date() } as any);
  jd.versions.push({ version: jd.versions.length + 1, origin: 'revision', byUser: req.userId, runId: pending.run_id, at: new Date(), fields: contentSnapshot(jd) } as any);
  jd.aiMeta = { ...jd.aiMeta, pendingRevision: null };
  jd.markModified('aiMeta');
  await jd.save();
  res.json({ jd });
});

// POST /api/jds/:id/mention - tag peers for feedback / collaboration / approval
router.post('/:id/mention', requireAuth, async (req: AuthedRequest, res) => {
  const { userIds, type } = req.body as { userIds: string[]; type: 'approval' | 'feedback' | 'collaboration' };
  if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ message: 'userIds is required' });
  const jd = await loadOwned(req, res);
  if (!jd) return;

  const already = new Set(jd.peerApprovals.map((p) => p.user.toString()));
  const fresh = userIds.filter((id) => !already.has(id) && id !== req.userId);
  fresh.forEach((id) => {
    jd.peerApprovals.push({ user: id as any, type: type || 'feedback', status: 'pending' } as any);
  });
  await jd.save();

  const author = await User.findById(req.userId);
  await Promise.all(
    fresh.map((id) =>
      notify({ user: id, type: 'mention', title: 'You were mentioned on a JD', message: `${author?.name} asked for your ${type || 'feedback'} on "${jd.title}".`, jd: jd._id }),
    ),
  );
  res.json({ jd });
});

// POST /api/jds/:id/peer-respond - a mentioned peer approves/rejects/comments
router.post('/:id/peer-respond', requireAuth, async (req: AuthedRequest, res) => {
  const { status, comment } = req.body as { status: 'approved' | 'rejected'; comment?: string };
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });

  const entry = jd.peerApprovals.find((p) => p.user.toString() === req.userId);
  if (!entry) return res.status(403).json({ message: 'You were not mentioned on this JD' });

  entry.status = status;
  entry.comment = comment;
  entry.respondedAt = new Date();
  await jd.save();
  syncJdToIndex(jd);

  const me = await User.findById(req.userId);
  await notify({ user: jd.createdBy, type: 'mention', title: 'Peer responded', message: `${me?.name} ${status} your JD "${jd.title}".`, jd: jd._id });
  res.json({ jd });
});

export default router;
