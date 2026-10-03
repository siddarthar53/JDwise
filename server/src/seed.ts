import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB } from './db';
import User from './models/User';
import JobDescription from './models/JobDescription';
import Notification from './models/Notification';
import Conversation from './models/Conversation';
import Message from './models/Message';
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/jd-platform';
  await connectDB(uri);

  console.log('[seed] clearing existing data...');
  await Promise.all([
    User.deleteMany({}),
    JobDescription.deleteMany({}),
    Notification.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
  ]);

  const hash = (pwd: string) => bcrypt.hash(pwd, 10);

  const hr = await User.create({
    name: 'Sarah Johnson',
    email: 'hr@demo.com',
    passwordHash: await hash('Hr@123'),
    role: 'hr',
    title: 'HR Director',
    department: 'People Ops',
  });

  const manager = await User.create({
    name: 'Michael Chen',
    email: 'manager@demo.com',
    passwordHash: await hash('Mgr@123'),
    role: 'employee',
    title: 'Engineering Manager',
    department: 'Engineering',
  });

  const employee = await User.create({
    name: 'Alex Rivera',
    email: 'employee@demo.com',
    passwordHash: await hash('Emp@123'),
    role: 'employee',
    title: 'Software Engineer',
    department: 'Engineering',
    reportsTo: manager._id,
  });

  const peer = await User.create({
    name: 'Jamie Wilson',
    email: 'peer@demo.com',
    passwordHash: await hash('Peer@123'),
    role: 'employee',
    title: 'Product Designer',
    department: 'Design',
    reportsTo: manager._id,
  });

  const taylor = await User.create({
    name: 'Taylor Kim',
    email: 'taylor@demo.com',
    passwordHash: await hash('Taylor@123'),
    role: 'employee',
    title: 'Marketing Specialist',
    department: 'Marketing',
    reportsTo: manager._id,
  });

  console.log('[seed] created users:', [hr, manager, employee, peer, taylor].map((u) => u.email).join(', '));

  const sampleJd = await JobDescription.create({
    title: 'Software Engineer II',
    department: 'Engineering',
    employmentType: 'Full-time',
    summary: 'Builds and maintains customer-facing features across the platform, partnering closely with product and design.',
    responsibilities: [
      'Own delivery of medium-complexity features end to end',
      'Participate in code review and design discussions',
      'Debug and resolve production issues',
    ],
    qualifications: ['3+ years professional software experience', 'Strong TypeScript/React or equivalent'],
    skills: ['TypeScript', 'React', 'Node.js', 'MongoDB'],
    salaryRange: '$110,000 - $135,000',
    status: 'pending_manager',
    createdBy: employee._id,
    history: [
      { action: 'created', byUser: employee._id, at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2) },
      { action: 'submitted', byUser: employee._id, at: new Date(Date.now() - 1000 * 60 * 60 * 24) },
    ],
    peerApprovals: [{ user: peer._id, type: 'feedback', status: 'pending' }],
    conversation: [
      { role: 'assistant', content: "Let's build your job description together. What is the job title?" },
      { role: 'user', content: 'Software Engineer II' },
    ],
    conversationStep: 7,
  });

  await Notification.create([
    {
      user: manager._id,
      type: 'jd_submitted',
      title: 'JD awaiting your approval',
      message: `Alex Rivera submitted "${sampleJd.title}" for your review.`,
      jd: sampleJd._id,
    },
    {
      user: peer._id,
      type: 'mention',
      title: 'You were mentioned on a JD',
      message: `Alex Rivera asked for your feedback on "${sampleJd.title}".`,
      jd: sampleJd._id,
    },
  ]);

  const convo = await Conversation.create({
    participants: [employee._id, manager._id],
    isGroup: false,
    lastMessageAt: new Date(),
    lastMessagePreview: 'Sounds good, thanks!',
  });
  await Message.create([
    { conversation: convo._id, sender: employee._id, content: 'Hi Michael, just submitted my JD for review.' },
    { conversation: convo._id, sender: manager._id, content: "Got it, I'll take a look today." },
    { conversation: convo._id, sender: employee._id, content: 'Sounds good, thanks!' },
  ]);

  console.log('[seed] done.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
