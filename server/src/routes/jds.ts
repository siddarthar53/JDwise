import { Router } from 'express';
import JobDescription from '../models/JobDescription';
import User from '../models/User';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { notify } from '../utils/notify';
import { firstPrompt, processAnswer, summarizeDraft } from '../utils/jdAgent';

const router = Router();

// GET /api/jds - role-scoped list
router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const me = await User.findById(req.userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  let filter: any = {};
  if (me.role === 'hr') {
    filter = {}; // HR sees everything
  } else {
    const subordinates = await User.find({ reportsTo: me._id }).select('_id');
    const subIds = subordinates.map((s) => s._id);
    filter = {
      $or: [{ createdBy: me._id }, { createdBy: { $in: subIds } }, { 'peerApprovals.user': me._id }],
    };
  }

  const jds = await JobDescription.find(filter)
    .populate('createdBy', 'name email department')
    .sort({ updatedAt: -1 });

  res.json({ jds });
});

// GET /api/jds/:id
router.get('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await JobDescription.findById(req.params.id)
    .populate('createdBy', 'name email department')
    .populate('peerApprovals.user', 'name email')
    .populate('history.byUser', 'name email');
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  res.json({ jd });
});

// POST /api/jds - create a new draft (starts the AI agent conversation)
router.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const opening = firstPrompt();
  const jd = await JobDescription.create({
    createdBy: req.userId,
    status: 'draft',
    conversation: [{ role: 'assistant', content: opening, at: new Date() }],
    conversationStep: 0,
    history: [{ action: 'created', byUser: req.userId, at: new Date() }],
  });
  res.status(201).json({ jd });
});

// POST /api/jds/:id/agent-message - send a message to the AI agent, get the next question
router.post('/:id/agent-message', requireAuth, async (req: AuthedRequest, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ message: 'Message is required' });
  }

  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  if (jd.createdBy.toString() !== req.userId) {
    return res.status(403).json({ message: 'Not your job description' });
  }

  jd.conversation.push({ role: 'user', content: message, at: new Date() });

  const result = processAnswer(jd.conversationStep, message);
  Object.entries(result.patch).forEach(([key, value]) => {
    (jd as any)[key] = value;
  });
  jd.conversationStep = result.nextStep;

  let reply = result.reply;
  if (result.done) {
    reply += `\n\n---\n${summarizeDraft(jd)}`;
  }

  jd.conversation.push({ role: 'assistant', content: reply, at: new Date() });
  await jd.save();

  res.json({ jd, done: result.done });
});

// PATCH /api/jds/:id - manual edits to any field (owner only, while draft)
router.patch('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  if (jd.createdBy.toString() !== req.userId) {
    return res.status(403).json({ message: 'Not your job description' });
  }

  const editable = ['title', 'department', 'employmentType', 'summary', 'responsibilities', 'qualifications', 'skills', 'salaryRange'];
  editable.forEach((key) => {
    if (key in req.body) (jd as any)[key] = req.body[key];
  });

  await jd.save();
  res.json({ jd });
});

// POST /api/jds/:id/submit - send for approval (manager first if one exists, else HR)
router.post('/:id/submit', requireAuth, async (req: AuthedRequest, res) => {
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  if (jd.createdBy.toString() !== req.userId) {
    return res.status(403).json({ message: 'Not your job description' });
  }

  const author = await User.findById(jd.createdBy);
  const nextStatus = author?.reportsTo ? 'pending_manager' : 'pending_hr';
  jd.status = nextStatus;
  jd.history.push({ action: 'submitted', byUser: req.userId!, at: new Date() } as any);
  await jd.save();

  if (nextStatus === 'pending_manager' && author?.reportsTo) {
    await notify({
      user: author.reportsTo,
      type: 'jd_submitted',
      title: 'JD awaiting your approval',
      message: `${author.name} submitted "${jd.title}" for your review.`,
      jd: jd._id,
    });
  } else {
    const hrUsers = await User.find({ role: 'hr' });
    await Promise.all(
      hrUsers.map((hr) =>
        notify({
          user: hr._id,
          type: 'jd_submitted',
          title: 'JD awaiting HR approval',
          message: `${author?.name} submitted "${jd.title}" for HR review.`,
          jd: jd._id,
        }),
      ),
    );
  }

  res.json({ jd });
});

