import React, { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { CheckCircle2, XCircle, Inbox, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/context/AuthContext';
import { useApproveJD, useJDs, usePeerRespond, useRejectJD } from '@/hooks/useJDs';
import { StatusBadge } from './StatusBadge';
import { PipelineStepper } from './PipelineStepper';
import { JobDescription } from '@/types';

function authorName(jd: JobDescription) {
  return typeof jd.createdBy === 'string' ? jd.createdBy : jd.createdBy.name;
}

type Mode = 'hr' | 'manager' | 'peer';

export default function ApprovalsList({ mode }: { mode: Mode }) {
  const { user } = useAuth();
  const { data: jds, isLoading } = useJDs();
  const approve = useApproveJD();
  const reject = useRejectJD();
  const peerRespond = usePeerRespond();
  const { toast } = useToast();

  const [target, setTarget] = useState<JobDescription | null>(null);
  const [action, setAction] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');

  const relevant = useMemo(() => {
    if (!jds) return [];
    if (mode === 'hr') return jds.filter((j) => j.status === 'pending_hr');
    if (mode === 'manager') return jds.filter((j) => j.status === 'pending_manager');
    return jds.filter((j) => j.peerApprovals.some((p) => (typeof p.user === 'string' ? p.user : p.user.id) === user?.id));
  }, [jds, mode, user]);

  const myPending = (jd: JobDescription) =>
    jd.peerApprovals.find((p) => (typeof p.user === 'string' ? p.user : p.user.id) === user?.id);

  const openDialog = (jd: JobDescription, act: 'approve' | 'reject') => {
    setTarget(jd);
    setAction(act);
    setComment('');
  };

  const confirm = async () => {
    if (!target || !action) return;
    try {
      if (mode === 'peer') {
        await peerRespond.mutateAsync({ id: target._id, status: action === 'approve' ? 'approved' : 'rejected', comment });
      } else if (action === 'approve') {
        await approve.mutateAsync({ id: target._id, comment });
      } else {
        await reject.mutateAsync({ id: target._id, comment });
      }
      toast({ title: action === 'approve' ? 'Approved' : 'Sent back for changes', description: `"${target.title}"` });
      setTarget(null);
    } catch (err: any) {
      toast({ title: 'Something went wrong', description: err.message, variant: 'destructive' });
    }
  };

  const busy = approve.isPending || reject.isPending || peerRespond.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading approvals…
      </div>
    );
  }

  if (!relevant.length) {
    return (
      <Card className="card-elevated flex flex-col items-center justify-center py-20 text-center gap-2">
        <Inbox className="h-10 w-10 text-muted-foreground/40" />
        <p className="font-medium">Nothing waiting on you</p>
        <p className="text-sm text-muted-foreground">New requests will show up here as soon as they arrive.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {relevant.map((jd) => {
        const peerEntry = mode === 'peer' ? myPending(jd) : null;
        const peerAlreadyResponded = peerEntry && peerEntry.status !== 'pending';

        return (
          <Card key={jd._id} className="card-elevated p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium">{jd.title || 'Untitled role'}</p>
                  <StatusBadge status={jd.status} />
                  {peerEntry && (
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {peerEntry.type}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {authorName(jd)} · {jd.department || 'No department'}
                </p>
                {jd.summary && <p className="text-sm mt-2 line-clamp-2 text-foreground/80">{jd.summary}</p>}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {mode === 'peer' ? (
                  peerAlreadyResponded ? (
                    <Badge variant="outline" className={peerEntry?.status === 'approved' ? 'status-approved' : 'status-rejected'}>
                      You {peerEntry?.status}
                    </Badge>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openDialog(jd, 'reject')}>
                        <XCircle className="h-4 w-4" /> Decline
                      </Button>
                      <Button size="sm" className="gap-1.5 btn-corporate" onClick={() => openDialog(jd, 'approve')}>
                        <CheckCircle2 className="h-4 w-4" /> Respond
                      </Button>
                    </>
                  )
                ) : (
                  <>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openDialog(jd, 'reject')}>
                      <XCircle className="h-4 w-4" /> Reject
                    </Button>
                    <Button size="sm" className="gap-1.5 btn-corporate" onClick={() => openDialog(jd, 'approve')}>
                      <CheckCircle2 className="h-4 w-4" /> Approve
                    </Button>
                  </>
                )}
              </div>
            </div>
            <div className="mt-4">
              <PipelineStepper status={jd.status} compact />
            </div>
          </Card>
        );
      })}

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === 'approve' ? 'Approve' : 'Send back'} "{target?.title}"
            </DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder={action === 'approve' ? 'Optional note…' : 'Let them know what to change…'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={busy} className={action === 'approve' ? 'btn-corporate' : ''} variant={action === 'approve' ? 'default' : 'destructive'}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
