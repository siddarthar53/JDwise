import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { AiMeta, Bullet } from '@/types';

const ORIGIN: Record<Bullet['origin'], { label: string; cls: string }> = {
  brief: { label: 'your brief', cls: 'bg-primary/10 text-primary border-primary/20' },
  retrieved: { label: 'cited', cls: 'status-approved' },
  tool: { label: 'tool', cls: 'status-pending' },
  memory: { label: 'learned', cls: 'status-pending' },
  generated: { label: 'generated', cls: 'bg-muted text-muted-foreground' },
};

/** Shows where every drafted bullet came from (the groundedness view). */
export function EvidencePanel({ meta, current }: { meta?: AiMeta; current: { responsibilities: string[]; qualifications: string[] } }) {
  const [open, setOpen] = useState(false);
  const sources = new Map((meta?.sources || []).map((s) => [s.id, s]));
  const sections = (['responsibilities', 'qualifications'] as const).map((sec) => ({
    sec,
    bullets: (meta?.bullets?.[sec] || []).filter((b) => current[sec].includes(b.text)),
  }));
  const total = sections.reduce((n, s) => n + s.bullets.length, 0);
  if (!total) return null;
  const cited = sections.reduce((n, s) => n + s.bullets.filter((b) => b.citations?.length).length, 0);
  return (
    <Card className="card-elevated p-4 space-y-2">
      <button className="w-full flex items-center justify-between text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <span className="flex items-center gap-1.5">
          <BookOpen className="h-4 w-4 text-primary" /> Evidence
          <span className="text-xs font-normal text-muted-foreground">
            {cited}/{total} bullets cite a source
          </span>
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <TooltipProvider delayDuration={150}>
          <div className="space-y-3 pt-1">
            {sections.map(({ sec, bullets }) =>
              bullets.length ? (
                <div key={sec} className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide font-mono text-muted-foreground">{sec}</p>
                  {bullets.map((b, i) => (
                    <div key={i} className="text-xs flex items-start gap-1.5">
                      <Badge variant="outline" className={`text-[9px] font-mono shrink-0 ${ORIGIN[b.origin]?.cls}`}>
                        {ORIGIN[b.origin]?.label || b.origin}
                      </Badge>
                      <span className="flex-1">
                        {b.text}
                        {b.citations?.map((c) => {
                          const s = sources.get(c);
                          return s ? (
                            <Tooltip key={c}>
                              <TooltipTrigger asChild>
                                <span className="ml-1 cursor-help underline decoration-dotted text-primary">[{s.doc_type === 'library' ? 'library' : s.doc_type === 'style' ? 'style' : 'JD'}]</span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p className="font-medium text-xs">{s.title}</p>
                                <p className="text-xs text-muted-foreground">{s.text}</p>
                              </TooltipContent>
                            </Tooltip>
                          ) : null;
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null,
            )}
          </div>
        </TooltipProvider>
      )}
    </Card>
  );
}
