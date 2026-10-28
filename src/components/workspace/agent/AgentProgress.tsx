import React from 'react';
import { Loader2, Check, Search, Wrench, PenLine, ShieldCheck, Route, MessageSquareReply, Brain, AlertTriangle, Sparkles } from 'lucide-react';
import { RunEvent } from '@/types';

const STEP_META: Record<string, { label: string; icon: React.ElementType }> = {
  resume: { label: 'Reading your reply', icon: MessageSquareReply },
  intake: { label: 'Understanding the brief', icon: Brain },
  retrieve: { label: 'Searching approved JDs & style guide', icon: Search },
  tools: { label: 'Checking salary band, duplicates & skills', icon: Wrench },
  generate: { label: 'Drafting the JD', icon: PenLine },
  critic: { label: 'Reviewer pass (quality & compliance)', icon: ShieldCheck },
  revise: { label: 'Fixing flagged issues', icon: Sparkles },
  route: { label: 'Deciding what needs your input', icon: Route },
  human: { label: 'Applying your answer', icon: MessageSquareReply },
  guard: { label: 'Safety check', icon: ShieldCheck },
  budget: { label: 'Budget check', icon: AlertTriangle },
  error: { label: 'Error', icon: AlertTriangle },
};

export function AgentProgress({ events, done }: { events: RunEvent[]; done: boolean }) {
  const shown = events.filter((e) => STEP_META[e.step]);
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-1.5 text-xs">
      {shown.length === 0 && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting the drafting agent…
        </div>
      )}
      {shown.map((e, i) => {
        const meta = STEP_META[e.step];
        const Icon = meta.icon;
        const last = i === shown.length - 1 && !done;
        return (
          <div key={i} className="flex items-start gap-2">
            <span className={`mt-0.5 h-4 w-4 rounded-full flex items-center justify-center shrink-0 ${e.step === 'error' ? 'bg-destructive/15 text-destructive' : last ? 'bg-primary/15 text-primary' : 'bg-success/15 text-success'}`}>
              {last ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : e.step === 'error' ? <AlertTriangle className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5" />}
            </span>
            <div className="min-w-0">
              <p className="font-medium flex items-center gap-1.5">
                <Icon className="h-3 w-3 text-muted-foreground" /> {meta.label}
              </p>
              <p className="text-muted-foreground truncate" title={e.message}>
                {e.message}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
