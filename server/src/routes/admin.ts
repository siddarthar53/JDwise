import { Router } from 'express';
import User from '../models/User';
import JobDescription from '../models/JobDescription';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth';
import { notify } from '../utils/notify';
import { catalog, runQuery, stageEnteredAt } from '../analytics/queries';
import { businessMetrics } from '../analytics/metrics';
import { agentAvailable, agentCall, AgentError, userHash } from '../utils/agentClient';

const router = Router();

const STATUS_PROGRESS: Record<string, number> = {
  draft: 20,
  pending_manager: 55,
  pending_hr: 80,
  approved: 100,
  rejected: 40,
};

// GET /api/admin/overview - HR-only company-wide snapshot
router.get('/overview', requireAuth, requireRole('hr'), async (_req, res) => {
  const employees = await User.find({ role: 'employee' }).populate('reportsTo', 'name');
  const jds = await JobDescription.find().select('-conversation -aiRuns -versions').sort({ updatedAt: -1 });

  const latestJdByUser = new Map<string, (typeof jds)[number]>();
  jds.forEach((jd) => {
    const key = jd.createdBy.toString();
    if (!latestJdByUser.has(key)) latestJdByUser.set(key, jd);
  });

  const employeeRows = employees.map((emp) => {
    const jd = latestJdByUser.get(emp._id.toString());
    return {
      id: emp._id.toString(),
      name: emp.name,
      email: emp.email,
      department: emp.department,
      reportingManager: (emp.reportsTo as any)?.name || '—',
      status: jd ? jd.status : 'not_started',
      progress: jd ? STATUS_PROGRESS[jd.status] ?? 0 : 0,
      lastActivity: jd ? jd.updatedAt : null,
      mentions: jd ? jd.peerApprovals.length : 0,
      jdId: jd ? jd._id.toString() : null,
      jdTitle: jd ? jd.title : null,
      aiDrafted: jd ? !!jd.firstAiDraft : false,
    };
  });

  const counts = {
    total: employeeRows.length,
    completed: employeeRows.filter((e) => e.status === 'approved').length,
    inProgress: employeeRows.filter((e) => ['draft', 'pending_manager', 'pending_hr'].includes(e.status)).length,
    notStarted: employeeRows.filter((e) => e.status === 'not_started').length,
    rejected: employeeRows.filter((e) => e.status === 'rejected').length,
  };

  res.json({ employees: employeeRows, counts });
});

// POST /api/admin/remind - nudge one or more users
router.post('/remind', requireAuth, requireRole('hr'), async (req: AuthedRequest, res) => {
  const { userIds, message, jdId } = req.body as { userIds: string[]; message?: string; jdId?: string };
  if (!userIds?.length) return res.status(400).json({ message: 'userIds is required' });
  await Promise.all(
    userIds.map((id) =>
      notify({ user: id, type: 'info', title: 'Reminder from HR', message: (message || 'Please complete and submit your job description.').slice(0, 1000), jd: jdId }),
    ),
  );
  res.json({ ok: true, remindedCount: userIds.length });
});

// ---- analytics (fixed query layer) --------------------------------------------------------

router.get('/analytics/catalog', requireAuth, requireRole('hr'), (_req, res) => res.json({ catalog: catalog() }));

router.post('/analytics/run', requireAuth, requireRole('hr'), async (req, res) => {
  const { queryId, params } = req.body || {};
  const out = await runQuery(String(queryId || ''), params);
  if (out.error) return res.status(400).json({ message: out.error });
  res.json(out);
});

// POST /api/admin/ops/ask - natural-language question → validated query → result
router.post('/ops/ask', requireAuth, requireRole('hr'), async (req: AuthedRequest, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ message: 'Ask a question' });
  let route: { query_id: string; params: Record<string, unknown>; rationale?: string } = { query_id: 'status_counts', params: {}, rationale: 'agent unavailable; default query' };
  if (await agentAvailable()) {
    try {
      route = await agentCall('POST', '/ops/route', { question, catalog: catalog(), user_hash: userHash(req.userId!) });
    } catch (e: any) {
      console.warn('[ops] route failed', e.message);
    }
  }
  let out = await runQuery(route.query_id, route.params);
  if (out.error) {
    // the router chose bad params: fall back to the query's defaults rather than failing
    out = await runQuery(route.query_id, {});
  }
  if (out.error) return res.status(400).json({ message: out.error });
  res.json({ route: { ...route, params: out.params }, ...out });
});

