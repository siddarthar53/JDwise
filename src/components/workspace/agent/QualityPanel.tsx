import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, AlertTriangle, Info, XCircle, Loader2, RefreshCw, Wand2 } from 'lucide-react';
import { Critique, Finding } from '@/types';

const SEV: Record<Finding['severity'], { icon: React.ElementType; cls: string }> = {
  error: { icon: XCircle, cls: 'text-destructive' },
  warning: { icon: AlertTriangle, cls: 'text-warning' },
  info: { icon: Info, cls: 'text-muted-foreground' },
};

function avg(r?: Record<string, number>) {
  if (!r) return null;
  const v = Object.values(r);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
}

export function QualityPanel({
  critique,
  initial,
  fixes,
  onRecheck,
  checking,
}: {
  critique?: Critique | null;
  initial?: Critique | null;
  fixes?: string[];
  onRecheck?: () => void;
  checking?: boolean;
}) {
  const score = avg(critique?.rubric);
  const before = avg(initial?.rubric);
  const findings = (critique?.findings || []).filter((f) => f.severity !== 'info');
  return (
    <Card className="card-elevated p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-primary" /> Quality & compliance
        </p>
        {onRecheck && (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onRecheck} disabled={checking}>
            {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Re-check
          </Button>
        )}
      </div>
      {!critique ? (
        <p className="text-xs text-muted-foreground">Run a check to score this draft against the style guide, pay-transparency and inclusive-language rules.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-display font-semibold">{score ?? '—'}</span>
            <span className="text-xs text-muted-foreground">/ 5 rubric average</span>
            {before !== null && score !== null && before !== score && (
              <Badge variant="outline" className="text-[10px] font-mono status-approved">
                {before} → {score}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {Object.entries(critique.rubric || {}).map(([k, v]) => (
              <div key={k} className="space-y-1" title={`${k}: ${v}/5`}>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full ${v >= 4 ? 'bg-success' : v >= 3 ? 'bg-warning' : 'bg-destructive'}`} style={{ width: `${(v / 5) * 100}%` }} />
                </div>
                <p className="text-[9px] font-mono text-muted-foreground capitalize truncate">{k}</p>
              </div>
            ))}
          </div>
          {!!fixes?.length && (
            <div className="text-xs rounded-md bg-success/10 text-success px-2.5 py-2 flex gap-1.5">
              <Wand2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>Auto-fixed before you saw it: {Array.from(new Set(fixes)).join('; ')}</span>
            </div>
          )}
          {findings.length === 0 ? (
            <p className="text-xs text-success">No open issues.</p>
          ) : (
            <ul className="space-y-1.5">
              {findings.slice(0, 6).map((f, i) => {
                const S = SEV[f.severity];
                return (
                  <li key={i} className="text-xs flex gap-1.5">
                    <S.icon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${S.cls}`} />
                    <span>
                      {f.message}
                      {f.suggested_fix && <span className="text-muted-foreground"> {f.suggested_fix}</span>}
                      {f.source === 'llm' && <span className="ml-1 font-mono text-[9px] text-muted-foreground">AI</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
