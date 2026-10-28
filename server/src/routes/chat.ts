import { Router } from 'express';
import Conversation from '../models/Conversation';
import Message from '../models/Message';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { notify } from '../utils/notify';
import User from '../models/User';
import { agentFire } from '../utils/agentClient';

const router = Router();

// GET /api/chat/conversations
router.get('/conversations', requireAuth, async (req: AuthedRequest, res) => {
  const conversations = await Conversation.find({ participants: req.userId })
    .populate('participants', 'name email role')
    .sort({ lastMessageAt: -1 });
  res.json({ conversations });
});

// POST /api/chat/conversations - start or reuse a 1:1 / group conversation
router.post('/conversations', requireAuth, async (req: AuthedRequest, res) => {
  const { participantIds, name } = req.body as { participantIds: string[]; name?: string };
  const allParticipants = Array.from(new Set([...(participantIds || []), req.userId as string]));

  if (allParticipants.length === 2 && !name) {
    const existing = await Conversation.findOne({
      isGroup: false,
      participants: { $all: allParticipants, $size: 2 },
    });
    if (existing) return res.json({ conversation: existing });
  }

  const conversation = await Conversation.create({
    participants: allParticipants,
    isGroup: allParticipants.length > 2 || !!name,
    name,
  });
  const populated = await conversation.populate('participants', 'name email role');
  res.status(201).json({ conversation: populated });
});

// GET /api/chat/conversations/:id/messages
router.get('/conversations/:id/messages', requireAuth, async (req: AuthedRequest, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation || !conversation.participants.map(String).includes(req.userId!)) {
    return res.status(403).json({ message: 'Not part of this conversation' });
  }
  const messages = await Message.find({ conversation: req.params.id })
    .populate('sender', 'name email')
    .sort({ createdAt: 1 });
  res.json({ messages });
});

// POST /api/chat/conversations/:id/messages
router.post('/conversations/:id/messages', requireAuth, async (req: AuthedRequest, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ message: 'Message content required' });

  const conversation = await Conversation.findById(req.params.id);
  if (!conversation || !conversation.participants.map(String).includes(req.userId!)) {
    return res.status(403).json({ message: 'Not part of this conversation' });
  }

  const message = await Message.create({
    conversation: conversation._id,
    sender: req.userId,
    content,
    readBy: [req.userId],
  });

  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = content.slice(0, 140);
  await conversation.save();

  const sender = await User.findById(req.userId);
  // index for permission-aware Q&A (participants travel with the chunk)
  const names = await User.find({ _id: { $in: conversation.participants } }).select('name');
  agentFire('POST', '/index/message', {
    message: {
      id: message._id.toString(),
      conversation_id: conversation._id.toString(),
      participants: conversation.participants.map(String),
      participant_names: names.map((n) => n.name),
      sender_name: sender?.name || '',
      content,
      at: message.createdAt,
    },
  });
  const others = conversation.participants.filter((p) => p.toString() !== req.userId);
  await Promise.all(
    others.map((uid) =>
      notify({
        user: uid,
        type: 'message',
        title: `New message from ${sender?.name}`,
        message: content.slice(0, 140),
      }),
    ),
  );

  const populated = await message.populate('sender', 'name email');
  res.status(201).json({ message: populated });
});

export default router;
