import { Router } from 'express';
import Notification from '../models/Notification';
import { requireAuth, AuthedRequest } from '../middleware/auth';

const router = Router();

// GET /api/notifications
router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const notifications = await Notification.find({ user: req.userId })
    .populate('jd', 'title status')
    .sort({ createdAt: -1 })
    .limit(100);
  const unreadCount = await Notification.countDocuments({ user: req.userId, read: false });
  res.json({ notifications, unreadCount });
});

// POST /api/notifications/:id/read
router.post('/:id/read', requireAuth, async (req: AuthedRequest, res) => {
  const n = await Notification.findOne({ _id: req.params.id, user: req.userId });
  if (!n) return res.status(404).json({ message: 'Notification not found' });
  n.read = true;
  await n.save();
  res.json({ notification: n });
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, async (req: AuthedRequest, res) => {
  await Notification.updateMany({ user: req.userId, read: false }, { $set: { read: true } });
  res.json({ ok: true });
});

export default router;