// POST /api/jds/:id/approve - manager or HR approves
router.post('/:id/approve', requireAuth, async (req: AuthedRequest, res) => {
  const { comment } = req.body;
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });

  const me = await User.findById(req.userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const author = await User.findById(jd.createdBy);

  if (jd.status === 'pending_manager') {
    if (!author?.reportsTo || author.reportsTo.toString() !== req.userId) {
      return res.status(403).json({ message: 'Only this employee\'s manager can approve at this stage' });
    }
    jd.status = 'pending_hr';
    jd.history.push({ action: 'manager_approved', byUser: req.userId!, comment, at: new Date() } as any);
    await jd.save();

    const hrUsers = await User.find({ role: 'hr' });
    await Promise.all(
      hrUsers.map((hr) =>
        notify({
          user: hr._id,
          type: 'jd_submitted',
          title: 'JD awaiting HR approval',
          message: `"${jd.title}" was approved by the manager and now needs HR sign-off.`,
          jd: jd._id,
        }),
      ),
    );
  } else if (jd.status === 'pending_hr') {
    if (me.role !== 'hr') {
      return res.status(403).json({ message: 'Only HR can give final approval' });
    }
    jd.status = 'approved';
    jd.history.push({ action: 'hr_approved', byUser: req.userId!, comment, at: new Date() } as any);
    await jd.save();

    await notify({
      user: jd.createdBy,
      type: 'jd_approved',
      title: 'Your JD was approved',
      message: `"${jd.title}" has been fully approved.`,
      jd: jd._id,
    });
  } else {
    return res.status(400).json({ message: `Cannot approve a JD with status "${jd.status}"` });
  }

  res.json({ jd });
});

// POST /api/jds/:id/reject
router.post('/:id/reject', requireAuth, async (req: AuthedRequest, res) => {
  const { comment } = req.body;
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });

  const me = await User.findById(req.userId);
  const author = await User.findById(jd.createdBy);

  const isManagerStage = jd.status === 'pending_manager' && author?.reportsTo?.toString() === req.userId;
  const isHrStage = jd.status === 'pending_hr' && me?.role === 'hr';

  if (!isManagerStage && !isHrStage) {
    return res.status(403).json({ message: 'You are not the current approver for this JD' });
  }

  jd.status = 'rejected';
  jd.history.push({ action: 'rejected', byUser: req.userId!, comment, at: new Date() } as any);
  await jd.save();

  await notify({
    user: jd.createdBy,
    type: 'jd_rejected',
    title: 'Your JD needs changes',
    message: comment ? `"${jd.title}" was rejected: ${comment}` : `"${jd.title}" was rejected.`,
    jd: jd._id,
  });

  res.json({ jd });
});

// POST /api/jds/:id/mention - tag peers for feedback / collaboration / approval
router.post('/:id/mention', requireAuth, async (req: AuthedRequest, res) => {
  const { userIds, type } = req.body as { userIds: string[]; type: 'approval' | 'feedback' | 'collaboration' };
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  if (jd.createdBy.toString() !== req.userId) {
    return res.status(403).json({ message: 'Not your job description' });
  }

  const already = new Set(jd.peerApprovals.map((p) => p.user.toString()));
  userIds.filter((id) => !already.has(id)).forEach((id) => {
    jd.peerApprovals.push({ user: id as any, type: type || 'feedback', status: 'pending' } as any);
  });
  await jd.save();

  const author = await User.findById(req.userId);
  await Promise.all(
    userIds.map((id) =>
      notify({
        user: id,
        type: 'mention',
        title: 'You were mentioned on a JD',
        message: `${author?.name} asked for your ${type || 'feedback'} on "${jd.title}".`,
        jd: jd._id,
      }),
    ),
  );

  res.json({ jd });
});

// POST /api/jds/:id/peer-respond - a mentioned peer approves/rejects/comments
router.post('/:id/peer-respond', requireAuth, async (req: AuthedRequest, res) => {
  const { status, comment } = req.body as { status: 'approved' | 'rejected'; comment?: string };
  const jd = await JobDescription.findById(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });

  const entry = jd.peerApprovals.find((p) => p.user.toString() === req.userId);
  if (!entry) return res.status(403).json({ message: 'You were not mentioned on this JD' });

  entry.status = status;
  entry.comment = comment;
  entry.respondedAt = new Date();
  await jd.save();

  const me = await User.findById(req.userId);
  await notify({
    user: jd.createdBy,
    type: 'mention',
    title: 'Peer responded',
    message: `${me?.name} ${status} your JD "${jd.title}".`,
    jd: jd._id,
  });

  res.json({ jd });
});

export default router;
