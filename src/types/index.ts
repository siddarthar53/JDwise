export type JDStatus = 'draft' | 'pending_manager' | 'pending_hr' | 'approved' | 'rejected';

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
  role: 'hr' | 'employee';
  title?: string;
  department?: string;
  reportsTo?: string | null;
}

export interface PeerApproval {
  user: DirectoryUser | string;
  type: 'approval' | 'feedback' | 'collaboration';
  status: 'pending' | 'approved' | 'rejected';
  comment?: string;
  respondedAt?: string;
}

export interface HistoryEntry {
  action: string;
  byUser: DirectoryUser | string;
  comment?: string;
  at: string;
}

export interface ConversationTurn {
  role: 'assistant' | 'user';
  content: string;
  kind?: 'question' | 'draft' | 'review' | 'error' | 'legacy' | 'info';
  runId?: string;
  at: string;
}

export type AgentState = 'idle' | 'collecting' | 'running' | 'needs_input' | 'ready' | 'legacy';

export interface Bullet {
  text: string;
  origin: 'brief' | 'retrieved' | 'generated' | 'memory' | 'tool';
  citations: string[];
}

export interface Finding {
  rule_id: string;
  severity: 'info' | 'warning' | 'error';
  section: string;
  message: string;
  evidence?: string;
  suggested_fix?: string;
  source: 'rule' | 'llm';
  auto_fixable?: boolean;
}

export interface Critique {
  findings: Finding[];
  rubric: Record<string, number>;
  passed: boolean;
}

export interface SourceChunk {
  id: string;
  doc_id: string;
  doc_type: 'jd' | 'library' | 'style' | 'message';
  title: string;
  section: string;
  text: string;
}

export interface ReviewQuestion {
  id: string;
  field: string;
  question: string;
}

export interface RevisionProposal {
  run_id?: string;
  fields: Partial<JobDescription>;
  addressed: string[];
  unresolved: string[];
  explanation: string;
  diff: DiffEntry[];
  comment?: string;
}

export interface DiffEntry {
  field: string;
  type: 'changed' | 'added' | 'removed';
  before?: string;
  after?: string;
}

export interface AiMeta {
  bullets?: { responsibilities?: Bullet[]; qualifications?: Bullet[] };
  sources?: SourceChunk[];
  fieldMeta?: Record<string, { confidence?: number; source?: string }>;
  confidence?: Record<string, number>;
  critique?: Critique | null;
  initialCritique?: Critique | null;
  fixesApplied?: string[];
  escalated?: boolean;
  genMethod?: string | null;
  reviewQuestions?: ReviewQuestion[];
  brief?: Record<string, unknown> | null;
  pendingRevision?: RevisionProposal | null;
}

export interface JdVersion {
  version: number;
  origin: 'ai_draft' | 'submission' | 'revision' | 'manual';
  byUser?: { name: string } | string | null;
  at: string;
  fields: Partial<JobDescription>;
}

export interface RunEvent {
  step: string;
  message: string;
  at: number;
  data?: Record<string, unknown>;
}

export interface AgentRunStatus {
  id: string;
  status: 'queued' | 'running' | 'needs_input' | 'completed' | 'failed';
  events: RunEvent[];
  metrics: Record<string, any>;
  provider?: string;
  error?: string | null;
}

export interface ReviewReport {
  summary: string;
  changes: string[];
  risks: Finding[];
  suggested_comments: string[];
  recommendation: 'approve' | 'request_changes' | 'needs_discussion';
}

export interface QAAnswer {
  answer: string;
  citations: { id?: string; doc_id: string; doc_type: string; title: string; section: string; text: string }[];
  refused: boolean;
}

export interface QueryResult {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  chart?: { type: 'bar' | 'line'; x: number; y: number[] };
  summary: string;
}

export interface Preferences {
  tone: 'friendly' | 'formal' | 'concise';
  benefits: string[];
  learnedSkills: string[];
}

export interface JobDescription {
  _id: string;
  title: string;
  department: string;
  level?: string;
  location?: string;
  workMode?: string;
  benefits?: string[];
  employmentType: string;
  summary: string;
  responsibilities: string[];
  qualifications: string[];
  skills: string[];
  salaryRange?: string;
  status: JDStatus;
  createdBy: DirectoryUser | string;
  history: HistoryEntry[];
  peerApprovals: PeerApproval[];
  conversation: ConversationTurn[];
  conversationStep: number;
  agentState?: AgentState;
  activeRunId?: string | null;
  aiMeta?: AiMeta;
  firstAiDraft?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppNotification {
  _id: string;
  type: 'jd_submitted' | 'jd_approved' | 'jd_rejected' | 'mention' | 'message' | 'info' | 'agent' | 'ops';
  title: string;
  message: string;
  jd?: { _id: string; title: string; status: JDStatus } | null;
  read: boolean;
  createdAt: string;
}

export interface ChatConversation {
  _id: string;
  participants: DirectoryUser[];
  isGroup: boolean;
  name?: string;
  lastMessageAt: string;
  lastMessagePreview?: string;
}

export interface ChatMessage {
  _id: string;
  conversation: string;
  sender: DirectoryUser;
  content: string;
  createdAt: string;
}

export interface AdminEmployeeRow {
  id: string;
  name: string;
  email: string;
  department: string;
  reportingManager: string;
  status: JDStatus | 'not_started';
  progress: number;
  lastActivity: string | null;
  mentions: number;
  jdId: string | null;
  jdTitle: string | null;
  aiDrafted?: boolean;
}

export interface AdminOverview {
  employees: AdminEmployeeRow[];
  counts: {
    total: number;
    completed: number;
    inProgress: number;
    notStarted: number;
    rejected: number;
  };
}
