import { Schema, model, Types, Document } from 'mongoose';

export type JDStatus = 'draft' | 'pending_manager' | 'pending_hr' | 'approved' | 'rejected';

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
  at: Date;
}

export interface IJobDescription extends Document {
  title: string;
  department: string;
  employmentType: string;
  summary: string;
  responsibilities: string[];
  qualifications: string[];
  skills: string[];
  salaryRange?: string;
  status: JDStatus;
  createdBy: Types.ObjectId;
  history: IHistoryEntry[];
  peerApprovals: IPeerApproval[];
  conversation: IConversationTurn[];
  conversationStep: number;
  createdAt: Date;
  updatedAt: Date;
}

const jobDescriptionSchema = new Schema<IJobDescription>(
  {
    title: { type: String, default: 'Untitled Job Description' },
    department: { type: String, default: '' },
    employmentType: { type: String, default: 'Full-time' },
    summary: { type: String, default: '' },
    responsibilities: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    skills: { type: [String], default: [] },
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
        at: { type: Date, default: Date.now },
      },
    ],
    conversationStep: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default model<IJobDescription>('JobDescription', jobDescriptionSchema);
