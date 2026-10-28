import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AgentRunStatus, Critique, JdVersion, JobDescription, ReviewReport, RevisionProposal } from '@/types';

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
      api.post<{ jd: JobDescription; done?: boolean; runId?: string; mode: 'agent' | 'legacy' }>(`/jds/${id}/agent-message`, { message }),
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

// ---------------------------------------------------------------------------- agentic additions

export function useAgentRun(jdId?: string, runId?: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['agent-run', jdId, runId],
    queryFn: async () => {
      const r = await api.get<{ run: AgentRunStatus; applied: boolean }>(`/jds/${jdId}/runs/${runId}`);
      if (r.applied) {
        qc.invalidateQueries({ queryKey: ['jds'] });
        qc.invalidateQueries({ queryKey: ['jd', jdId] });
      }
      return r;
    },
    enabled: !!jdId && !!runId,
    refetchInterval: (q) => (q.state.data?.applied ? false : 700),
  });
}

export function useResetThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ jd: JobDescription }>(`/jds/${id}/agent-thread`).then((r) => r.jd),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jds'] }),
  });
}

export function useCritique() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ critique: Critique }>(`/jds/${id}/critique`).then((r) => r.critique),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jds'] }),
  });
}

export function useVersions(id?: string, enabled = true) {
  return useQuery({
    queryKey: ['versions', id],
    queryFn: () => api.get<{ versions: JdVersion[] }>(`/jds/${id}/versions`).then((r) => r.versions),
    enabled: !!id && enabled,
  });
}

export function useCopilot(id?: string, enabled = false) {
  return useQuery({
    queryKey: ['copilot', id],
    queryFn: () => api.get<{ report: ReviewReport }>(`/jds/${id}/copilot`).then((r) => r.report),
    enabled: !!id && enabled,
    staleTime: 60_000,
  });
}

export function useRevise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      api.post<{ proposal: RevisionProposal }>(`/jds/${id}/revise`, { comment }).then((r) => r.proposal),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jds'] }),
  });
}

export function useApplyRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fields }: { id: string; fields?: string[] }) =>
      api.post<{ jd: JobDescription }>(`/jds/${id}/revise/apply`, { fields }).then((r) => r.jd),
    onSuccess: (jd) => {
      qc.invalidateQueries({ queryKey: ['jds'] });
      qc.invalidateQueries({ queryKey: ['versions', jd._id] });
    },
  });
}
