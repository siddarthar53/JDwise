import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, AlertTriangle, XCircle, GitCompare, MessageSquarePlus } from 'lucide-react';
import { useCopilot } from '@/hooks/useJDs';

const REC: Record<string, { label: string; cls: string }> = {
  approve: { label: 'No material risks', cls: 'status-approved' },
  needs_discussion: { label: 'Worth a discussion', cls: 'status-pending' },
  request_changes: { label: 'Changes likely needed', cls: 'status-rejected' },
};

/** Layer 6 — reviewer copilot. Advisory only: the reviewer still decides. */
export function CopilotPanel({ jdId, onUseComment }: { jdId: string; onUseComment?: (c: string) => void }) {
  const { data, isLoading, error } = useCopilot(jdId, true);
  if (isLoading)
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Copilot is reviewing…
      </div>
    );
  if (error || !data) return <p className="text-xs text-muted-foreground">Copilot unavailable — review manually.</p>;
  const rec = REC[data.recommendation];
  return (
    <div className="rounded-lg border bg-primary/[0.03] p-3 space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> Review copilot
        </p>
        <Badge variant="outline" className={`font-mono text-[10px] ${rec?.cls}`}>
          {rec?.label}
        </Badge>
      </div>
      <p>{data.summary}</p>
      {!!data.changes.length && (
        <div className="space-y-1">
          <p className="font-medium flex items-center gap-1">
            <GitCompare className="h-3 w-3" /> Changed since last submission
          </p>
          <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
            {data.changes.slice(0, 8).map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {!!data.risks.length && (
        <div className="space-y-1">
          <p className="font-medium">Risks</p>
          {data.risks.map((r, i) => (
            <p key={i} className="flex gap-1.5">
              {r.severity === 'error' ? <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />}
              <span>{r.message}</span>
            </p>
          ))}
        </div>
      )}
      {!!data.suggested_comments.length && onUseComment && (
        <div className="space-y-1">
          <p className="font-medium">Suggested comments</p>
          {data.suggested_comments.map((c, i) => (
            <Button key={i} variant="ghost" className="h-auto w-full justify-start text-left text-xs whitespace-normal py-1.5 px-2 gap-1.5" onClick={() => onUseComment(c)}>
              <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" /> {c}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
