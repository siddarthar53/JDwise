import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Activity, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAdminMetrics } from '@/hooks/useWorkspace';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
const num = (v: any, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="card-elevated p-4">
      <p className="text-2xl font-display font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {hint && <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>}
    </Card>
  );
}

const BIZ_ROWS: [string, string, string][] = [
  ['jds', 'JDs', ''],
  ['approved', 'Approved', ''],
  ['median_minutes_to_first_draft', 'Median time to first complete draft', ' min'],
  ['avg_text_changed_after_draft_pct', '% of text humans changed after the draft', '%'],
  ['avg_rejection_cycles', 'Avg rejection cycles per submitted JD', ''],
  ['median_submit_to_approve_hours', 'Median submit → approve', ' h'],
  ['first_draft_acceptance_pct', 'First-draft acceptance (approved, <10% edits, no rejections)', '%'],
  ['median_reviewer_hours', 'Median reviewer open → decision', ' h'],
];

/** AI quality & observability: agent run metrics + business KPIs by cohort. */
export default function AiMetricsPanel() {
  const { data, isLoading } = useAdminMetrics(30);
  if (isLoading || !data)
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading metrics…
      </div>
    );
  const a = data.agent;
  return (
    <div className="space-y-6">
      {!data.agentOnline ? (
        <Card className="card-elevated p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <WifiOff className="h-4 w-4" /> The agent service is offline — drafting falls back to the guided question flow. Business metrics below still apply.
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <p className="font-medium">Agent runs (last 30 days)</p>
            <Badge variant="outline" className="font-mono text-[10px]">
              provider: {a.provider}
            </Badge>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Agent runs" value={num(a.runs_total)} hint={Object.entries(a.runs_by_kind || {}).map(([k, v]) => `${k} ${v}`).join(' · ')} />
            <Tile label="Draft success rate" value={pct(a.draft_success_rate)} />
            <Tile label="Escalated to author" value={pct(a.escalation_rate)} hint="Draft runs that paused for human input" />
            <Tile label="Latency p50 / p95" value={`${Math.round(a.latency_ms?.p50 || 0)} / ${Math.round(a.latency_ms?.p95 || 0)} ms`} />
            <Tile label="First-pass schema validity" value={pct(a.first_pass_schema_validity)} />
            <Tile label="Tool error rate" value={pct(a.tool_error_rate)} hint={`${num(a.avg_tool_calls_per_draft)} tool calls / draft`} />
            <Tile label="Fallback rate" value={pct(a.fallback_rate)} hint="Runs that fell back to a smaller model or rules" />
            <Tile label="Cost (total / p95 per run)" value={`$${(a.cost_usd_total || 0).toFixed(3)} / $${(a.cost_usd_per_run_p95 || 0).toFixed(4)}`} hint={`${a.tokens?.input || 0} in · ${a.tokens?.output || 0} out · ${a.tokens?.cache_read || 0} cached`} />
          </div>
        </>
      )}

      <Card className="card-elevated">
        <div className="px-5 py-4 border-b">
          <p className="font-medium">Business impact: AI-drafted vs manual / legacy JDs</p>
          <p className="text-xs text-muted-foreground">Computed from the audit history and content versions. Small samples are noisy — read with care.</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead>AI-drafted</TableHead>
              <TableHead>Manual / legacy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {BIZ_ROWS.map(([k, label, unit]) => (
              <TableRow key={k}>
                <TableCell className="text-sm">{label}</TableCell>
                <TableCell className="font-mono text-xs">{num(data.business.ai[k], unit)}</TableCell>
                <TableCell className="font-mono text-xs">{num(data.business.legacy[k], unit)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {!!data.runs?.length && (
        <Card className="card-elevated">
          <div className="px-5 py-4 border-b">
            <p className="font-medium">Recent runs (traces)</p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Tools</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Prompt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.runs.map((r: any) => (
                  <TableRow key={r._id}>
                    <TableCell className="text-xs">{formatDistanceToNow(new Date(r.created_at * 1000), { addSuffix: true })}</TableCell>
                    <TableCell className="font-mono text-xs">{r.kind}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-mono text-[10px] ${r.status === 'failed' ? 'status-rejected' : r.status === 'needs_input' ? 'status-pending' : 'status-approved'}`}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{Math.round(r.metrics?.latency_ms || 0)} ms</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.metrics?.tool_calls ?? 0}
                      {r.metrics?.tool_errors ? ` (${r.metrics.tool_errors} err)` : ''}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{(r.metrics?.input_tokens || 0) + (r.metrics?.output_tokens || 0)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.prompt_version}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
