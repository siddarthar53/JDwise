/**
 * Layer 9 — the fixed, validated analytics query layer.
 *
 * The ops agent may only pick a query id and parameters from this catalog;
 * parameters are validated with zod before anything runs. No free-form queries.
 */
import { z } from 'zod';
import JobDescription, { IJobDescription } from '../models/JobDescription';
import User from '../models/User';
import { changeRatio } from '../utils/textMetrics';

const HOUR = 3_600_000;
const groupBy = z.enum(['none', 'department']).default('none');
const sinceDays = z.coerce.number().int().min(1).max(3650).optional();

export interface QueryResult {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  chart?: { type: 'bar' | 'line'; x: number; y: number[] };
  summary: string;
}

function hoursBetween(a?: Date, b?: Date): number | null {
  if (!a || !b) return null;
  return Math.round(((new Date(b).getTime() - new Date(a).getTime()) / HOUR) * 10) / 10;
}
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const firstAt = (jd: IJobDescription, actions: string[]) => jd.history.find((h) => actions.includes(h.action))?.at;
const lastAt = (jd: IJobDescription, actions: string[]) => [...jd.history].reverse().find((h) => actions.includes(h.action))?.at;
const deptOf = (jd: IJobDescription) => jd.department || 'Unassigned';

function inWindow(d: Date | undefined, days?: number) {
  if (!days) return true;
  return !!d && Date.now() - new Date(d).getTime() <= days * 86_400_000;
}

/** When did the JD enter its current stage? */
export function stageEnteredAt(jd: IJobDescription): Date | undefined {
  if (jd.status === 'pending_manager') return lastAt(jd, ['submitted', 'resubmitted']);
  if (jd.status === 'pending_hr') return lastAt(jd, ['manager_approved', 'submitted', 'resubmitted']);
  return undefined;
}

type QueryDef = {
  id: string;
  description: string;
  params: z.ZodTypeAny;
  paramsDoc: Record<string, string>;
  run: (p: any, jds: IJobDescription[]) => Promise<QueryResult>;
};

