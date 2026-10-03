import { Schema, model, Types, Document } from 'mongoose';

export type UserRole = 'hr' | 'employee';

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  title?: string;
  department?: string;
  reportsTo?: Types.ObjectId | null;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['hr', 'employee'], required: true, default: 'employee' },
    title: { type: String, default: '' },
    department: { type: String, default: 'General' },
    reportsTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export default model<IUser>('User', userSchema);
