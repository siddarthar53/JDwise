import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Send, Users, Plus, Loader2, MessageSquare } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useConversations, useDirectory, useMessages, useSendMessage, useStartConversation } from '@/hooks/useWorkspace';
import { formatDistanceToNow } from 'date-fns';

function initials(name: string) {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

export default function ChatPanel() {
  const { user } = useAuth();
  const { data: conversations, isLoading: loadingConvos } = useConversations();
  const { data: directory } = useDirectory();
  const startConversation = useStartConversation();
  const sendMessage = useSendMessage();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId && conversations?.length) setActiveId(conversations[0]._id);
  }, [conversations, activeId]);

  const { data: messages } = useMessages(activeId || undefined);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages?.length]);

  const active = conversations?.find((c) => c._id === activeId);

  const otherParticipants = (c: typeof active) =>
    c?.participants.filter((p) => p.id !== user?.id) || [];

  const conversationLabel = (c: NonNullable<typeof active>) => {
    if (c.name) return c.name;
    const others = otherParticipants(c);
    return others.map((o) => o.name).join(', ') || 'You';
  };

  const handleStart = async (id: string) => {
    const convo = await startConversation.mutateAsync([id]);
    setActiveId(convo._id);
  };

  const handleSend = async () => {
    if (!activeId || !text.trim()) return;
    const content = text;
    setText('');
    await sendMessage.mutateAsync({ conversationId: activeId, content });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 h-[calc(100vh-220px)] min-h-[480px]">
      <Card className="card-elevated flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Users className="h-4 w-4" /> Conversations
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7">
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {directory
                ?.filter((d) => d.id !== user?.id)
                .map((d) => (
                  <DropdownMenuItem key={d.id} onClick={() => handleStart(d.id)}>
                    {d.name} <span className="text-muted-foreground ml-1 text-xs">· {d.role === 'hr' ? 'HR' : d.department}</span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ScrollArea className="flex-1">
          {loadingConvos && (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {!loadingConvos && !conversations?.length && (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">
              No conversations yet. Tap + to message someone.
            </p>
          )}
          {conversations?.map((c) => (
            <button
              key={c._id}
              onClick={() => setActiveId(c._id)}
              className={`w-full text-left px-4 py-3 border-b hover:bg-muted/50 transition-colors ${
                c._id === activeId ? 'bg-muted' : ''
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-xs bg-secondary">{initials(conversationLabel(c))}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{conversationLabel(c)}</p>
                  <p className="text-xs text-muted-foreground truncate">{c.lastMessagePreview || 'No messages yet'}</p>
                </div>
              </div>
            </button>
          ))}
        </ScrollArea>
      </Card>

      <Card className="card-elevated flex flex-col overflow-hidden">
        {!active ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <MessageSquare className="h-8 w-8 opacity-40" />
            <p className="text-sm">Select or start a conversation</p>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b">
              <p className="text-sm font-medium">{conversationLabel(active)}</p>
            </div>
            <ScrollArea className="flex-1 px-4 py-4" ref={scrollRef as any}>
              <div className="space-y-3">
                {messages?.map((m) => {
                  const mine = m.sender.id === user?.id;
                  return (
                    <div key={m._id} className={`flex gap-2 ${mine ? 'justify-end' : ''}`}>
                      {!mine && (
                        <Avatar className="h-6 w-6 shrink-0">
                          <AvatarFallback className="text-[10px] bg-secondary">{initials(m.sender.name)}</AvatarFallback>
                        </Avatar>
                      )}
                      <div className={`chat-bubble text-sm ${mine ? 'chat-bubble-user' : 'chat-bubble-system'}`}>
                        {m.content}
                        <div className={`text-[10px] mt-1 ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                          {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
            <form
              className="border-t p-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" />
              <Button type="submit" size="icon" disabled={!text.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}
