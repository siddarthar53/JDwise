import React from 'react';

/** Minimal, safe markdown for assistant messages: **bold**, lists, paragraphs. No HTML injection. */
function inline(text: string, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={`${key}-${i}`} className="font-semibold">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <React.Fragment key={`${key}-${i}`}>{p}</React.Fragment>
    ),
  );
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className={`space-y-2 ${className}`}>
      {blocks.flatMap((block, bi) => {
        if (block.trim() === '---') return [<hr key={bi} className="border-border" />];
        // split a block into runs of plain lines and list lines
        const runs: { list: boolean; ordered: boolean; lines: string[] }[] = [];
        block.split('\n').forEach((l) => {
          const isList = /^\s*(-|\*|\d+\.)\s+/.test(l);
          const ordered = /^\s*\d+\./.test(l);
          const last = runs[runs.length - 1];
          if (last && last.list === isList && (!isList || last.ordered === ordered)) last.lines.push(l);
          else runs.push({ list: isList, ordered, lines: [l] });
        });
        return runs.map((r, ri) => {
          const key = `${bi}-${ri}`;
          if (r.list) {
            const List = r.ordered ? 'ol' : 'ul';
            return (
              <List key={key} className={`${r.ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-0.5`}>
                {r.lines.map((l, i) => (
                  <li key={i}>{inline(l.replace(/^\s*(-|\*|\d+\.)\s+/, ''), `${key}-${i}`)}</li>
                ))}
              </List>
            );
          }
          return (
            <p key={key} className="whitespace-pre-wrap">
              {r.lines.map((l, i) => (
                <React.Fragment key={i}>
                  {inline(l, `${key}-${i}`)}
                  {i < r.lines.length - 1 && <br />}
                </React.Fragment>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}
