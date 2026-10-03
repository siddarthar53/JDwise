// Rule-based JD-building assistant. Deterministically walks a user through a
// question flow and fills in a JobDescription draft as they answer.
// If ANTHROPIC_API_KEY is set, replies are additionally polished by calling
// the real Anthropic API (optional, see server/.env.example).

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

const STEPS = [
  "Let's build your job description together. What is the job title?",
  'Which department or team is this role part of?',
  'Give me a 2-3 sentence summary of what this role is responsible for overall.',
  'List the main day-to-day responsibilities, separated by commas or new lines.',
  'What qualifications or experience should candidates have? (comma or newline separated)',
  'Any key skills to highlight? (comma or newline separated)',
  "Last one - what's the salary range or employment type (e.g. Full-time, $90k-$110k)? You can also say 'skip'.",
];

function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function firstPrompt(): string {
  return STEPS[0];
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
        patch.employmentType = text;
      }
      break;
    default:
      break;
  }

  const nextStep = step + 1;
  const done = nextStep >= STEPS.length;

  const reply = done
    ? "Great, I've drafted your job description from our conversation. You can review and edit every section before submitting it for approval."
    : STEPS[nextStep];

  return { reply, nextStep, patch, done };
}

export function summarizeDraft(jd: Pick<IJobDescription, 'title' | 'department' | 'summary' | 'responsibilities' | 'qualifications' | 'skills' | 'employmentType'>): string {
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

export async function polishWithAnthropic(rawSummary: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: `Polish this rough job-description draft into clear, professional prose. Keep the same sections and facts, do not invent new requirements:\n\n${rawSummary}`,
          },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = (data.content || []).find((c: any) => c.type === 'text')?.text;
    return text || null;
  } catch {
    return null;
  }
}
