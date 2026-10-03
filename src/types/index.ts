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
  at: string;
}

export interface JobDescription {
  _id: string;
  title: string;
  department: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface AppNotification {
  _id: string;
  type: 'jd_submitted' | 'jd_approved' | 'jd_rejected' | 'mention' | 'message' | 'info';
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
