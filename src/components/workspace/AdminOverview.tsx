import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, CheckCircle, Clock, AlertTriangle, Send, Loader2 } from 'lucide-react';
import { useAdminOverview, useSendReminder } from '@/hooks/useWorkspace';
import { useToast } from '@/hooks/use-toast';
import { StatusBadge } from './StatusBadge';
import { formatDistanceToNow } from 'date-fns';

const STAT_CARDS = [
  { key: 'total', label: 'Employees', icon: Users, tone: 'text-primary bg-primary/10' },
  { key: 'completed', label: 'Approved', icon: CheckCircle, tone: 'text-success bg-success/10' },
  { key: 'inProgress', label: 'In progress', icon: Clock, tone: 'text-warning bg-warning/10' },
  { key: 'notStarted', label: 'Not started', icon: AlertTriangle, tone: 'text-destructive bg-destructive/10' },
] as const;

export default function AdminOverview() {
  const { data, isLoading } = useAdminOverview();
  const remind = useSendReminder();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>([]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading company overview…
      </div>
    );
  }

  const toggleAll = (checked: boolean) => {
    const remindable = data.employees.filter((e) => e.status !== 'approved').map((e) => e.id);
    setSelected(checked ? remindable : []);
  };

  const handleRemind = async () => {
    if (!selected.length) return;
    await remind.mutateAsync({ userIds: selected, message: 'Please complete and submit your job description.' });
    toast({ title: 'Reminders sent', description: `Nudged ${selected.length} employee(s).` });
    setSelected([]);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STAT_CARDS.map(({ key, label, icon: Icon, tone }) => (
          <Card key={key} className="card-elevated p-4">
            <div className={`h-9 w-9 rounded-lg flex items-center justify-center mb-3 ${tone}`}>
              <Icon className="h-4.5 w-4.5" />
            </div>
            <p className="text-2xl font-display font-semibold">{(data.counts as any)[key]}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </Card>
        ))}
      </div>

      <Card className="card-elevated">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <p className="font-medium">JD completion by employee</p>
            <p className="text-xs text-muted-foreground">Track progress and nudge anyone who's stalled.</p>
          </div>
          <Button size="sm" variant="secondary" className="gap-1.5" disabled={!selected.length || remind.isPending} onClick={handleRemind}>
            {remind.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Remind {selected.length || ''}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={selected.length > 0 && selected.length === data.employees.filter((e) => e.status !== 'approved').length}
                  onCheckedChange={(c) => toggleAll(!!c)}
                />
              </TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Manager</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.employees.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Checkbox
                    checked={selected.includes(e.id)}
                    disabled={e.status === 'approved'}
                    onCheckedChange={(c) =>
                      setSelected((prev) => (c ? [...prev, e.id] : prev.filter((id) => id !== e.id)))
                    }
                  />
                </TableCell>
                <TableCell>
                  <p className="font-medium">{e.name}</p>
                  <p className="text-xs text-muted-foreground">{e.email}</p>
                </TableCell>
                <TableCell>{e.department}</TableCell>
                <TableCell>{e.reportingManager}</TableCell>
                <TableCell>
                  <StatusBadge status={e.status} />
                </TableCell>
                <TableCell className="w-36">
                  <div className="flex items-center gap-2">
                    <Progress value={e.progress} className="h-1.5" />
                    <span className="text-xs text-muted-foreground font-mono">{e.progress}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {e.lastActivity ? formatDistanceToNow(new Date(e.lastActivity), { addSuffix: true }) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
