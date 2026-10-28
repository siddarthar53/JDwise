import { DiffEntry } from '@/types';

const SCALARS = ['title', 'department', 'level', 'employmentType', 'location', 'workMode', 'salaryRange', 'summary'];
const LISTS = ['responsibilities', 'qualifications', 'skills', 'benefits'];

export function diffFields(prev: Record<string, any> | null | undefined, cur: Record<string, any> | null | undefined): DiffEntry[] {
  if (!prev || !cur) return [];
  const out: DiffEntry[] = [];
  SCALARS.forEach((f) => {
    const a = (prev[f] ?? '') as string;
    const b = (cur[f] ?? '') as string;
    if (a !== b) out.push({ field: f, type: 'changed', before: a, after: b });
  });
  LISTS.forEach((f) => {
    const a: string[] = prev[f] || [];
    const b: string[] = cur[f] || [];
    b.filter((x) => !a.includes(x)).forEach((x) => out.push({ field: f, type: 'added', after: x }));
    a.filter((x) => !b.includes(x)).forEach((x) => out.push({ field: f, type: 'removed', before: x }));
  });
  return out;
}

export const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  department: 'Department',
  level: 'Level',
  employmentType: 'Employment type',
  location: 'Location',
  workMode: 'Work mode',
  salaryRange: 'Salary',
  summary: 'Summary',
  responsibilities: 'Responsibilities',
  qualifications: 'Qualifications',
  skills: 'Skills',
  benefits: 'Benefits',
};
