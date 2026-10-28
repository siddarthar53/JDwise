import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { useVersions } from '@/hooks/useJDs';
import { diffFields } from '@/lib/diff';
import { DiffList } from './DiffList';

const ORIGIN_LABEL: Record<string, string> = { ai_draft: 'AI draft', submission: 'Submitted', revision: 'AI revision applied', manual: 'Manual draft' };

export function VersionHistory({ jdId, open, onOpenChange }: { jdId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = useVersions(jdId, open);
  const [sel, setSel] = useState<number | null>(null);
  const versions = data || [];
  const idx = sel ?? versions.length - 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>Every AI draft, revision and submission is snapshotted. Select a version to see what changed from the one before.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !versions.length ? (
          <p className="text-sm text-muted-foreground">No versions yet.</p>
        ) : (
          <div className="grid grid-cols-[200px_1fr] gap-4">
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-1">
                {versions.map((v, i) => (
                  <button
                    key={i}
                    onClick={() => setSel(i)}
                    className={`w-full text-left rounded-md px-2.5 py-2 text-xs border ${i === idx ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted'}`}
                  >
                    <p className="font-medium">v{v.version} · {ORIGIN_LABEL[v.origin] || v.origin}</p>
                    <p className="text-muted-foreground font-mono text-[10px]">{format(new Date(v.at), 'MMM d, HH:mm')}</p>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <ScrollArea className="max-h-[60vh] pr-3">
              <div className="space-y-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  {idx === 0 ? 'first version' : `changes since v${versions[idx - 1].version}`}
                </Badge>
                <DiffList diff={idx === 0 ? [] : diffFields(versions[idx - 1].fields as any, versions[idx].fields as any)} empty={idx === 0 ? 'This is the first snapshot.' : 'No content changes.'} />
              </div>
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
