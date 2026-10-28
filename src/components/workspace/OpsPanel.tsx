import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, Send, Timer, Route } from 'lucide-react';
import { ReminderDraft, useOpsAsk, useSendReminders, useStuckJds } from '@/hooks/useWorkspace';
import { useToast } from '@/hooks/use-toast';
import { ResultChart } from './agent/ResultChart';

const EXAMPLES = ['Which JDs are stuck waiting on HR?', 'Average approval time by department this quarter', 'Rejection rate by department', 'Weekly throughput for the last 8 weeks', 'How long do reviewers take?', 'How has AI drafting changed edits and cycle time?'];

/** Layer 9 — operations agent: NL → validated query, plus drafted reminders for stuck JDs. */
export default function OpsPanel() {
  const ops = useOpsAsk();
  const [q, setQ] = useState('');
  const [hours, setHours] = useState(48);
  const stuck = useStuckJds(hours);
  const send = useSendReminders();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<(ReminderDraft & { on: boolean })[]>([]);

  useEffect(() => {
    setDrafts((stuck.data?.drafts || []).map((d) => ({ ...d, on: true })));
  }, [stuck.data]);

  const run = (question: string) => {
    if (!question.trim()) return;
    setQ(question);
    ops.mutate(question, { onError: (e: any) => toast({ title: 'Query failed', description: e.message, variant: 'destructive' }) });
  };

  const sendSelected = async () => {
    const chosen = drafts.filter((d) => d.on).map(({ on, ...d }) => d);
    if (!chosen.length) return;
    await send.mutateAsync(chosen);
    toast({ title: 'Reminders sent', description: `${chosen.length} reviewer(s) notified.` });
  };

  return (
    <div className="space-y-6">
      <Card className="card-elevated p-5 space-y-4">
        <div>
          <p className="font-medium">Ask about the pipeline</p>
          <p className="text-xs text-muted-foreground">The ops agent maps your question to one of a fixed set of validated analytics queries — it never writes database queries.</p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(q);
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. average approval time by department this quarter" />
          <Button type="submit" disabled={!q.trim() || ops.isPending} className="gap-1.5">
            {ops.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Run
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <Button key={e} size="sm" variant="outline" className="h-7 text-xs rounded-full" onClick={() => run(e)}>
              {e}
            </Button>
          ))}
        </div>
        {ops.data && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-sm">{ops.data.result.title}</p>
              <Badge variant="outline" className="font-mono text-[10px] gap-1">
                <Route className="h-3 w-3" /> {ops.data.route.query_id}({Object.entries(ops.data.route.params || {}).map(([k, v]) => `${k}=${v}`).join(', ')})
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{ops.data.result.summary}</p>
            <ResultChart result={ops.data.result} />
          </div>
        )}
      </Card>

      <Card className="card-elevated p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium flex items-center gap-1.5">
              <Timer className="h-4 w-4 text-warning" /> Stuck in review
            </p>
            <p className="text-xs text-muted-foreground">Reminders are drafted by the ops agent. Nothing is sent until you confirm.</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            Older than
            <select className="border rounded-md px-2 py-1 bg-background" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[24, 48, 72, 168].map((h) => (
                <option key={h} value={h}>
                  {h < 168 ? `${h}h` : '1 week'}
                </option>
              ))}
            </select>
          </div>
        </div>
        {stuck.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : !drafts.length ? (
          <p className="text-sm text-muted-foreground">Nothing is stuck. 🎉</p>
        ) : (
          <>
            <div className="space-y-2">
              {drafts.map((d, i) => (
                <div key={i} className="flex gap-3 border rounded-lg p-3">
                  <Checkbox checked={d.on} onCheckedChange={(c) => setDrafts((xs) => xs.map((x, j) => (j === i ? { ...x, on: !!c } : x)))} className="mt-1" />
                  <div className="flex-1 space-y-1.5">
                    <p className="text-xs">
                      To <span className="font-medium">{d.to_name}</span> · <span className="text-muted-foreground">{d.subject}</span>
                    </p>
                    <Textarea rows={2} className="text-xs" value={d.message} onChange={(e) => setDrafts((xs) => xs.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} />
                  </div>
                </div>
              ))}
            </div>
            <Button className="gap-1.5" onClick={sendSelected} disabled={send.isPending || !drafts.some((d) => d.on)}>
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send {drafts.filter((d) => d.on).length} reminder(s)
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
