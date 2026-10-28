import { Schema, model, Document } from 'mongoose';

/**
 * Layer 10 memory. `scope: 'user'` holds explicit author preferences (tone,
 * benefits boilerplate). `scope: 'department'` holds what the system learned
 * from approved JDs: skills that humans repeatedly added to AI drafts.
 */
export interface IPreference extends Document {
  scope: 'user' | 'department';
  key: string; // userId or department name (lowercased)
  tone: 'friendly' | 'formal' | 'concise';
  benefits: string[];
  learnedSkills: { skill: string; count: number }[];
  updatedAt: Date;
}

const preferenceSchema = new Schema<IPreference>(
  {
    scope: { type: String, enum: ['user', 'department'], required: true },
    key: { type: String, required: true },
    tone: { type: String, enum: ['friendly', 'formal', 'concise'], default: 'friendly' },
    benefits: { type: [String], default: [] },
    learnedSkills: [{ skill: String, count: { type: Number, default: 0 } }],
  },
  { timestamps: true },
);
preferenceSchema.index({ scope: 1, key: 1 }, { unique: true });

export default model<IPreference>('Preference', preferenceSchema);
