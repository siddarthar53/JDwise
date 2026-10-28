import React from 'react';
import { DiffEntry } from '@/types';
import { FIELD_LABELS } from '@/lib/diff';

export function DiffList({ diff, empty = 'No content changes.' }: { diff: DiffEntry[]; empty?: string }) {
  if (!diff.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-xs">
      {diff.map((d, i) => (
        <li key={i} className="rounded-md border px-2.5 py-1.5">
          <span className="font-mono text-[10px] uppercase text-muted-foreground mr-1.5">{FIELD_LABELS[d.field] || d.field}</span>
          {d.type === 'changed' && (
            <span>
              <span className="line-through text-destructive/80">{d.before || '—'}</span> <span className="text-muted-foreground">→</span>{' '}
              <span className="text-success">{d.after || '—'}</span>
            </span>
          )}
          {d.type === 'added' && <span className="text-success">+ {d.after}</span>}
          {d.type === 'removed' && <span className="text-destructive/80 line-through">− {d.before}</span>}
        </li>
      ))}
    </ul>
  );
}
