import { Router } from 'express';
import User from '../models/User';
import JobDescription from '../models/JobDescription';
import { requireAuth, requireRole, AuthedRequest } from '../middleware/auth';
import { notify } from '../utils/notify';

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
  const jds = await JobDescription.find().sort({ updatedAt: -1 });

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

// POST /api/admin/remind - nudge one or more employees who haven't finished their JD
router.post('/remind', requireAuth, requireRole('hr'), async (req: AuthedRequest, res) => {
  const { userIds, message } = req.body as { userIds: string[]; message?: string };
  if (!userIds?.length) return res.status(400).json({ message: 'userIds is required' });

  await Promise.all(
    userIds.map((id) =>
      notify({
        user: id,
        type: 'info',
        title: 'Reminder from HR',
        message: message || 'Please complete and submit your job description.',
      }),
    ),
  );

  res.json({ ok: true, remindedCount: userIds.length });
});

export default router;
