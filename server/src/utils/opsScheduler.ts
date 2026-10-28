/**
 * Proactive operations agent (scheduled part). Every OPS_SCAN_MINUTES it looks
 * for JDs stuck in a review stage and sends HR one digest per day. HR then
 * reviews the drafted reminders in Company Overview → Ops and sends them —
 * nothing is sent to approvers automatically.
 */
import JobDescription from '../models/JobDescription';
import Notification from '../models/Notification';
import User from '../models/User';
import { stageEnteredAt } from '../analytics/queries';
import { notify } from './notify';

export async function opsScanOnce(minAgeHours = Number(process.env.OPS_STUCK_HOURS) || 48) {
  const jds = await JobDescription.find({ status: { $in: ['pending_manager', 'pending_hr'] } }).select('title status history');
  const stuck = jds.filter((j) => {
    const at = stageEnteredAt(j as any);
    return at && (Date.now() - new Date(at).getTime()) / 3_600_000 >= minAgeHours;
  });
  if (!stuck.length) return 0;
  const since = new Date(Date.now() - 20 * 3_600_000);
  const hrUsers = await User.find({ role: 'hr' });
  let sent = 0;
  for (const hr of hrUsers) {
    const recent = await Notification.findOne({ user: hr._id, type: 'ops', title: 'Ops digest: JDs stuck in review', createdAt: { $gte: since } });
    if (recent) continue;
    await notify({
      user: hr._id,
      type: 'ops',
      title: 'Ops digest: JDs stuck in review',
      message: `${stuck.length} JD(s) have waited over ${minAgeHours}h: ${stuck.slice(0, 3).map((j) => `"${j.title}"`).join(', ')}${stuck.length > 3 ? '…' : ''}. Open Company Overview → Ops to send drafted reminders.`,
    });
    sent++;
  }
  return sent;
}

export function startOpsScheduler() {
  const minutes = Number(process.env.OPS_SCAN_MINUTES) || 60;
  if (minutes <= 0) return;
  const tick = () => opsScanOnce().catch((e) => console.warn('[ops] scan failed', e.message));
  setTimeout(tick, 15_000);
  setInterval(tick, minutes * 60_000);
}
