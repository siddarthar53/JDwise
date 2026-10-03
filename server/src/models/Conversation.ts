import { Schema, model, Types, Document } from 'mongoose';

export interface IConversation extends Document {
  participants: Types.ObjectId[];
  isGroup: boolean;
  name?: string;
  lastMessageAt: Date;
  lastMessagePreview?: string;
}

const conversationSchema = new Schema<IConversation>(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    isGroup: { type: Boolean, default: false },
    name: { type: String },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
  },
  { timestamps: true },
);

export default model<IConversation>('Conversation', conversationSchema);
