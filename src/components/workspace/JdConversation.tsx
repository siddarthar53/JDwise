import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Send,
  Bot,
  User as UserIcon,
  AtSign,
  Sparkles,
  Loader2,
  MoreHorizontal,
  History,
  RotateCcw,
  SlidersHorizontal,
  MessageCircleQuestion,
  Wand2,
  AlertCircle,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/context/AuthContext';
import {
  useAgentMessage,
  useAgentRun,
  useApplyRevision,
  useCreateJD,
  useCritique,
  useJDs,
  useMentionPeers,
  useResetThread,
  useRevise,
  useSubmitJD,
  useUpdateJD,
} from '@/hooks/useJDs';
import { useDirectory } from '@/hooks/useWorkspace';
import { PipelineStepper } from './PipelineStepper';
import { StatusBadge } from './StatusBadge';
import { JobDescription, RevisionProposal } from '@/types';
import { Markdown } from './agent/Markdown';
import { AgentProgress } from './agent/AgentProgress';
import { QualityPanel } from './agent/QualityPanel';
import { EvidencePanel } from './agent/EvidencePanel';
import { RevisionDialog } from './agent/RevisionDialog';
import { VersionHistory } from './agent/VersionHistory';
import { PreferencesDialog } from './agent/PreferencesDialog';

const LEGACY_STEPS = 7;
const LEVELS = ['', 'intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director'];
const MODES = ['', 'onsite', 'hybrid', 'remote'];

function listToText(list: string[] = []) {
  return list.join('\n');
}
function textToList(text: string) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
function authorId(jd: JobDescription) {
  return typeof jd.createdBy === 'string' ? jd.createdBy : jd.createdBy.id || (jd.createdBy as any)._id;
}
function lastRejection(jd: JobDescription): string | null {
  for (let i = jd.history.length - 1; i >= 0; i--) {
    if (jd.history[i].action === 'rejected') return jd.history[i].comment || '';
    if (['submitted', 'resubmitted'].includes(jd.history[i].action)) return null;
  }
  return null;
}

