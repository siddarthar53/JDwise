import React, { useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useJDs, } from '@/hooks/useJDs';
import { useSubordinates } from '@/hooks/useWorkspace';
import { AppShell, NavItem } from '@/components/workspace/AppShell';
import JdConversation from '@/components/workspace/JdConversation';
import ApprovalsList from '@/components/workspace/ApprovalsList';
import ChatPanel from '@/components/workspace/ChatPanel';
import AdminOverview from '@/components/workspace/AdminOverview';
import {
  MessageSquare,
  FileCheck,
  UserCheck,
  Users,
  BarChart3,
  ClipboardCheck,
} from 'lucide-react';

const Dashboard = () => {
  const { user } = useAuth();
  const { data: subordinates } = useSubordinates();
  const { data: jds } = useJDs();

  const isManager = !!subordinates?.length;

  const hrNav: NavItem[] = useMemo(
    () => [
      { key: 'conversation', label: 'AI Agent Conversation', icon: <MessageSquare className="h-4 w-4" /> },
      {
        key: 'review',
        label: 'Review & Approve JDs',
        icon: <FileCheck className="h-4 w-4" />,
        badge: jds?.filter((j) => j.status === 'pending_hr').length || undefined,
      },
      { key: 'peer-approval', label: 'Peer Approvals', icon: <UserCheck className="h-4 w-4" /> },
      { key: 'chat', label: 'Chat', icon: <Users className="h-4 w-4" /> },
      { key: 'dashboard', label: 'Company Overview', icon: <BarChart3 className="h-4 w-4" /> },
    ],
    [jds],
  );

  const employeeNav: NavItem[] = useMemo(() => {
    const items: NavItem[] = [
      { key: 'conversation', label: 'JD Conversation', icon: <MessageSquare className="h-4 w-4" /> },
    ];
    if (isManager) {
      items.push({
        key: 'manager',
        label: 'Downline JD Approvals',
        icon: <ClipboardCheck className="h-4 w-4" />,
        badge: jds?.filter((j) => j.status === 'pending_manager').length || undefined,
      });
    }
    items.push({ key: 'peer-mentions', label: 'Peer Mentions', icon: <UserCheck className="h-4 w-4" /> });
    items.push({ key: 'chat', label: 'Chat', icon: <Users className="h-4 w-4" /> });
    return items;
  }, [isManager, jds]);

  const navItems = user?.role === 'hr' ? hrNav : employeeNav;
  const [activeTab, setActiveTab] = useState('conversation');

  if (!user) return null;

  const titleFor: Record<string, { title: string; subtitle?: string }> = {
    conversation: { title: 'AI Agent Conversation', subtitle: 'Answer a few questions and the assistant drafts the JD with you.' },
    review: { title: 'Review & Approve JDs', subtitle: 'Job descriptions waiting on HR sign-off.' },
    'peer-approval': { title: 'Peer Approvals', subtitle: 'Everything you have been tagged on across the company.' },
    manager: { title: 'Downline JD Approvals', subtitle: 'Job descriptions from your direct reports awaiting your review.' },
    'peer-mentions': { title: 'Peer Mentions', subtitle: 'Requests for your feedback, approval, or collaboration.' },
    chat: { title: 'Chat', subtitle: 'Message HR, your manager, or teammates directly.' },
    dashboard: { title: 'Company Overview', subtitle: 'Track JD completion across the organization.' },
  };

  return (
    <AppShell
      navItems={navItems}
      activeKey={activeTab}
      onSelect={setActiveTab}
      pageTitle={titleFor[activeTab]?.title || ''}
      pageSubtitle={titleFor[activeTab]?.subtitle}
    >
      {activeTab === 'conversation' && <JdConversation />}
      {activeTab === 'review' && user.role === 'hr' && <ApprovalsList mode="hr" />}
      {activeTab === 'peer-approval' && user.role === 'hr' && <ApprovalsList mode="peer" />}
      {activeTab === 'manager' && isManager && <ApprovalsList mode="manager" />}
      {activeTab === 'peer-mentions' && <ApprovalsList mode="peer" />}
      {activeTab === 'chat' && <ChatPanel />}
      {activeTab === 'dashboard' && user.role === 'hr' && <AdminOverview />}
    </AppShell>
  );
};

export default Dashboard;
