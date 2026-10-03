import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { JobDescription } from '@/types';

export function useJDs() {
  return useQuery({
    queryKey: ['jds'],
    queryFn: () => api.get<{ jds: JobDescription[] }>('/jds').then((r) => r.jds),
  });
}

export function useJD(id?: string) {
  return useQuery({
    queryKey: ['jd', id],
    queryFn: () => api.get<{ jd: JobDescription }>(`/jds/${id}`).then((r) => r.jd),
    enabled: !!id,
  });
}

export function useCreateJD() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ jd: JobDescription }>('/jds').then((r) => r.jd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jds'] }),
  });
}

export function useAgentMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) =>
      api.post<{ jd: JobDescription; done: boolean }>(`/jds/${id}/agent-message`, { message }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['jd', vars.id] });
      qc.invalidateQueries({ queryKey: ['jds'] });
    },
  });
}

export function useUpdateJD() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<JobDescription> }) =>
      api.patch<{ jd: JobDescription }>(`/jds/${id}`, patch).then((r) => r.jd),
    onSuccess: (jd) => {
      qc.invalidateQueries({ queryKey: ['jd', jd._id] });
      qc.invalidateQueries({ queryKey: ['jds'] });
    },
  });
}

export function useSubmitJD() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ jd: JobDescription }>(`/jds/${id}/submit`).then((r) => r.jd),
    onSuccess: (jd) => {
      qc.invalidateQueries({ queryKey: ['jd', jd._id] });
      qc.invalidateQueries({ queryKey: ['jds'] });
    },
  });
}

export function useApproveJD() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      api.post<{ jd: JobDescription }>(`/jds/${id}/approve`, { comment }).then((r) => r.jd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jds'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });
}

export function useRejectJD() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      api.post<{ jd: JobDescription }>(`/jds/${id}/reject`, { comment }).then((r) => r.jd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jds'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });
}

export function useMentionPeers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userIds, type }: { id: string; userIds: string[]; type: 'approval' | 'feedback' | 'collaboration' }) =>
      api.post<{ jd: JobDescription }>(`/jds/${id}/mention`, { userIds, type }).then((r) => r.jd),
    onSuccess: (jd) => {
      qc.invalidateQueries({ queryKey: ['jd', jd._id] });
      qc.invalidateQueries({ queryKey: ['jds'] });
    },
  });
}

export function usePeerRespond() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: string; status: 'approved' | 'rejected'; comment?: string }) =>
      api.post<{ jd: JobDescription }>(`/jds/${id}/peer-respond`, { status, comment }).then((r) => r.jd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jds'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
