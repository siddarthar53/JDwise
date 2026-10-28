/** Text-change metrics used for "human edits after generation". */

export function jdText(fields: Record<string, any> | null | undefined): string {
  if (!fields) return '';
  const parts = [
    fields.title,
    fields.summary,
    ...(fields.responsibilities || []),
    ...(fields.qualifications || []),
    ...(fields.skills || []),
    fields.salaryRange,
  ];
  return parts.filter(Boolean).join('\n');
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9+#.]+/g) || [];
}

/** Word-level Levenshtein distance (O(n*m), fine for JD-sized text). */
export function wordEditDistance(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = new Array(y.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** Share of the final text that differs from the draft (0 = untouched, 1 = rewritten). */
export function changeRatio(draft: Record<string, any> | null | undefined, final: Record<string, any> | null | undefined): number | null {
  if (!draft || !final) return null;
  const a = jdText(draft);
  const b = jdText(final);
  const denom = Math.max(words(a).length, words(b).length, 1);
  return Math.round((wordEditDistance(a, b) / denom) * 1000) / 1000;
}
