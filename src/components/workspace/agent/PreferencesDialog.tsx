import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { usePreferences, useSavePreferences } from '@/hooks/useWorkspace';
import { useToast } from '@/hooks/use-toast';

export function PreferencesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = usePreferences();
  const save = useSavePreferences();
  const { toast } = useToast();
  const [tone, setTone] = useState<'friendly' | 'formal' | 'concise'>('friendly');
  const [benefits, setBenefits] = useState('');
  useEffect(() => {
    if (data) {
      setTone(data.tone);
      setBenefits((data.benefits || []).join('\n'));
    }
  }, [data, open]);
  const submit = async () => {
    await save.mutateAsync({ tone, benefits: benefits.split('\n').map((s) => s.trim()).filter(Boolean) });
    toast({ title: 'Preferences saved', description: 'The assistant will use them on your next draft.' });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assistant preferences</DialogTitle>
          <DialogDescription>Remembered across drafts. The assistant also learns which skills your department adds to its drafts.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Tone</Label>
            <div className="flex gap-2">
              {(['friendly', 'formal', 'concise'] as const).map((t) => (
                <Button key={t} size="sm" variant={tone === t ? 'default' : 'outline'} onClick={() => setTone(t)} className="capitalize">
                  {t}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Standard benefits (one per line)</Label>
            <Textarea rows={4} value={benefits} onChange={(e) => setBenefits(e.target.value)} placeholder={'Health insurance for you and your family\nLearning budget'} />
          </div>
          {!!data?.learnedSkills?.length && (
            <div className="space-y-1.5">
              <Label className="text-xs">Learned for your department</Label>
              <div className="flex flex-wrap gap-1.5">
                {data.learnedSkills.map((s) => (
                  <Badge key={s} variant="outline" className="font-mono text-[10px]">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={save.isPending} className="btn-corporate">
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
