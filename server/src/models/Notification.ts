import { Schema, model, Types, Document } from 'mongoose';

export interface INotification extends Document {
  user: Types.ObjectId;
  type: 'jd_submitted' | 'jd_approved' | 'jd_rejected' | 'mention' | 'message' | 'info';
  title: string;
  message: string;
  jd?: Types.ObjectId;
  read: boolean;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['jd_submitted', 'jd_approved', 'jd_rejected', 'mention', 'message', 'info'],
      default: 'info',
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    jd: { type: Schema.Types.ObjectId, ref: 'JobDescription' },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default model<INotification>('Notification', notificationSchema);
