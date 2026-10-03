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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Send, Bot, User as UserIcon, AtSign, Sparkles, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/context/AuthContext';
import { useAgentMessage, useCreateJD, useJDs, useMentionPeers, useSubmitJD, useUpdateJD } from '@/hooks/useJDs';
import { useDirectory } from '@/hooks/useWorkspace';
import { PipelineStepper } from './PipelineStepper';
import { StatusBadge } from './StatusBadge';
import { JobDescription } from '@/types';

const TOTAL_STEPS = 7;

function listToText(list: string[]) {
  return list.join('\n');
}
function textToList(text: string) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
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

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [mentionType, setMentionType] = useState<'approval' | 'feedback' | 'collaboration'>('feedback');
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const myDrafts = useMemo(() => (jds || []).filter((j) => typeof j.createdBy !== 'string' ? j.createdBy.id === user?.id : j.createdBy === user?.id), [jds, user]);

  useEffect(() => {
    if (!loadingJds && myDrafts.length && !activeId) {
      const openDraft = myDrafts.find((j) => j.status === 'draft') || myDrafts[0];
      setActiveId(openDraft._id);
    }
  }, [loadingJds, myDrafts, activeId]);

  const active = myDrafts.find((j) => j._id === activeId) || null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [active?.conversation.length]);

  const [fields, setFields] = useState<Partial<JobDescription> | null>(null);
  useEffect(() => {
    if (active) {
      setFields({
        title: active.title,
        department: active.department,
        employmentType: active.employmentType,
        summary: active.summary,
        responsibilities: active.responsibilities,
        qualifications: active.qualifications,
        skills: active.skills,
        salaryRange: active.salaryRange,
      });
    }
  }, [active?._id, active?.updatedAt]);

  const conversationDone = (active?.conversationStep || 0) >= TOTAL_STEPS;
  const isEditable = active?.status === 'draft';

  const handleStartNew = async () => {
    const jd = await createJd.mutateAsync();
    setActiveId(jd._id);
  };

  const handleSend = async () => {
    if (!active || !draftText.trim()) return;
    const text = draftText;
    setDraftText('');
    await agentMessage.mutateAsync({ id: active._id, message: text });
  };

  const handleSaveField = (patch: Partial<JobDescription>) => {
    if (!active) return;
    updateJd.mutate({ id: active._id, patch });
  };

  const handleSubmit = async () => {
    if (!active) return;
    await submitJd.mutateAsync(active._id);
    toast({ title: 'Submitted for approval', description: `"${active.title}" is now in review.` });
  };

  const handleMention = async () => {
    if (!active || !selectedMentions.length) return;
    await mentionPeers.mutateAsync({ id: active._id, userIds: selectedMentions, type: mentionType });
    toast({ title: 'Peers notified', description: `${selectedMentions.length} teammate(s) tagged for ${mentionType}.` });
    setSelectedMentions([]);
  };

  if (loadingJds) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading your conversation…
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
      {/* Chat column */}
      <Card className="card-elevated flex flex-col h-[calc(100vh-220px)] min-h-[480px]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium leading-none">JD Assistant</p>
              <p className="text-xs text-muted-foreground">{active ? active.title || 'Untitled role' : 'No active draft'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {myDrafts.length > 1 && (
              <select
                className="text-xs border rounded-md px-2 py-1.5 bg-background"
                value={activeId || ''}
                onChange={(e) => setActiveId(e.target.value)}
              >
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
          </div>
        </div>

        {!active ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
            <Sparkles className="h-10 w-10 text-primary/40" />
            <p className="font-medium">Start your first job description</p>
            <p className="text-sm text-muted-foreground max-w-sm">
              The assistant will ask a few quick questions and draft the JD as you go — you can edit everything before submitting.
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
                      <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        <Bot className="h-3.5 w-3.5 text-primary" />
                      </div>
                    )}
                    <div className={`chat-bubble whitespace-pre-wrap text-sm ${turn.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-system'}`}>
                      {turn.content}
                    </div>
                    {turn.role === 'user' && (
                      <div className="h-7 w-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                        <UserIcon className="h-3.5 w-3.5" />
                      </div>
                    )}
                  </div>
                ))}
                {agentMessage.isPending && (
                  <div className="flex gap-2.5">
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="chat-bubble chat-bubble-system text-sm text-muted-foreground">Thinking…</div>
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="border-t p-3">
              {conversationDone ? (
                <p className="text-xs text-muted-foreground text-center py-1">
                  Conversation complete — refine the draft on the right, then submit for approval.
                </p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSend();
                  }}
                  className="flex gap-2"
                >
                  <Input
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    placeholder="Type your answer…"
                    disabled={agentMessage.isPending || active.status !== 'draft'}
                  />
                  <Button type="submit" size="icon" disabled={!draftText.trim() || agentMessage.isPending}>
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
              )}
            </div>
          </>
        )}
      </Card>

      {/* Draft summary / editor column */}
      {active && (
        <div className="space-y-4">
          <Card className="card-elevated p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Approval pipeline</p>
              <StatusBadge status={active.status} />
            </div>
            <PipelineStepper status={active.status} />
          </Card>

          <Card className="card-elevated p-4 space-y-3 max-h-[420px] overflow-y-auto">
            <p className="text-sm font-medium">Draft details</p>
            <div className="space-y-1.5">
              <Label className="text-xs">Job title</Label>
              <Input
                value={fields?.title || ''}
                disabled={!isEditable}
                onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
                onBlur={() => fields && handleSaveField({ title: fields.title })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Department</Label>
                <Input
                  value={fields?.department || ''}
                  disabled={!isEditable}
                  onChange={(e) => setFields((f) => ({ ...f, department: e.target.value }))}
                  onBlur={() => fields && handleSaveField({ department: fields.department })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Type / range</Label>
                <Input
                  value={fields?.employmentType || ''}
                  disabled={!isEditable}
                  onChange={(e) => setFields((f) => ({ ...f, employmentType: e.target.value }))}
                  onBlur={() => fields && handleSaveField({ employmentType: fields.employmentType })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Summary</Label>
              <Textarea
                rows={3}
                value={fields?.summary || ''}
                disabled={!isEditable}
                onChange={(e) => setFields((f) => ({ ...f, summary: e.target.value }))}
                onBlur={() => fields && handleSaveField({ summary: fields.summary })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Responsibilities (one per line)</Label>
              <Textarea
                rows={3}
                value={listToText(fields?.responsibilities || [])}
                disabled={!isEditable}
                onChange={(e) => setFields((f) => ({ ...f, responsibilities: textToList(e.target.value) }))}
                onBlur={() => fields && handleSaveField({ responsibilities: fields.responsibilities })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Qualifications (one per line)</Label>
              <Textarea
                rows={3}
                value={listToText(fields?.qualifications || [])}
                disabled={!isEditable}
                onChange={(e) => setFields((f) => ({ ...f, qualifications: textToList(e.target.value) }))}
                onBlur={() => fields && handleSaveField({ qualifications: fields.qualifications })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Skills (one per line)</Label>
              <Textarea
                rows={2}
                value={listToText(fields?.skills || [])}
                disabled={!isEditable}
                onChange={(e) => setFields((f) => ({ ...f, skills: textToList(e.target.value) }))}
                onBlur={() => fields && handleSaveField({ skills: fields.skills })}
              />
            </div>
          </Card>

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
                          onCheckedChange={(checked) =>
                            setSelectedMentions((prev) => (checked ? [...prev, d.id] : prev.filter((id) => id !== d.id)))
                          }
                        >
                          {d.name} <span className="text-muted-foreground ml-1 text-xs">· {d.department}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <select
                  className="text-xs border rounded-md px-2 bg-background"
                  value={mentionType}
                  onChange={(e) => setMentionType(e.target.value as any)}
                >
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
            <Button className="w-full btn-corporate" onClick={handleSubmit} disabled={!conversationDone || submitJd.isPending}>
              {submitJd.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit for approval
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
