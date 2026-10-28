// Legacy rule-based JD question flow (Baseline v0).
//
// The agentic drafting pipeline lives in the Python agent service (agent/).
// This deterministic flow is kept as the *final fallback*: if AGENT_URL is not
// configured or the agent service is unreachable, the app keeps working with
// the original 7-question script. It is also what the eval harness measures as
// the baseline (agent/evals/baseline_v0.py mirrors it).

import { IJobDescription } from '../models/JobDescription';

export interface AgentStepResult {
  reply: string;
  nextStep: number;
  patch: Partial<{
    title: string;
    department: string;
    employmentType: string;
    summary: string;
    responsibilities: string[];
    qualifications: string[];
    skills: string[];
    salaryRange: string;
  }>;
  done: boolean;
}

export const LEGACY_STEPS = [
  "Let's build your job description together. What is the job title?",
  'Which department or team is this role part of?',
  'Give me a 2-3 sentence summary of what this role is responsible for overall.',
  'List the main day-to-day responsibilities, separated by commas or new lines.',
  'What qualifications or experience should candidates have? (comma or newline separated)',
  'Any key skills to highlight? (comma or newline separated)',
  "Last one - what's the salary range or employment type (e.g. Full-time, $90k-$110k)? You can also say 'skip'.",
];

export const AGENT_OPENER =
  "Hi! Tell me about the role you're hiring for — a one-line brief, a pasted Slack message, or an old JD you want adapted (\"same as this but Senior\"). I'll only ask about what's missing, draft it from similar approved JDs, check it against our style and compliance rules, and flag anything you should confirm.";

function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function firstPrompt(): string {
  return LEGACY_STEPS[0];
}

export function processAnswer(step: number, userText: string): AgentStepResult {
  const patch: AgentStepResult['patch'] = {};
  const text = userText.trim();

  switch (step) {
    case 0:
      patch.title = text;
      break;
    case 1:
      patch.department = text;
      break;
    case 2:
      patch.summary = text;
      break;
    case 3:
      patch.responsibilities = splitList(text);
      break;
    case 4:
      patch.qualifications = splitList(text);
      break;
    case 5:
      patch.skills = splitList(text);
      break;
    case 6:
      if (!/^skip$/i.test(text)) {
        if (/[$₹£€]|\d/.test(text)) patch.salaryRange = text;
        else patch.employmentType = text;
      }
      break;
    default:
      break;
  }

  const nextStep = step + 1;
  const done = nextStep >= LEGACY_STEPS.length;

  const reply = done
    ? "Great, I've drafted your job description from our conversation. You can review and edit every section before submitting it for approval."
    : LEGACY_STEPS[nextStep];

  return { reply, nextStep, patch, done };
}

export function summarizeDraft(
  jd: Pick<IJobDescription, 'title' | 'department' | 'summary' | 'responsibilities' | 'qualifications' | 'skills' | 'employmentType'>,
): string {
  const lines = [
    `**${jd.title || 'Untitled role'}** — ${jd.department || 'Unassigned department'} (${jd.employmentType || 'Full-time'})`,
    '',
    jd.summary || 'No summary yet.',
    '',
    '**Responsibilities**',
    ...(jd.responsibilities.length ? jd.responsibilities.map((r) => `- ${r}`) : ['- (none yet)']),
    '',
    '**Qualifications**',
    ...(jd.qualifications.length ? jd.qualifications.map((q) => `- ${q}`) : ['- (none yet)']),
    '',
    '**Skills**',
    ...(jd.skills.length ? jd.skills.map((s) => `- ${s}`) : ['- (none yet)']),
  ];
  return lines.join('\n');
}
