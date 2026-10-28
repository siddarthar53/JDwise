/**
 * Signed HTTP client for the Python agent service.
 *
 * signature = hex(HMAC_SHA256(AGENT_SHARED_SECRET, `${ts}.${METHOD}.${path}.${body}`))
 * The same scheme verifies the agent's callbacks (see verifyAgentSignature).
 */
import crypto from 'crypto';

const AGENT_URL = (process.env.AGENT_URL || '').replace(/\/$/, '');
const SECRET = process.env.AGENT_SHARED_SECRET || 'dev-agent-secret-change-me';
const MAX_SKEW_S = 300;

if (process.env.NODE_ENV === 'production' && AGENT_URL && !process.env.AGENT_SHARED_SECRET) {
  throw new Error('AGENT_SHARED_SECRET must be set when AGENT_URL is configured in production');
}

export class AgentError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function signPayload(method: string, path: string, body: string, ts = String(Math.floor(Date.now() / 1000))) {
  const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${method.toUpperCase()}.${path}.${body}`).digest('hex');
  return { ts, sig };
}

export function verifyAgentSignature(method: string, path: string, rawBody: string, ts?: string, sig?: string): boolean {
  if (!ts || !sig) return false;
  const n = Number(ts);
  if (!Number.isFinite(n) || Math.abs(Date.now() / 1000 - n) > MAX_SKEW_S) return false;
  const expected = signPayload(method, path, rawBody, ts).sig;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function agentConfigured(): boolean {
  return !!AGENT_URL;
}

let health: { ok: boolean; checkedAt: number; provider?: string } = { ok: false, checkedAt: 0 };

/** Cached health check so a dead agent service fails fast to the legacy flow. */
export async function agentAvailable(): Promise<boolean> {
  if (!AGENT_URL) return false;
  const now = Date.now();
  if (now - health.checkedAt < (health.ok ? 30_000 : 5_000)) return health.ok;
  try {
    const r = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const j: any = r.ok ? await r.json() : null;
    health = { ok: !!j?.ok, checkedAt: now, provider: j?.provider };
  } catch {
    health = { ok: false, checkedAt: now };
  }
  return health.ok;
}

export function agentProvider(): string | undefined {
  return health.provider;
}

export function markAgentDown() {
  health = { ok: false, checkedAt: Date.now() };
}

export async function agentCall<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  if (!AGENT_URL) throw new AgentError('Agent service not configured', 503);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const pathname = path.split('?')[0];
  const { ts, sig } = signPayload(method, pathname, payload);
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}${path}`, {
      method,
      body: payload || undefined,
      headers: { 'content-type': 'application/json', 'x-agent-timestamp': ts, 'x-agent-signature': sig },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    markAgentDown();
    throw new AgentError(`Agent service unreachable: ${err?.message || err}`, 503);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new AgentError(data?.detail || `Agent error ${res.status}`, res.status >= 500 ? 502 : res.status);
  return data as T;
}

/** Fire-and-forget (indexing etc.). Never throws. */
export function agentFire(method: 'POST' | 'DELETE', path: string, body?: unknown) {
  if (!AGENT_URL) return;
  agentCall(method, path, body, 10_000).catch((e) => console.warn(`[agent] ${method} ${path} failed: ${e.message}`));
}

export function userHash(userId: string): string {
  return crypto.createHash('sha256').update(`${SECRET}:${userId}`).digest('hex').slice(0, 16);
}
