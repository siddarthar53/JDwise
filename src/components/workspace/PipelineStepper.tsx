import React from 'react';
import { Check, X, FileEdit, UserCheck, ShieldCheck } from 'lucide-react';
import { JDStatus } from '@/types';

const STAGES: { key: JDStatus; label: string; icon: React.ReactNode }[] = [
  { key: 'draft', label: 'Draft', icon: <FileEdit className="h-3 w-3" /> },
  { key: 'pending_manager', label: 'Manager', icon: <UserCheck className="h-3 w-3" /> },
  { key: 'pending_hr', label: 'HR', icon: <ShieldCheck className="h-3 w-3" /> },
  { key: 'approved', label: 'Approved', icon: <Check className="h-3 w-3" /> },
];

function stageIndex(status: JDStatus) {
  if (status === 'rejected') return -1;
  return STAGES.findIndex((s) => s.key === status);
}

export function PipelineStepper({ status, compact = false }: { status: JDStatus; compact?: boolean }) {
  const currentIdx = stageIndex(status);
  const rejected = status === 'rejected';

  return (
    <div className="w-full">
      <div className="stage-track">
        {STAGES.map((stage, idx) => {
          const isDone = !rejected && idx < currentIdx;
          const isCurrent = !rejected && idx === currentIdx;
          const isLast = idx === STAGES.length - 1;

          let dotClass = 'stage-dot-pending';
          if (rejected && idx <= 1) dotClass = 'stage-dot-rejected';
          else if (isDone || (isCurrent && stage.key === 'approved')) dotClass = 'stage-dot-done';
          else if (isCurrent) dotClass = 'stage-dot-current';

          return (
            <React.Fragment key={stage.key}>
              <div className="flex flex-col items-center gap-1">
                <div className={`stage-dot ${dotClass}`} title={stage.label}>
                  {stage.icon}
                </div>
                {!compact && <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">{stage.label}</span>}
              </div>
              {!isLast && (
                <div
                  className={`stage-connector ${isDone || (rejected && idx === 0) ? 'stage-connector-done' : 'stage-connector-pending'}`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
      {rejected && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-mono text-destructive">
          <X className="h-3 w-3" /> Rejected — needs changes
        </div>
      )}
    </div>
  );
}
