import { Schema, model, Types, Document } from 'mongoose';

export type JDStatus = 'draft' | 'pending_manager' | 'pending_hr' | 'approved' | 'rejected';
export type AgentState = 'idle' | 'collecting' | 'running' | 'needs_input' | 'ready' | 'legacy';

export interface IHistoryEntry {
  action: string;
  byUser: Types.ObjectId;
  comment?: string;
  at: Date;
}

export interface IPeerApproval {
  user: Types.ObjectId;
  type: 'approval' | 'feedback' | 'collaboration';
  status: 'pending' | 'approved' | 'rejected';
  comment?: string;
  respondedAt?: Date;
}

export interface IConversationTurn {
  role: 'assistant' | 'user';
  content: string;
  kind?: string; // question | draft | review | error | legacy
  runId?: string;
  at: Date;
}

/** Content snapshot. `history` records actions; `versions` records content. */
export interface IVersion {
  version: number;
  origin: 'ai_draft' | 'submission' | 'revision' | 'manual';
  byUser?: Types.ObjectId | null;
  runId?: string;
  at: Date;
  fields: Record<string, unknown>;
}

export interface IAiRun {
  runId: string;
  kind: string;
  status: string;
  applied: boolean;
  startedAt: Date;
  finishedAt?: Date;
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface IReviewEvent {
  stage: 'pending_manager' | 'pending_hr';
  user: Types.ObjectId;
  openedAt: Date;
  decidedAt?: Date;
  decision?: 'approved' | 'rejected';
  usedCopilot?: boolean;
}

export interface IJobDescription extends Document {
  title: string;
  department: string;
  level: string;
  employmentType: string;
  location: string;
  workMode: string;
  summary: string;
  responsibilities: string[];
  qualifications: string[];
  skills: string[];
  benefits: string[];
  salaryRange?: string;
  status: JDStatus;
  createdBy: Types.ObjectId;
  history: IHistoryEntry[];
  peerApprovals: IPeerApproval[];
  conversation: IConversationTurn[];
  conversationStep: number;
  agentState: AgentState;
  activeRunId?: string | null;
  aiRuns: IAiRun[];
  appliedRunIds: string[];
  aiMeta: Record<string, any>;
  versions: IVersion[];
  firstAiDraft?: Record<string, unknown> | null;
  reviewEvents: IReviewEvent[];
  createdAt: Date;
  updatedAt: Date;
}

const jobDescriptionSchema = new Schema<IJobDescription>(
  {
    title: { type: String, default: 'Untitled Job Description' },
    department: { type: String, default: '' },
    level: { type: String, default: '' },
    employmentType: { type: String, default: 'Full-time' },
    location: { type: String, default: '' },
    workMode: { type: String, default: '' },
    summary: { type: String, default: '' },
    responsibilities: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    benefits: { type: [String], default: [] },
    salaryRange: { type: String, default: '' },
    status: {
      type: String,
      enum: ['draft', 'pending_manager', 'pending_hr', 'approved', 'rejected'],
      default: 'draft',
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    history: [
      {
        action: String,
        byUser: { type: Schema.Types.ObjectId, ref: 'User' },
        comment: String,
        at: { type: Date, default: Date.now },
      },
    ],
    peerApprovals: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User' },
        type: { type: String, enum: ['approval', 'feedback', 'collaboration'], default: 'approval' },
        status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
        comment: String,
        respondedAt: Date,
      },
    ],
    conversation: [
      {
        role: { type: String, enum: ['assistant', 'user'] },
        content: String,
        kind: String,
        runId: String,
        at: { type: Date, default: Date.now },
      },
    ],
    conversationStep: { type: Number, default: 0 },
    agentState: {
      type: String,
      enum: ['idle', 'collecting', 'running', 'needs_input', 'ready', 'legacy'],
      default: 'collecting',
    },
    activeRunId: { type: String, default: null },
    aiRuns: [
      {
        runId: String,
        kind: String,
        status: String,
        applied: { type: Boolean, default: false },
        startedAt: { type: Date, default: Date.now },
        finishedAt: Date,
        metrics: Schema.Types.Mixed,
        error: String,
      },
    ],
    appliedRunIds: { type: [String], default: [] },
    aiMeta: { type: Schema.Types.Mixed, default: {} },
    versions: [
      {
        version: Number,
        origin: { type: String, enum: ['ai_draft', 'submission', 'revision', 'manual'] },
        byUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        runId: String,
        at: { type: Date, default: Date.now },
        fields: Schema.Types.Mixed,
      },
    ],
    firstAiDraft: { type: Schema.Types.Mixed, default: null },
    reviewEvents: [
      {
        stage: { type: String, enum: ['pending_manager', 'pending_hr'] },
        user: { type: Schema.Types.ObjectId, ref: 'User' },
        openedAt: { type: Date, default: Date.now },
        decidedAt: Date,
        decision: { type: String, enum: ['approved', 'rejected'] },
        usedCopilot: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true, minimize: false },
);

export const CONTENT_FIELDS = [
  'title',
  'department',
  'level',
  'employmentType',
  'location',
  'workMode',
  'summary',
  'responsibilities',
  'qualifications',
  'skills',
  'benefits',
  'salaryRange',
] as const;

export function contentSnapshot(jd: IJobDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  CONTENT_FIELDS.forEach((k) => {
    const v = (jd as any)[k];
    out[k] = Array.isArray(v) ? [...v] : v ?? '';
  });
  return out;
}

export default model<IJobDescription>('JobDescription', jobDescriptionSchema);
