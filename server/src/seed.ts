import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB } from './db';
import User from './models/User';
import JobDescription from './models/JobDescription';
import Notification from './models/Notification';
import Conversation from './models/Conversation';
import Message from './models/Message';
import Preference from './models/Preference';
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
    Preference.deleteMany({}),
    mongoose.connection.db!.collection('agent_runs').deleteMany({}),
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

  const day = 24 * 60 * 60 * 1000;
  const ago = (d: number, h = 0) => new Date(Date.now() - d * day - h * 3600_000);
  const snap = (j: any) => ({
    title: j.title, department: j.department, level: j.level || '', employmentType: j.employmentType, location: j.location || '',
    workMode: j.workMode || '', summary: j.summary, responsibilities: j.responsibilities, qualifications: j.qualifications,
    skills: j.skills, benefits: [], salaryRange: j.salaryRange || '',
  });

  const sampleBody = {
    title: 'Software Engineer II',
    department: 'Engineering',
    level: 'mid',
    employmentType: 'Full-time',
    location: 'Bangalore',
    workMode: 'hybrid',
    summary: 'Builds and maintains customer-facing features across the platform, partnering closely with product and design.',
    responsibilities: [
      'Own delivery of medium-complexity features end to end',
      'Participate in code review and design discussions',
      'Debug and resolve production issues',
    ],
    qualifications: ['3+ years professional software experience', 'Strong TypeScript/React or equivalent'],
    skills: ['TypeScript', 'React', 'Node.js', 'MongoDB'],
    salaryRange: '₹18–28 LPA',
  };
  const sampleJd = await JobDescription.create({
    ...sampleBody,
    status: 'pending_manager',
    agentState: 'legacy',
    createdBy: employee._id,
    history: [
      { action: 'created', byUser: employee._id, at: ago(2) },
      { action: 'submitted', byUser: employee._id, at: ago(1) },
    ],
    versions: [{ version: 1, origin: 'submission', byUser: employee._id, at: ago(1), fields: snap(sampleBody) }],
    peerApprovals: [{ user: peer._id, type: 'feedback', status: 'pending' }],
    conversation: [
      { role: 'assistant', content: "Let's build your job description together. What is the job title?", kind: 'legacy' },
      { role: 'user', content: 'Software Engineer II' },
    ],
    conversationStep: 7,
  });

  // Approved history (gives the analytics, RAG corpus and baseline metrics real data)
  const approved = [
    {
      author: taylor, title: 'Marketing Specialist', department: 'Marketing', level: 'mid', location: 'Hyderabad', workMode: 'hybrid',
      summary: 'Plans and runs multi-channel campaigns that grow awareness and pipeline for our B2B products.',
      responsibilities: ['Plan and execute campaigns across email, social and paid channels', 'Write landing pages, blog posts and campaign copy', 'Report on campaign performance and pipeline contribution', 'Coordinate launches with design and sales'],
      qualifications: ['2-4 years of B2B marketing experience', 'Experience with a marketing automation platform such as HubSpot'],
      skills: ['Content Marketing', 'Email Marketing', 'HubSpot', 'SEO', 'Copywriting'], salaryRange: '₹8–15 LPA',
      created: 21, submitted: 20, mgr: 19, hr: 17, rejectedWith: null as string | null,
    },
    {
      author: peer, title: 'Product Designer', department: 'Design', level: 'mid', location: 'Remote', workMode: 'remote',
      summary: 'Designs intuitive product experiences end to end, from research and flows to polished, accessible interfaces.',
      responsibilities: ['Lead design for features from problem framing through launch', 'Run user research and usability tests', 'Produce flows, prototypes and high-fidelity designs in Figma', 'Contribute components to the design system'],
      qualifications: ['3+ years of product design experience with a portfolio of shipped work', 'Proficiency in Figma and prototyping tools'],
      skills: ['Figma', 'User Research', 'Prototyping', 'Design Systems'], salaryRange: '₹12–22 LPA',
      created: 30, submitted: 29, mgr: 27, hr: 22, rejectedWith: 'Please add the salary range and make the research responsibilities more specific.',
    },
    {
      author: employee, title: 'Senior Backend Engineer', department: 'Engineering', level: 'senior', location: 'Bangalore', workMode: 'hybrid',
      summary: 'Leads design and delivery of the payments and billing services, raising reliability and mentoring engineers.',
      responsibilities: ['Lead technical design for payments and billing services', 'Own service reliability, on-call health and incident follow-ups', 'Mentor engineers through reviews and pairing', 'Partner with product to sequence delivery'],
      qualifications: ['5+ years of backend engineering experience', 'Experience operating distributed systems in production'],
      skills: ['Go', 'PostgreSQL', 'Kubernetes', 'System Design', 'Observability'], salaryRange: '₹30–45 LPA',
      created: 45, submitted: 44, mgr: 43, hr: 40, rejectedWith: null,
    },
  ];
  for (const a of approved) {
    const body = { title: a.title, department: a.department, level: a.level, employmentType: 'Full-time', location: a.location, workMode: a.workMode, summary: a.summary, responsibilities: a.responsibilities, qualifications: a.qualifications, skills: a.skills, salaryRange: a.salaryRange };
    const history: any[] = [
      { action: 'created', byUser: a.author._id, at: ago(a.created) },
      { action: 'submitted', byUser: a.author._id, at: ago(a.submitted) },
    ];
    const reviewEvents: any[] = [];
    if (a.rejectedWith) {
      history.push({ action: 'rejected', byUser: manager._id, comment: a.rejectedWith, at: ago(a.submitted - 1) });
      history.push({ action: 'resubmitted', byUser: a.author._id, at: ago(a.mgr + 1) });
      reviewEvents.push({ stage: 'pending_manager', user: manager._id, openedAt: ago(a.submitted - 1, 3), decidedAt: ago(a.submitted - 1), decision: 'rejected' });
    }
    history.push({ action: 'manager_approved', byUser: manager._id, at: ago(a.mgr) });
    history.push({ action: 'hr_approved', byUser: hr._id, comment: 'Looks good.', at: ago(a.hr) });
    reviewEvents.push({ stage: 'pending_manager', user: manager._id, openedAt: ago(a.mgr, 2), decidedAt: ago(a.mgr), decision: 'approved' });
    reviewEvents.push({ stage: 'pending_hr', user: hr._id, openedAt: ago(a.hr, 5), decidedAt: ago(a.hr), decision: 'approved' });
    await JobDescription.create({
      ...body, status: 'approved', agentState: 'legacy', createdBy: a.author._id, history, reviewEvents,
      versions: [{ version: 1, origin: 'submission', byUser: a.author._id, at: ago(a.submitted), fields: snap(body) }],
      conversation: [], conversationStep: 7,
    });
  }

  // A JD stuck at HR for 4 days (manager has no manager → goes straight to HR)
  const stuckBody = {
    title: 'Engineering Manager, Platform', department: 'Engineering', level: 'manager', employmentType: 'Full-time', location: 'Bangalore', workMode: 'hybrid',
    summary: 'Leads the platform team of six engineers, owning delivery, people growth and operational health of core services.',
    responsibilities: ['Hire, onboard and develop a team of 5-8 engineers', 'Run planning so commitments are met predictably', 'Hold regular one-on-ones and give career feedback', 'Maintain operational health and on-call sustainability'],
    qualifications: ['6+ years of software engineering experience, including 2+ years managing engineers', 'Track record of hiring and growing engineers'],
    skills: ['Leadership', 'Agile', 'System Design', 'Mentoring'], salaryRange: '₹40–65 LPA',
  };
  await JobDescription.create({
    ...stuckBody, status: 'pending_hr', agentState: 'legacy', createdBy: manager._id,
    history: [{ action: 'created', byUser: manager._id, at: ago(6) }, { action: 'submitted', byUser: manager._id, at: ago(4) }],
    versions: [{ version: 1, origin: 'submission', byUser: manager._id, at: ago(4), fields: snap(stuckBody) }],
    conversation: [], conversationStep: 7,
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

  // Ask the agent service (if running) to re-index the fresh data.
  const agentUrl = (process.env.AGENT_URL || '').replace(/\/$/, '');
  if (agentUrl) {
    try {
      const { agentCall } = await import('./utils/agentClient');
      const r = await agentCall('POST', '/index/sync', {}, 180_000);
      console.log('[seed] agent knowledge base re-indexed:', JSON.stringify(r));
    } catch (e: any) {
      console.log('[seed] agent not reachable; it will index on its next start:', e.message);
    }
  }

  console.log('[seed] done.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