export const QUERIES: QueryDef[] = [
  {
    id: 'status_counts',
    description: 'How many JDs are in each pipeline status, optionally per department.',
    params: z.object({ group_by: groupBy, since_days: sinceDays }),
    paramsDoc: { group_by: "'none' | 'department'", since_days: 'optional number of days (by last update)' },
    run: async (p, jds) => {
      const statuses = ['draft', 'pending_manager', 'pending_hr', 'approved', 'rejected'];
      const sel = jds.filter((j) => inWindow(j.updatedAt, p.since_days));
      if (p.group_by === 'department') {
        const depts = [...new Set(sel.map(deptOf))].sort();
        const rows = depts.map((d) => [d, ...statuses.map((s) => sel.filter((j) => deptOf(j) === d && j.status === s).length)]);
        return { title: 'JDs by status and department', columns: ['Department', ...statuses], rows, summary: `${sel.length} JDs across ${depts.length} departments.` };
      }
      const rows = statuses.map((s) => [s, sel.filter((j) => j.status === s).length]);
      return { title: 'JDs by status', columns: ['Status', 'Count'], rows, chart: { type: 'bar', x: 0, y: [1] }, summary: `${sel.length} JDs in total.` };
    },
  },
  {
    id: 'avg_approval_time',
    description: 'Average hours from first submission to final HR approval, optionally per department.',
    params: z.object({ group_by: groupBy, since_days: sinceDays }),
    paramsDoc: { group_by: "'none' | 'department'", since_days: 'optional window (by approval date)' },
    run: async (p, jds) => {
      const done = jds
        .filter((j) => j.status === 'approved' && inWindow(lastAt(j, ['hr_approved']), p.since_days))
        .map((j) => ({ dept: deptOf(j), h: hoursBetween(firstAt(j, ['submitted']), lastAt(j, ['hr_approved'])) }))
        .filter((x) => x.h !== null) as { dept: string; h: number }[];
      if (p.group_by === 'department') {
        const depts = [...new Set(done.map((d) => d.dept))].sort();
        const rows = depts.map((d) => [d, avg(done.filter((x) => x.dept === d).map((x) => x.h)), done.filter((x) => x.dept === d).length]);
        return { title: 'Average submit→approve time by department (hours)', columns: ['Department', 'Avg hours', 'JDs'], rows, chart: { type: 'bar', x: 0, y: [1] }, summary: `Across ${done.length} approved JDs the average is ${avg(done.map((x) => x.h)) ?? '—'} hours.` };
      }
      return { title: 'Average submit→approve time (hours)', columns: ['Approved JDs', 'Avg hours', 'Fastest', 'Slowest'], rows: [[done.length, avg(done.map((x) => x.h)), done.length ? Math.min(...done.map((x) => x.h)) : null, done.length ? Math.max(...done.map((x) => x.h)) : null]], summary: `Average ${avg(done.map((x) => x.h)) ?? '—'} hours over ${done.length} approved JDs.` };
    },
  },
  {
    id: 'stuck_jds',
    description: 'JDs waiting in a review stage longer than a threshold.',
    params: z.object({ stage: z.enum(['any', 'pending_manager', 'pending_hr']).default('any'), min_age_hours: z.coerce.number().min(1).max(24 * 365).default(48) }),
    paramsDoc: { stage: "'any' | 'pending_manager' | 'pending_hr'", min_age_hours: 'number (default 48)' },
    run: async (p, jds) => {
      const authors = new Map((await User.find({}).select('name reportsTo')).map((u) => [u._id.toString(), u]));
      const rows = jds
        .filter((j) => (p.stage === 'any' ? ['pending_manager', 'pending_hr'].includes(j.status) : j.status === p.stage))
        .map((j) => ({ j, age: hoursBetween(stageEnteredAt(j), new Date()) ?? 0 }))
        .filter((x) => x.age >= p.min_age_hours)
        .sort((a, b) => b.age - a.age)
        .map(({ j, age }) => {
          const author = authors.get(j.createdBy.toString());
          const approver = j.status === 'pending_manager' ? authors.get(author?.reportsTo?.toString() || '')?.name || '—' : 'HR';
          return [j.title, deptOf(j), j.status, Math.round(age), author?.name || '—', approver];
        });
      return { title: `JDs stuck longer than ${p.min_age_hours}h`, columns: ['JD', 'Department', 'Stage', 'Hours waiting', 'Author', 'Waiting on'], rows, summary: rows.length ? `${rows.length} JD(s) are waiting longer than ${p.min_age_hours} hours.` : 'Nothing is stuck.' };
    },
  },
  {
    id: 'rejection_rate',
    description: 'Share of review decisions that were rejections, optionally per department.',
    params: z.object({ group_by: groupBy, since_days: sinceDays }),
    paramsDoc: { group_by: "'none' | 'department'", since_days: 'optional window' },
    run: async (p, jds) => {
      const decisions: { dept: string; rejected: boolean }[] = [];
      jds.forEach((j) =>
        j.history.forEach((h) => {
          if (['rejected', 'manager_approved', 'hr_approved'].includes(h.action) && inWindow(h.at, p.since_days)) decisions.push({ dept: deptOf(j), rejected: h.action === 'rejected' });
        }),
      );
      const rate = (xs: typeof decisions) => (xs.length ? Math.round((xs.filter((x) => x.rejected).length / xs.length) * 1000) / 10 : null);
      if (p.group_by === 'department') {
        const depts = [...new Set(decisions.map((d) => d.dept))].sort();
        const rows = depts.map((d) => [d, rate(decisions.filter((x) => x.dept === d)), decisions.filter((x) => x.dept === d).length]);
        return { title: 'Rejection rate by department (%)', columns: ['Department', 'Rejection %', 'Decisions'], rows, chart: { type: 'bar', x: 0, y: [1] }, summary: `Overall rejection rate ${rate(decisions) ?? '—'}% over ${decisions.length} decisions.` };
      }
      return { title: 'Rejection rate', columns: ['Decisions', 'Rejections', 'Rejection %'], rows: [[decisions.length, decisions.filter((x) => x.rejected).length, rate(decisions)]], summary: `Rejection rate ${rate(decisions) ?? '—'}%.` };
    },
  },
  {
    id: 'throughput',
    description: 'JDs created, submitted and approved per week.',
    params: z.object({ weeks: z.coerce.number().int().min(1).max(52).default(8) }),
    paramsDoc: { weeks: 'number of weeks (default 8)' },
    run: async (p, jds) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - start.getDay() - 7 * (p.weeks - 1));
      const rows: (string | number)[][] = [];
      for (let w = 0; w < p.weeks; w++) {
        const a = new Date(start.getTime() + w * 7 * 86_400_000);
        const b = new Date(a.getTime() + 7 * 86_400_000);
        const inW = (d?: Date) => !!d && new Date(d) >= a && new Date(d) < b;
        rows.push([
          a.toISOString().slice(0, 10),
          jds.filter((j) => inW(j.createdAt)).length,
          jds.reduce((n, j) => n + j.history.filter((h) => ['submitted', 'resubmitted'].includes(h.action) && inW(h.at)).length, 0),
          jds.reduce((n, j) => n + j.history.filter((h) => h.action === 'hr_approved' && inW(h.at)).length, 0),
        ]);
      }
      return { title: 'Weekly throughput', columns: ['Week of', 'Created', 'Submitted', 'Approved'], rows, chart: { type: 'line', x: 0, y: [1, 2, 3] }, summary: `${rows.reduce((n, r) => n + (r[3] as number), 0)} approvals in the last ${p.weeks} weeks.` };
    },
  },
  {
    id: 'reviewer_latency',
    description: 'How long each reviewer takes from opening a JD to deciding, and how long JDs wait for them.',
    params: z.object({ since_days: sinceDays }),
    paramsDoc: { since_days: 'optional window' },
    run: async (p, jds) => {
      const names = new Map((await User.find({}).select('name')).map((u) => [u._id.toString(), u.name]));
      const by = new Map<string, { review: number[]; decisions: number; copilot: number }>();
      jds.forEach((j) =>
        j.reviewEvents.forEach((e) => {
          if (!e.decidedAt || !inWindow(e.decidedAt, p.since_days)) return;
          const k = names.get(e.user.toString()) || 'Unknown';
          const v = by.get(k) || { review: [], decisions: 0, copilot: 0 };
          const h = hoursBetween(e.openedAt, e.decidedAt);
          if (h !== null) v.review.push(h);
          v.decisions += 1;
          if (e.usedCopilot) v.copilot += 1;
          by.set(k, v);
        }),
      );
      const rows = [...by.entries()].map(([k, v]) => [k, v.decisions, avg(v.review), v.copilot]);
      return { title: 'Reviewer latency', columns: ['Reviewer', 'Decisions', 'Avg open→decide (h)', 'Used copilot'], rows, summary: `${rows.length} reviewer(s) made decisions in this window.` };
    },
  },
  {
    id: 'ai_impact',
    description: 'Compare AI-drafted JDs with manually drafted ones: edits after drafting, rejection cycles, cycle time.',
    params: z.object({ since_days: sinceDays }),
    paramsDoc: { since_days: 'optional window (by creation)' },
    run: async (p, jds) => {
      const sel = jds.filter((j) => inWindow(j.createdAt, p.since_days));
      const cohort = (ai: boolean) => {
        const xs = sel.filter((j) => !!j.firstAiDraft === ai);
        const approved = xs.filter((j) => j.status === 'approved');
        const ratios = approved.map((j) => changeRatio(j.firstAiDraft as any, j as any)).filter((x): x is number => x !== null);
        const cycles = xs.map((j) => j.history.filter((h) => h.action === 'rejected').length);
        const cycle = approved.map((j) => hoursBetween(firstAt(j, ['submitted']), lastAt(j, ['hr_approved']))).filter((x): x is number => x !== null);
        const accepted = approved.filter((j) => (changeRatio(j.firstAiDraft as any, j as any) ?? 1) < 0.1 && !j.history.some((h) => h.action === 'rejected'));
        return [
          ai ? 'AI-drafted' : 'Manual / legacy',
          xs.length,
          approved.length,
          ai ? avg(ratios.map((r) => r * 100)) : null,
          avg(cycles),
          avg(cycle),
          ai && approved.length ? Math.round((accepted.length / approved.length) * 1000) / 10 : null,
        ];
      };
      return {
        title: 'AI drafting impact',
        columns: ['Cohort', 'JDs', 'Approved', '% text changed after AI draft', 'Avg rejection cycles', 'Avg submit→approve (h)', 'First-draft acceptance %'],
        rows: [cohort(true), cohort(false)],
        summary: 'Edits are measured as word-level edit distance between the first AI draft and the approved text.',
      };
    },
  },
];

export function catalog() {
  return QUERIES.map((q) => ({ id: q.id, description: q.description, params: q.paramsDoc }));
}

export async function runQuery(id: string, rawParams: unknown): Promise<{ result?: QueryResult; error?: string; params?: unknown }> {
  const q = QUERIES.find((x) => x.id === id);
  if (!q) return { error: `Unknown query "${id}"` };
  const parsed = q.params.safeParse(rawParams ?? {});
  if (!parsed.success) return { error: `Invalid parameters: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join(', ')}` };
  const jds = await JobDescription.find({}).select('-conversation -aiRuns');
  return { result: await q.run(parsed.data, jds), params: parsed.data };
}
