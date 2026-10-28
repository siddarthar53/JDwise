import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, ShieldAlert, FileText, MessageSquare, Sparkles } from 'lucide-react';
import { useAsk } from '@/hooks/useWorkspace';
import { QAAnswer } from '@/types';
import { Markdown } from './agent/Markdown';

const EXAMPLES = ['Which open roles need Python?', 'What did the reviewer object to last time?', 'Summarise the discussion on the Software Engineer II JD', 'Which roles mention Figma?'];

/** Layer 8 — permission-aware Q&A over the JDs and conversations you can see. */
export default function AskPanel() {
  const ask = useAsk();
  const [q, setQ] = useState('');
  const [history, setHistory] = useState<{ q: string; a: QAAnswer }[]>([]);

  const submit = async (question: string) => {
    if (!question.trim()) return;
    setQ('');
    try {
      const a = await ask.mutateAsync(question);
      setHistory((h) => [{ q: question, a }, ...h]);
    } catch (e: any) {
      setHistory((h) => [{ q: question, a: { answer: e.message, citations: [], refused: true } }, ...h]);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      <Card className="card-elevated p-4 space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(q);
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about JDs, reviewer feedback or your conversations…" />
          <Button type="submit" disabled={!q.trim() || ask.isPending} className="gap-1.5">
            {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Ask
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <Button key={e} size="sm" variant="outline" className="h-7 text-xs rounded-full" onClick={() => submit(e)}>
              {e}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" /> Answers only use JDs and chats you already have access to.
        </p>
      </Card>

      {history.map((h, i) => (
        <Card key={i} className="card-elevated p-4 space-y-3">
          <p className="text-sm font-medium">{h.q}</p>
          <div className={`text-sm flex gap-2 ${h.a.refused ? 'text-muted-foreground' : ''}`}>
            <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <Markdown text={h.a.answer} />
          </div>
          {!!h.a.citations.length && (
            <div className="space-y-1.5 border-t pt-2">
              <p className="text-[10px] uppercase tracking-wide font-mono text-muted-foreground">Sources</p>
              {h.a.citations.slice(0, 6).map((c, j) => (
                <div key={j} className="text-xs flex gap-1.5">
                  {c.doc_type === 'message' ? <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span>
                    <span className="font-medium">{c.title}</span>{' '}
                    <Badge variant="outline" className="text-[9px] font-mono py-0">
                      {c.section}
                    </Badge>{' '}
                    <span className="text-muted-foreground">{c.text.slice(0, 160)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
