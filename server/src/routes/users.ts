import { Router } from 'express';
import User from '../models/User';
import { requireAuth, AuthedRequest } from '../middleware/auth';

const router = Router();

function publicUser(u: any) {
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
    title: u.title,
    department: u.department,
    reportsTo: u.reportsTo ? u.reportsTo.toString() : null,
  };
}

// GET /api/users - directory (for @mentions, chat, manager views)
router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const users = await User.find().sort({ name: 1 });
  res.json({ users: users.map(publicUser) });
});

// GET /api/users/subordinates - direct reports of the logged-in manager
router.get('/subordinates', requireAuth, async (req: AuthedRequest, res) => {
  const subs = await User.find({ reportsTo: req.userId }).sort({ name: 1 });
  res.json({ users: subs.map(publicUser) });
});

// GET /api/users/:id
router.get('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({ user: publicUser(user) });
});

export default router;
