import { Router } from 'express';
import { z } from 'zod';
import Preference from '../models/Preference';
import User from '../models/User';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { getPrefsFor } from '../utils/memory';

const router = Router();

const PrefsIn = z.object({
  tone: z.enum(['friendly', 'formal', 'concise']).optional(),
  benefits: z.array(z.string().min(1).max(200)).max(15).optional(),
});

// GET /api/me/preferences
router.get('/preferences', requireAuth, async (req: AuthedRequest, res) => {
  const me = await User.findById(req.userId);
  const prefs = await getPrefsFor(req.userId!, me?.department || '');
  res.json({ preferences: prefs });
});

// PUT /api/me/preferences
router.put('/preferences', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = PrefsIn.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid preferences' });
  await Preference.findOneAndUpdate({ scope: 'user', key: req.userId }, { $set: parsed.data }, { upsert: true, new: true });
  const me = await User.findById(req.userId);
  res.json({ preferences: await getPrefsFor(req.userId!, me?.department || '') });
});

export default router;
