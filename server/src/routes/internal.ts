import { Router } from 'express';
import { verifyAgentSignature } from '../utils/agentClient';
import { applyRunResult } from '../utils/aiApply';

/** Service-to-service endpoints. Authenticated by HMAC signature, not JWT. */
const router = Router();

router.post('/agent-callback', async (req: any, res) => {
  const raw: string = req.rawBody ? req.rawBody.toString('utf8') : '';
  const ok = verifyAgentSignature('POST', req.baseUrl + req.path, raw, req.header('x-agent-timestamp'), req.header('x-agent-signature'));
  if (!ok) return res.status(401).json({ message: 'bad signature' });
  try {
    const r = await applyRunResult(req.body);
    res.json({ applied: r.applied, reason: r.reason || null });
  } catch (err: any) {
    console.error('[internal] callback failed', err);
    res.status(500).json({ message: 'apply failed' });
  }
});

export default router;
