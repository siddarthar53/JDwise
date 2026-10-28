/**
 * Layer 10 — memory & personalisation.
 * - Explicit: per-user tone and benefits boilerplate (Settings → Preferences).
 * - Learned: when a JD is approved, skills that humans added on top of the
 *   first AI draft are counted per department; skills added twice or more are
 *   suggested on future drafts for that department.
 */
import Preference from '../models/Preference';
import { IJobDescription } from '../models/JobDescription';

export async function getPrefsFor(userId: string, department: string) {
  const [user, dept] = await Promise.all([
    Preference.findOne({ scope: 'user', key: userId }),
    department ? Preference.findOne({ scope: 'department', key: department.toLowerCase() }) : null,
  ]);
  const learned = (dept?.learnedSkills || []).filter((s) => s.count >= 2).sort((a, b) => b.count - a.count).map((s) => s.skill);
  return {
    tone: user?.tone || 'friendly',
    benefits: user?.benefits || [],
    learnedSkills: learned.slice(0, 5),
  };
}

export async function learnFromApproval(jd: IJobDescription) {
  const first = jd.firstAiDraft as any;
  if (!first || !jd.department) return;
  const before = new Set<string>((first.skills || []).map((s: string) => s.toLowerCase()));
  const added = (jd.skills || []).filter((s) => !before.has(s.toLowerCase()));
  if (!added.length) return;
  const key = jd.department.toLowerCase();
  const pref = (await Preference.findOne({ scope: 'department', key })) || new Preference({ scope: 'department', key, learnedSkills: [] });
  for (const skill of added) {
    const e = pref.learnedSkills.find((x) => x.skill.toLowerCase() === skill.toLowerCase());
    if (e) e.count += 1;
    else pref.learnedSkills.push({ skill, count: 1 });
  }
  await pref.save();
}
