import { describe, it, expect } from 'vitest';
import { signPayload, verifyAgentSignature } from '../src/utils/agentClient';

describe('HMAC service auth', () => {
  it('verifies a correctly signed payload', () => {
    const body = JSON.stringify({ runId: 'r1' });
    const { ts, sig } = signPayload('POST', '/api/internal/agent-callback', body);
    expect(verifyAgentSignature('POST', '/api/internal/agent-callback', body, ts, sig)).toBe(true);
  });
  it('rejects tampered bodies, wrong paths, missing and stale signatures', () => {
    const body = JSON.stringify({ runId: 'r1' });
    const { ts, sig } = signPayload('POST', '/api/internal/agent-callback', body);
    expect(verifyAgentSignature('POST', '/api/internal/agent-callback', body + ' ', ts, sig)).toBe(false);
    expect(verifyAgentSignature('POST', '/api/other', body, ts, sig)).toBe(false);
    expect(verifyAgentSignature('POST', '/api/internal/agent-callback', body, undefined, undefined)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const stale = signPayload('POST', '/api/internal/agent-callback', body, old);
    expect(verifyAgentSignature('POST', '/api/internal/agent-callback', body, old, stale.sig)).toBe(false);
  });
});