export default function JdConversation() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: jds, isLoading: loadingJds } = useJDs();
  const { data: directory } = useDirectory();
  const createJd = useCreateJD();
  const agentMessage = useAgentMessage();
  const updateJd = useUpdateJD();
  const submitJd = useSubmitJD();
  const mentionPeers = useMentionPeers();
  const critique = useCritique();
  const resetThread = useResetThread();
  const revise = useRevise();
  const applyRevision = useApplyRevision();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [mentionType, setMentionType] = useState<'approval' | 'feedback' | 'collaboration'>('feedback');
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [proposal, setProposal] = useState<RevisionProposal | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const myDrafts = useMemo(() => (jds || []).filter((j) => authorId(j) === user?.id), [jds, user]);

  useEffect(() => {
    if (!loadingJds && myDrafts.length && !activeId) {
      const open = myDrafts.find((j) => j.status === 'draft' || j.status === 'rejected') || myDrafts[0];
      setActiveId(open._id);
    }
  }, [loadingJds, myDrafts, activeId]);

  const active = myDrafts.find((j) => j._id === activeId) || null;

  // resume watching a run that was in flight when the page loaded
  useEffect(() => {
    if (active?.agentState === 'running' && active.activeRunId) setRunId(active.activeRunId);
    if (active && active.agentState !== 'running' && !agentMessage.isPending) setRunId(null);
  }, [active?._id, active?.agentState, active?.activeRunId]);

  const { data: runData } = useAgentRun(active?._id, runId);
  useEffect(() => {
    if (runData?.applied) setRunId(null);
  }, [runData?.applied]);

  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    (el || scrollRef.current)?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [active?.conversation.length, runData?.run.events.length]);

  const [fields, setFields] = useState<Partial<JobDescription> | null>(null);
  useEffect(() => {
    if (active) {
      setFields({
        title: active.title,
        department: active.department,
        level: active.level || '',
        employmentType: active.employmentType,
        location: active.location || '',
        workMode: active.workMode || '',
        salaryRange: active.salaryRange || '',
        summary: active.summary,
        responsibilities: active.responsibilities,
        qualifications: active.qualifications,
        skills: active.skills,
      });
    }
  }, [active?._id, active?.updatedAt]);

  const legacy = active?.agentState === 'legacy';
  const running = !!runId || active?.agentState === 'running' || agentMessage.isPending;
  const isEditable = active?.status === 'draft' || active?.status === 'rejected';
  const hasContent = !!active && !!active.title && active.title !== 'Untitled Job Description' && !!active.summary && active.responsibilities.length > 0;
  const legacyDone = legacy && (active?.conversationStep || 0) >= LEGACY_STEPS;
  const rejection = active?.status === 'rejected' ? lastRejection(active) : null;
  const meta = active?.aiMeta;
  const conf = meta?.confidence || {};
  const questions = active?.agentState === 'needs_input' ? meta?.reviewQuestions || [] : [];

  const handleStartNew = async () => {
    const jd = await createJd.mutateAsync();
    setActiveId(jd._id);
    setRunId(null);
  };

  const send = async (text: string) => {
    if (!active || !text.trim() || running) return;
    setDraftText('');
    try {
      const res = await agentMessage.mutateAsync({ id: active._id, message: text });
      if (res.runId) setRunId(res.runId);
    } catch (err: any) {
      toast({ title: 'Message not sent', description: err.message, variant: 'destructive' });
      setDraftText(text);
    }
  };

  const handleSaveField = (patch: Partial<JobDescription>) => {
    if (!active || !isEditable) return;
    updateJd.mutate(
      { id: active._id, patch },
      { onError: (e: any) => toast({ title: 'Not saved', description: e.message, variant: 'destructive' }) },
    );
  };

  const handleSubmit = async () => {
    if (!active) return;
    try {
      await submitJd.mutateAsync(active._id);
      toast({ title: active.status === 'rejected' ? 'Resubmitted' : 'Submitted for approval', description: `"${active.title}" is now in review.` });
    } catch (err: any) {
      toast({ title: 'Could not submit', description: err.message, variant: 'destructive' });
    }
  };

  const handleMention = async () => {
    if (!active || !selectedMentions.length) return;
    await mentionPeers.mutateAsync({ id: active._id, userIds: selectedMentions, type: mentionType });
    toast({ title: 'Peers notified', description: `${selectedMentions.length} teammate(s) tagged for ${mentionType}.` });
    setSelectedMentions([]);
  };

  const handleRevise = async () => {
    if (!active) return;
    try {
      const p = await revise.mutateAsync({ id: active._id });
      setProposal(p);
    } catch (err: any) {
      toast({ title: 'Revision agent unavailable', description: err.message, variant: 'destructive' });
    }
  };

  const handleApplyRevision = async () => {
    if (!active) return;
    await applyRevision.mutateAsync({ id: active._id });
    setProposal(null);
    toast({ title: 'Revision applied', description: 'Review the changes, then resubmit when ready.' });
  };

  const handleReset = async () => {
    if (!active) return;
    await resetThread.mutateAsync(active._id);
    setRunId(null);
    toast({ title: 'Conversation reset', description: 'The draft fields were kept; the assistant starts fresh.' });
  };

  const placeholder = legacy
    ? 'Type your answer…'
    : active?.agentState === 'needs_input'
      ? "Answer the questions above, or say 'looks good'…"
      : active?.agentState === 'ready'
        ? "Ask for changes — e.g. 'make it senior', 'remote instead'…"
        : 'Describe the role, paste a brief or an old JD…';

  if (loadingJds) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading your conversation…
      </div>
    );
  }

  const LowConf = ({ f }: { f: string }) =>
    conf[f] !== undefined && conf[f] < 0.6 && (fields as any)?.[f] ? (
      <span className="ml-1 text-[9px] font-mono text-warning" title={`The assistant inferred this (confidence ${Math.round(conf[f] * 100)}%) — please check`}>
        check
      </span>
    ) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
      {/* Chat column */}
      <Card className="card-elevated flex flex-col h-[calc(100vh-220px)] min-h-[520px]">
        <div className="flex items-center justify-between border-b px-4 py-3 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium leading-none flex items-center gap-1.5">
                JD Assistant
                <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                  {legacy ? 'guided' : 'agent'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground truncate">{active ? active.title || 'Untitled role' : 'No active draft'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {myDrafts.length > 1 && (
              <select className="text-xs border rounded-md px-2 py-1.5 bg-background max-w-[180px]" value={activeId || ''} onChange={(e) => setActiveId(e.target.value)}>
                {myDrafts.map((j) => (
                  <option key={j._id} value={j._id}>
                    {j.title || 'Untitled'} — {j.status}
                  </option>
                ))}
              </select>
            )}
            <Button size="sm" variant="outline" onClick={handleStartNew} disabled={createJd.isPending}>
              {createJd.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'New JD'}
            </Button>
            {active && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setShowHistory(true)}>
                    <History className="h-3.5 w-3.5 mr-2" /> Version history
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowPrefs(true)}>
                    <SlidersHorizontal className="h-3.5 w-3.5 mr-2" /> Assistant preferences
                  </DropdownMenuItem>
                  {isEditable && !legacy && (
                    <DropdownMenuItem onClick={handleReset}>
                      <RotateCcw className="h-3.5 w-3.5 mr-2" /> Restart conversation
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {!active ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
            <Sparkles className="h-10 w-10 text-primary/40" />
            <p className="font-medium">Start your first job description</p>
            <p className="text-sm text-muted-foreground max-w-sm">
              Describe the role in a sentence, paste a Slack message, or paste an old JD. The assistant asks only what's missing, drafts from similar approved JDs, and checks it before you see it.
            </p>
            <Button onClick={handleStartNew} disabled={createJd.isPending} className="btn-corporate mt-2">
              {createJd.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Begin conversation
            </Button>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 px-4 py-4" ref={scrollRef as any}>
              <div className="space-y-4">
                {active.conversation.map((turn, i) => (
                  <div key={i} className={`flex gap-2.5 ${turn.role === 'user' ? 'justify-end' : ''}`}>
                    {turn.role === 'assistant' && (
                      <div className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${turn.kind === 'error' ? 'bg-destructive/10' : 'bg-primary/10'}`}>
                        {turn.kind === 'error' ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <Bot className="h-3.5 w-3.5 text-primary" />}
                      </div>
                    )}
                    <div className={`chat-bubble text-sm ${turn.role === 'user' ? 'chat-bubble-user whitespace-pre-wrap' : 'chat-bubble-system'}`}>
                      {turn.role === 'assistant' ? <Markdown text={turn.content} /> : turn.content}
                    </div>
                    {turn.role === 'user' && (
                      <div className="h-7 w-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                        <UserIcon className="h-3.5 w-3.5" />
                      </div>
                    )}
                  </div>
                ))}
                {running && !legacy && (
                  <div className="flex gap-2.5">
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="flex-1 max-w-md">
                      <AgentProgress events={runData?.run.events || []} done={!!runData?.applied} />
                    </div>
                  </div>
                )}
                {agentMessage.isPending && legacy && (
                  <div className="flex gap-2.5">
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="chat-bubble chat-bubble-system text-sm text-muted-foreground">Thinking…</div>
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="border-t p-3 space-y-2">
              {!isEditable ? (
                <p className="text-xs text-muted-foreground text-center py-1">This JD is in review — the conversation is read-only.</p>
              ) : legacyDone ? (
                <p className="text-xs text-muted-foreground text-center py-1">Conversation complete — refine the draft on the right, then submit for approval.</p>
              ) : (
                <>
                  {!legacy && !running && (active.agentState === 'needs_input' || active.agentState === 'ready') && (
                    <div className="flex flex-wrap gap-1.5">
                      {(active.agentState === 'needs_input' ? ['Looks good'] : ['Make it senior', 'Make it remote']).map((c) => (
                        <Button key={c} size="sm" variant="outline" className="h-7 text-xs rounded-full" onClick={() => send(c)}>
                          {c}
                        </Button>
                      ))}
                    </div>
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      send(draftText);
                    }}
                    className="flex gap-2 items-end"
                  >
                    <Textarea
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          send(draftText);
                        }
                      }}
                      placeholder={placeholder}
                      rows={draftText.split('\n').length > 2 ? 4 : 1}
                      className="min-h-[40px] resize-none"
                      disabled={running}
                    />
                    <Button type="submit" size="icon" disabled={!draftText.trim() || running} aria-label="Send">
                      {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </form>
                </>
              )}
            </div>
          </>
        )}
      </Card>

      {/* Draft / review column */}
      {active && (
        <div className="space-y-4">
          <Card className="card-elevated p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Approval pipeline</p>
              <StatusBadge status={active.status} />
            </div>
            <PipelineStepper status={active.status} />
            {rejection !== null && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs">
                  <span className="font-medium">Reviewer feedback:</span> {rejection || 'No comment given.'}
                </p>
                <Button size="sm" className="w-full gap-1.5" variant="secondary" onClick={handleRevise} disabled={revise.isPending || !rejection}>
                  {revise.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                  Let the assistant propose fixes
                </Button>
              </div>
            )}
          </Card>

          {!!questions.length && (
            <Card className="card-elevated p-4 space-y-2 border-warning/40">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <MessageCircleQuestion className="h-4 w-4 text-warning" /> The assistant needs your input
              </p>
              <ol className="list-decimal pl-5 space-y-1 text-xs">
                {questions.map((q) => (
                  <li key={q.id}>
                    <Markdown text={q.question} />
                  </li>
                ))}
              </ol>
              <p className="text-[11px] text-muted-foreground">Reply in the chat, or say "looks good" to keep the draft as is.</p>
            </Card>
          )}

          <Card className="card-elevated p-4 space-y-3 max-h-[460px] overflow-y-auto">
            <p className="text-sm font-medium">Draft details</p>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Job title <LowConf f="title" />
              </Label>
              <Input value={fields?.title || ''} disabled={!isEditable} onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))} onBlur={() => fields && handleSaveField({ title: fields.title })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Department <LowConf f="department" />
                </Label>
                <Input value={fields?.department || ''} disabled={!isEditable} onChange={(e) => setFields((f) => ({ ...f, department: e.target.value }))} onBlur={() => fields && handleSaveField({ department: fields.department })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Level <LowConf f="level" />
                </Label>
                <select
                  className="w-full h-10 text-sm border rounded-md px-2 bg-background disabled:opacity-50"
                  value={fields?.level || ''}
                  disabled={!isEditable}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, level: e.target.value }));
                    handleSaveField({ level: e.target.value });
                  }}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l || '—'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Employment type</Label>
                <Input value={fields?.employmentType || ''} disabled={!isEditable} onChange={(e) => setFields((f) => ({ ...f, employmentType: e.target.value }))} onBlur={() => fields && handleSaveField({ employmentType: fields.employmentType })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Work mode</Label>
                <select
                  className="w-full h-10 text-sm border rounded-md px-2 bg-background disabled:opacity-50"
                  value={fields?.workMode || ''}
                  disabled={!isEditable}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, workMode: e.target.value }));
                    handleSaveField({ workMode: e.target.value });
                  }}
                >
                  {MODES.map((l) => (
                    <option key={l} value={l}>
                      {l || '—'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Location</Label>
                <Input value={fields?.location || ''} disabled={!isEditable} onChange={(e) => setFields((f) => ({ ...f, location: e.target.value }))} onBlur={() => fields && handleSaveField({ location: fields.location })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Salary range
                  {meta?.fieldMeta?.salaryRange?.source?.startsWith('tool') && <span className="ml-1 text-[9px] font-mono text-muted-foreground">from band</span>}
                </Label>
                <Input value={fields?.salaryRange || ''} disabled={!isEditable} onChange={(e) => setFields((f) => ({ ...f, salaryRange: e.target.value }))} onBlur={() => fields && handleSaveField({ salaryRange: fields.salaryRange })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Summary</Label>
              <Textarea rows={4} value={fields?.summary || ''} disabled={!isEditable} onChange={(e) => setFields((f) => ({ ...f, summary: e.target.value }))} onBlur={() => fields && handleSaveField({ summary: fields.summary })} />
            </div>
            {(['responsibilities', 'qualifications', 'skills'] as const).map((k) => (
              <div key={k} className="space-y-1.5">
                <Label className="text-xs capitalize">{k} (one per line)</Label>
                <Textarea
                  rows={k === 'skills' ? 2 : 4}
                  value={listToText((fields?.[k] as string[]) || [])}
                  disabled={!isEditable}
                  onChange={(e) => setFields((f) => ({ ...f, [k]: textToList(e.target.value) }))}
                  onBlur={() => fields && handleSaveField({ [k]: fields[k] } as any)}
                />
              </div>
            ))}
          </Card>

          {!legacy && (
            <QualityPanel
              critique={meta?.critique}
              initial={meta?.initialCritique}
              fixes={meta?.fixesApplied}
              onRecheck={isEditable && hasContent ? () => critique.mutate(active._id) : undefined}
              checking={critique.isPending}
            />
          )}
          <EvidencePanel meta={meta} current={{ responsibilities: active.responsibilities, qualifications: active.qualifications }} />

          {isEditable && (
            <Card className="card-elevated p-4 space-y-3">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <AtSign className="h-3.5 w-3.5" /> Mention teammates
              </p>
              <div className="flex gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="flex-1 justify-start text-xs">
                      {selectedMentions.length ? `${selectedMentions.length} selected` : 'Choose people'}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-64 max-h-64 overflow-y-auto">
                    {directory
                      ?.filter((d) => d.id !== user?.id)
                      .map((d) => (
                        <DropdownMenuCheckboxItem
                          key={d.id}
                          checked={selectedMentions.includes(d.id)}
                          onCheckedChange={(checked) => setSelectedMentions((prev) => (checked ? [...prev, d.id] : prev.filter((id) => id !== d.id)))}
                        >
                          {d.name} <span className="text-muted-foreground ml-1 text-xs">· {d.department}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <select className="text-xs border rounded-md px-2 bg-background" value={mentionType} onChange={(e) => setMentionType(e.target.value as any)}>
                  <option value="feedback">Feedback</option>
                  <option value="approval">Approval</option>
                  <option value="collaboration">Collaboration</option>
                </select>
              </div>
              <Button size="sm" variant="secondary" className="w-full" disabled={!selectedMentions.length} onClick={handleMention}>
                Tag {selectedMentions.length || ''} teammate{selectedMentions.length === 1 ? '' : 's'}
              </Button>
              {!!active.peerApprovals.length && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {active.peerApprovals.map((p, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] font-mono">
                      {typeof p.user === 'string' ? p.user : p.user.name} · {p.status}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          )}

          {isEditable && (
            <Button className="w-full btn-corporate" onClick={handleSubmit} disabled={!(hasContent || legacyDone) || running || submitJd.isPending}>
              {submitJd.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {active.status === 'rejected' ? 'Resubmit for approval' : 'Submit for approval'}
            </Button>
          )}
        </div>
      )}

      {active && <VersionHistory jdId={active._id} open={showHistory} onOpenChange={setShowHistory} />}
      <PreferencesDialog open={showPrefs} onOpenChange={setShowPrefs} />
      <RevisionDialog proposal={proposal} open={!!proposal} onOpenChange={(o) => !o && setProposal(null)} onApply={handleApplyRevision} applying={applyRevision.isPending} />
    </div>
  );
}
