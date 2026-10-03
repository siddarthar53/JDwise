import Notification, { INotification } from '../models/Notification';
import { Types } from 'mongoose';

export async function notify(params: {
  user: Types.ObjectId | string;
  type: INotification['type'];
  title: string;
  message: string;
  jd?: Types.ObjectId | string;
}) {
  return Notification.create(params);
}
