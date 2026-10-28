/**
 * Applies a settled agent run to a JD — the only path by which AI output
 * reaches the database. It is:
 *   - idempotent (keyed by runId; callback and poll may both deliver it),
 *   - schema-validated (zod; whitelisted content fields only — never status),
 *   - limited to editable JDs (draft/rejected); otherwise only the chat turn is kept.
 */
import { z } from 'zod';
import JobDescription, { IJobDescription, contentSnapshot } from '../models/JobDescription';
import { canEdit, EDITABLE_STATUSES } from './stateMachine';
import { notify } from './notify';

const str = (max: number) => z.string().max(max).optional().default('');
const list = (maxItems: number, maxLen = 400) => z.array(z.string().max(maxLen)).max(maxItems).optional().default([]);

export const ProposalFields = z
  .object({
    title: z.string().min(1).max(160),
    department: str(80),
    level: str(30),
    employmentType: str(40),
    location: str(120),
    workMode: str(20),
    salaryRange: str(80),
    summary: z.string().max(3000),
    responsibilities: list(12),
    qualifications: list(12),
    skills: list(25, 80),
    benefits: list(15, 200),
  })
  .strict();

const RunPayload = z.object({
  runId: z.string().min(1),
  jdId: z.string().min(1),
  kind: z.string(),
  status: z.enum(['queued', 'running', 'needs_input', 'completed', 'failed']),
  result: z.any().nullable().optional(),
  metrics: z.record(z.any()).optional().default({}),
});
export type RunPayload = z.infer<typeof RunPayload>;

function stateFor(payload: RunPayload): IJobDescription['agentState'] {
  if (payload.status === 'failed') return 'collecting';
  const t = payload.result?.type;
  if (t === 'question') return 'collecting';
  if (t === 'review') return 'needs_input';
  if (t === 'draft') return 'ready';
  return 'collecting';
}

/** Apply a run. Returns { applied: boolean, jd }. */
export async function applyRunResult(raw: unknown): Promise<{ applied: boolean; jd: IJobDescription | null; reason?: string }> {
  const parsed = RunPayload.safeParse(raw);
  if (!parsed.success) return { applied: false, jd: null, reason: 'invalid payload' };
  const payload = parsed.data;
  if (!['needs_input', 'completed', 'failed'].includes(payload.status)) return { applied: false, jd: null, reason: 'not settled' };

  const jd = await JobDescription.findById(payload.jdId);
  if (!jd) return { applied: false, jd: null, reason: 'jd not found' };
  const entry = jd.aiRuns.find((r) => r.runId === payload.runId);
  if (!entry) return { applied: false, jd, reason: 'unknown run for this jd' };
  if (entry.applied) return { applied: false, jd, reason: 'already applied' };

  // claim atomically so concurrent callback + poll can't double-apply
  const claimed = await JobDescription.updateOne(
    { _id: jd._id, appliedRunIds: { $ne: payload.runId } },
    { $addToSet: { appliedRunIds: payload.runId } },
  );
  if (!claimed.modifiedCount) return { applied: false, jd, reason: 'already applied' };

  const fresh = (await JobDescription.findById(payload.jdId))!;
  const run = fresh.aiRuns.find((r) => r.runId === payload.runId)!;
  run.applied = true;
  run.status = payload.status;
  run.finishedAt = new Date();
  run.metrics = payload.metrics;
  const result = payload.result || {};
  if (payload.status === 'failed') run.error = 'agent run failed';

  const message: string = typeof result.assistant_message === 'string' ? result.assistant_message.slice(0, 6000) : '';
  if (message) {
    fresh.conversation.push({ role: 'assistant', content: message, kind: result.type || 'info', runId: payload.runId, at: new Date() } as any);
  }

  const proposal = result.proposal;
  const editable = EDITABLE_STATUSES.includes(fresh.status);
  if (proposal && proposal.fields && editable) {
    const fieldsCheck = ProposalFields.safeParse(proposal.fields);
    if (!fieldsCheck.success) {
      run.error = 'proposal failed schema validation';
      fresh.conversation.push({
        role: 'assistant',
        content: "I produced a draft that didn't pass validation, so I didn't apply it. Try rephrasing or say 'regenerate'.",
        kind: 'error',
        at: new Date(),
      } as any);
    } else {
      const f = fieldsCheck.data;
      Object.assign(fresh, f);
      const sources = proposal.sources && typeof proposal.sources === 'object' ? Object.values(proposal.sources) : [];
      fresh.aiMeta = {
        ...(fresh.aiMeta || {}),
        bullets: proposal.bullets || {},
        sources,
        fieldMeta: proposal.field_meta || {},
        confidence: proposal.confidence || result.confidence || {},
        critique: proposal.critique || null,
        initialCritique: proposal.initial_critique || null,
        fixesApplied: proposal.fixes_applied || [],
        escalated: !!proposal.escalated,
        genMethod: proposal.gen_method || null,
        reviewQuestions: result.type === 'review' ? result.questions || [] : [],
        brief: result.brief || null,
        lastRunId: payload.runId,
      };
      fresh.markModified('aiMeta');
      const snap = contentSnapshot(fresh);
      fresh.versions.push({ version: fresh.versions.length + 1, origin: 'ai_draft', byUser: null, runId: payload.runId, at: new Date(), fields: snap } as any);
      if (!fresh.firstAiDraft) {
        fresh.firstAiDraft = snap;
        fresh.markModified('firstAiDraft');
      }
    }
  } else if (result.brief) {
    fresh.aiMeta = { ...(fresh.aiMeta || {}), brief: result.brief, confidence: result.confidence || {}, reviewQuestions: [] };
    fresh.markModified('aiMeta');
  }
  fresh.agentState = stateFor(payload);
  if (fresh.activeRunId === payload.runId) fresh.activeRunId = null;
  await fresh.save();

  // if the author isn't looking at the screen, let them know the draft is ready
  if (result.type === 'draft' || result.type === 'review') {
    await notify({
      user: fresh.createdBy,
      type: 'agent',
      title: result.type === 'draft' ? 'Your JD draft is ready' : 'The assistant needs your input',
      message: `"${fresh.title}" — ${result.type === 'draft' ? 'review and submit when ready.' : 'answer a quick question to finish the draft.'}`,
      jd: fresh._id,
    });
  }
  return { applied: true, jd: fresh };
}

export { canEdit };
