import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle2, CircleHelp, Loader2 } from 'lucide-react';
import { RevisionProposal } from '@/types';
import { DiffList } from './DiffList';

export function RevisionDialog({
  proposal,
  open,
  onOpenChange,
  onApply,
  applying,
}: {
  proposal: RevisionProposal | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onApply: () => void;
  applying: boolean;
}) {
  if (!proposal) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Proposed revision</DialogTitle>
          <DialogDescription>
            Reviewer said: <span className="italic">"{proposal.comment}"</span>. Nothing changes until you apply it, and nothing is resubmitted automatically.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh] pr-3">
          <div className="space-y-4">
            {!!proposal.addressed.length && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">How each point is addressed</p>
                {proposal.addressed.map((a, i) => (
                  <p key={i} className="text-xs flex gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" /> {a}
                  </p>
                ))}
              </div>
            )}
            {!!proposal.unresolved.length && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Needs your input</p>
                {proposal.unresolved.map((a, i) => (
                  <p key={i} className="text-xs flex gap-1.5">
                    <CircleHelp className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" /> {a}
                  </p>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Changes</p>
              <DiffList diff={proposal.diff || []} empty="The assistant couldn't map this comment to concrete edits — edit the draft manually." />
            </div>
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Discard
          </Button>
          <Button className="btn-corporate" onClick={onApply} disabled={applying || !(proposal.diff || []).length}>
            {applying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Apply changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
