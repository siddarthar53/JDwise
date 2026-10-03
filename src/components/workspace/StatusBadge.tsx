import React from 'react';
import { Badge } from '@/components/ui/badge';
import { JDStatus } from '@/types';

const LABELS: Record<string, string> = {
  draft: 'Draft',
  pending_manager: 'Awaiting manager',
  pending_hr: 'Awaiting HR',
  approved: 'Approved',
  rejected: 'Rejected',
  not_started: 'Not started',
};

const CLASSES: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  pending_manager: 'status-pending',
  pending_hr: 'status-pending',
  approved: 'status-approved',
  rejected: 'status-rejected',
  not_started: 'bg-muted text-muted-foreground border-border',
};

export function StatusBadge({ status }: { status: JDStatus | 'not_started' }) {
  return (
    <Badge variant="outline" className={`font-mono text-[11px] ${CLASSES[status] || ''}`}>
      {LABELS[status] || status}
    </Badge>
  );
}
