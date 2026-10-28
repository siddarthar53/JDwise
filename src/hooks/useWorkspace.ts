import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AdminOverview, AppNotification, ChatConversation, ChatMessage, DirectoryUser, Preferences, QAAnswer, QueryResult } from '@/types';

export function useDirectory() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: DirectoryUser[] }>('/users').then((r) => r.users),
  });
}

export function useSubordinates() {
  return useQuery({
    queryKey: ['subordinates'],
    queryFn: () => api.get<{ users: DirectoryUser[] }>('/users/subordinates').then((r) => r.users),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: AppNotification[]; unreadCount: number }>('/notifications'),
    refetchInterval: 20000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.get<{ conversations: ChatConversation[] }>('/chat/conversations').then((r) => r.conversations),
    refetchInterval: 15000,
  });
}

export function useMessages(conversationId?: string) {
  return useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () =>
      api.get<{ messages: ChatMessage[] }>(`/chat/conversations/${conversationId}/messages`).then((r) => r.messages),
    enabled: !!conversationId,
    refetchInterval: 10000,
  });
}

export function useStartConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (participantIds: string[]) =>
      api
        .post<{ conversation: ChatConversation }>('/chat/conversations', { participantIds })
        .then((r) => r.conversation),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, content }: { conversationId: string; content: string }) =>
      api.post<{ message: ChatMessage }>(`/chat/conversations/${conversationId}/messages`, { content }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['messages', vars.conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api.get<AdminOverview>('/admin/overview'),
  });
}

export function useSendReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userIds, message }: { userIds: string[]; message?: string }) =>
      api.post('/admin/remind', { userIds, message }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

// ---------------------------------------------------------------------------- agentic additions

export function useAsk() {
  return useMutation({
    mutationFn: (question: string) => api.post<{ answer: QAAnswer }>('/assistant/ask', { question }).then((r) => r.answer),
  });
}

export function usePreferences() {
  return useQuery({
    queryKey: ['preferences'],
    queryFn: () => api.get<{ preferences: Preferences }>('/me/preferences').then((r) => r.preferences),
  });
}

export function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Preferences>) => api.put<{ preferences: Preferences }>('/me/preferences', p).then((r) => r.preferences),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preferences'] }),
  });
}

export function useOpsAsk() {
  return useMutation({
    mutationFn: (question: string) =>
      api.post<{ route: { query_id: string; params: Record<string, unknown>; rationale?: string }; result: QueryResult }>('/admin/ops/ask', { question }),
  });
}

export function useAnalyticsCatalog() {
  return useQuery({
    queryKey: ['analytics-catalog'],
    queryFn: () => api.get<{ catalog: { id: string; description: string; params: Record<string, string> }[] }>('/admin/analytics/catalog').then((r) => r.catalog),
  });
}

export interface ReminderDraft {
  to_user_id: string;
  to_name: string;
  jd_id: string;
  subject: string;
  message: string;
}

export function useStuckJds(minAgeHours = 48) {
  return useQuery({
    queryKey: ['ops-stuck', minAgeHours],
    queryFn: () => api.get<{ items: any[]; drafts: ReminderDraft[] }>(`/admin/ops/stuck?min_age_hours=${minAgeHours}`),
  });
}

export function useSendReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (drafts: ReminderDraft[]) => api.post('/admin/ops/send-reminders', { drafts }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops-stuck'] }),
  });
}

export function useAdminMetrics(days = 30) {
  return useQuery({
    queryKey: ['admin-metrics', days],
    queryFn: () => api.get<{ business: any; agent: any; runs: any[]; agentOnline: boolean }>(`/admin/metrics?days=${days}`),
    refetchInterval: 30_000,
  });
}