async function stuckItems(minAgeHours: number) {
  const jds = await JobDescription.find({ status: { $in: ['pending_manager', 'pending_hr'] } }).select('-conversation -aiRuns -versions');
  const users = new Map((await User.find({})).map((u) => [u._id.toString(), u]));
  const hr = [...users.values()].filter((u) => u.role === 'hr');
  const items: any[] = [];
  for (const j of jds) {
    const entered = stageEnteredAt(j);
    if (!entered) continue;
    const age = (Date.now() - new Date(entered).getTime()) / 3_600_000;
    if (age < minAgeHours) continue;
    const author = users.get(j.createdBy.toString());
    const approvers = j.status === 'pending_manager' ? [users.get(author?.reportsTo?.toString() || '')].filter(Boolean) : hr;
    for (const a of approvers as any[]) {
      items.push({ jd_id: j._id.toString(), jd_title: j.title, stage: j.status, age_hours: Math.round(age), approver_id: a._id.toString(), approver_name: a.name, author_name: author?.name || 'An employee' });
    }
  }
  return items;
}

// GET /api/admin/ops/stuck - stuck JDs with drafted reminders (HR sends them)
router.get('/ops/stuck', requireAuth, requireRole('hr'), async (req: AuthedRequest, res) => {
  const minAge = Math.max(1, Number(req.query.min_age_hours) || 48);
  const items = await stuckItems(minAge);
  let drafts: any[] = [];
  if (items.length && (await agentAvailable())) {
    try {
      drafts = (await agentCall<any>('POST', '/ops/reminders', { items, user_hash: userHash(req.userId!) })).drafts;
    } catch (e: any) {
      console.warn('[ops] reminder drafting failed', e.message);
    }
  }
  if (!drafts.length) {
    drafts = items.map((it) => ({
      to_user_id: it.approver_id,
      to_name: it.approver_name,
      jd_id: it.jd_id,
      subject: `Reminder: ${it.jd_title} awaiting review`,
      message: `"${it.jd_title}" from ${it.author_name} has been waiting ${Math.round(it.age_hours / 24)} days for your review.`,
    }));
  }
  res.json({ items, drafts });
});

// POST /api/admin/ops/send-reminders - HR confirms the drafted reminders
router.post('/ops/send-reminders', requireAuth, requireRole('hr'), async (req: AuthedRequest, res) => {
  const drafts = (req.body?.drafts || []) as { to_user_id: string; jd_id: string; subject: string; message: string }[];
  if (!Array.isArray(drafts) || !drafts.length) return res.status(400).json({ message: 'No reminders to send' });
  await Promise.all(
    drafts.slice(0, 50).map(async (d) => {
      await notify({ user: d.to_user_id, type: 'ops', title: String(d.subject).slice(0, 200), message: String(d.message).slice(0, 1000), jd: d.jd_id });
      await JobDescription.updateOne({ _id: d.jd_id }, { $push: { history: { action: 'reminder_sent', byUser: req.userId, comment: `to ${d.to_user_id}`, at: new Date() } } });
    }),
  );
  res.json({ ok: true, sent: Math.min(drafts.length, 50) });
});

// GET /api/admin/metrics - business metrics + agent observability
router.get('/metrics', requireAuth, requireRole('hr'), async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const business = await businessMetrics();
  let agent: any = null;
  let runs: any[] = [];
  if (await agentAvailable()) {
    try {
      agent = await agentCall('GET', `/metrics/summary?days=${days}`);
      runs = (await agentCall<any>('GET', '/runs?limit=25')).runs;
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
    }
  }
  res.json({ business, agent, runs, agentOnline: !!agent });
});

export default router;
