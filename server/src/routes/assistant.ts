import { Router } from 'express';
import User from '../models/User';
import JobDescription from '../models/JobDescription';
import Conversation from '../models/Conversation';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { agentCall, AgentError, userHash } from '../utils/agentClient';
import { jdScopeFilter } from '../utils/jdHelpers';

/**
 * Layer 8 — Q&A over JDs, mention threads and chat. Permission-aware: the API
 * computes exactly which JDs and conversations this user may see and the agent
 * filters retrieval to those ids before ranking.
 */
const router = Router();

router.post('/ask', requireAuth, async (req: AuthedRequest, res) => {
  const question = String(req.body?.question || '').trim();
  if (question.length < 2) return res.status(400).json({ message: 'Ask a question' });
  if (question.length > 2000) return res.status(400).json({ message: 'Question is too long' });
  const me = await User.findById(req.userId);
  if (!me) return res.status(404).json({ message: 'User not found' });
  const jds = await JobDescription.find(await jdScopeFilter(me)).select('title department status skills qualifications');
  const convs = await Conversation.find({ participants: me._id }).select('_id');
  try {
    const answer = await agentCall('POST', '/qa', {
      question,
      allowed_jd_ids: jds.map((j) => j._id.toString()),
      allowed_conversation_ids: convs.map((c) => c._id.toString()),
      jd_index: jds.map((j) => ({ id: j._id.toString(), title: j.title, department: j.department, status: j.status, skills: j.skills, qualifications: j.qualifications })),
      user_hash: userHash(req.userId!),
    });
    res.json({ answer });
  } catch (err: any) {
    if (err instanceof AgentError) return res.status(err.status).json({ message: 'The assistant is unavailable right now.' });
    console.error(err);
    res.status(500).json({ message: 'Failed to answer' });
  }
});

export default router;
