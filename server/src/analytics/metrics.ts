/** Business/UX metrics (the ones hiring managers understand), split by cohort
 * so the AI path can be compared against the legacy baseline. */
import JobDescription, { IJobDescription } from '../models/JobDescription';
import { changeRatio } from '../utils/textMetrics';

const H = 3_600_000;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

function cohortMetrics(jds: IJobDescription[]) {
  const firstDraftMin = jds
    .map((j) => {
      const v = j.versions.find((x) => x.origin === 'ai_draft' || x.origin === 'manual');
      return v ? (new Date(v.at).getTime() - new Date(j.createdAt).getTime()) / 60000 : null;
    })
    .filter((x): x is number => x !== null);
  const approved = jds.filter((j) => j.status === 'approved');
  const editRatios = approved
    .map((j) => changeRatio((j.firstAiDraft as any) || j.versions.find((v) => v.origin === 'manual')?.fields || null, j as any))
    .filter((x): x is number => x !== null);
  const submitted = jds.filter((j) => j.history.some((h) => h.action === 'submitted'));
  const rejectionCycles = submitted.map((j) => j.history.filter((h) => h.action === 'rejected').length);
  const cycleHours = approved
    .map((j) => {
      const s = j.history.find((h) => h.action === 'submitted')?.at;
      const a = [...j.history].reverse().find((h) => h.action === 'hr_approved')?.at;
      return s && a ? (new Date(a).getTime() - new Date(s).getTime()) / H : null;
    })
    .filter((x): x is number => x !== null);
  const reviewHours = jds.flatMap((j) =>
    j.reviewEvents.filter((e) => e.decidedAt).map((e) => (new Date(e.decidedAt!).getTime() - new Date(e.openedAt).getTime()) / H),
  );
  const firstDraftAccepted = approved.filter(
    (j) => (changeRatio((j.firstAiDraft as any) || null, j as any) ?? 1) < 0.1 && !j.history.some((h) => h.action === 'rejected'),
  );
  return {
    jds: jds.length,
    approved: approved.length,
    median_minutes_to_first_draft: median(firstDraftMin),
    avg_text_changed_after_draft_pct: editRatios.length ? Math.round((mean(editRatios)! * 100) * 10) / 10 : null,
    avg_rejection_cycles: mean(rejectionCycles),
    median_submit_to_approve_hours: median(cycleHours),
    first_draft_acceptance_pct: approved.length ? Math.round((firstDraftAccepted.length / approved.length) * 1000) / 10 : null,
    median_reviewer_hours: median(reviewHours),
  };
}

export async function businessMetrics() {
  const jds = await JobDescription.find({}).select('-conversation');
  const ai = jds.filter((j) => !!j.firstAiDraft);
  const legacy = jds.filter((j) => !j.firstAiDraft);
  return { ai: cohortMetrics(ai), legacy: cohortMetrics(legacy), all: cohortMetrics(jds) };
}
