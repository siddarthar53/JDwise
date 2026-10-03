import React, { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMarkAllRead, useMarkNotificationRead, useNotifications } from '@/hooks/useWorkspace';
import { formatDistanceToNow } from 'date-fns';
import {
  Bell,
  LogOut,
  Moon,
  Sun,
  Sparkles,
  ChevronRight,
} from 'lucide-react';

export interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

interface AppShellProps {
  navItems: NavItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  pageTitle: string;
  pageSubtitle?: string;
  children: React.ReactNode;
}

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

function roleLabel(user: { role: string } | null) {
  if (!user) return '';
  return user.role === 'hr' ? 'HR Admin' : 'Employee';
}

export function AppShell({ navItems, activeKey, onSelect, pageTitle, pageSubtitle, children }: AppShellProps) {
  const { user, logout } = useAuth();
  const { dark, toggle } = useDarkMode();
  const { data: notifData } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllRead();

  if (!user) return null;

  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const unread = notifData?.unreadCount || 0;

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-sidebar-border">
          <div className="h-8 w-8 rounded-lg bg-sidebar-primary/20 flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-sidebar-primary" />
          </div>
          <span className="font-display font-semibold text-[17px] tracking-tight text-white">Rolewrite</span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map((item) => {
            const active = item.key === activeKey;
            return (
              <button
                key={item.key}
                onClick={() => onSelect(item.key)}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors relative ${
                  active
                    ? 'bg-sidebar-accent text-white font-medium'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-white'
                }`}
              >
                {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sidebar-primary" />}
                <span className={active ? 'text-sidebar-primary' : ''}>{item.icon}</span>
                <span className="flex-1 text-left">{item.label}</span>
                {!!item.badge && (
                  <Badge className="h-5 min-w-5 px-1.5 justify-center bg-sidebar-primary text-sidebar-primary-foreground border-0">
                    {item.badge}
                  </Badge>
                )}
              </button>
            );
          })}
        </nav>

        <div className="px-3 pb-4">
          <div className="rounded-lg bg-sidebar-accent/50 px-3 py-3 text-xs text-sidebar-foreground/60 font-mono">
            Signed in as
            <div className="text-sidebar-foreground font-sans font-medium truncate">{user.email}</div>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-16 shrink-0 border-b bg-card/80 backdrop-blur px-4 md:px-8 flex items-center justify-between sticky top-0 z-40">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
              <span>{roleLabel(user)}</span>
              <ChevronRight className="h-3 w-3" />
              <span>{navItems.find((n) => n.key === activeKey)?.label}</span>
            </div>
            <h1 className="text-lg font-display font-semibold leading-tight truncate">{pageTitle}</h1>
            {pageSubtitle && <p className="text-sm text-muted-foreground">{pageSubtitle}</p>}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                  <Bell className="h-4 w-4" />
                  {unread > 0 && (
                    <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-destructive" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
                  {unread > 0 && (
                    <button
                      className="text-xs text-primary hover:underline"
                      onClick={() => markAllRead.mutate()}
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                <DropdownMenuSeparator />
                <ScrollArea className="h-80">
                  {!notifData?.notifications.length && (
                    <p className="text-sm text-muted-foreground text-center py-8">You're all caught up.</p>
                  )}
                  {notifData?.notifications.map((n) => (
                    <DropdownMenuItem
                      key={n._id}
                      className="flex flex-col items-start gap-0.5 whitespace-normal py-2.5 cursor-pointer"
                      onClick={() => !n.read && markRead.mutate(n._id)}
                    >
                      <div className="flex items-center gap-2 w-full">
                        {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />}
                        <span className="text-sm font-medium truncate">{n.title}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{n.message}</span>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </ScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-full pl-1 pr-2.5 py-1 hover:bg-muted transition-colors">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm font-medium hidden sm:inline">{user.name}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <div className="font-medium">{user.name}</div>
                  <div className="text-xs font-normal text-muted-foreground">{user.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
                  <LogOut className="h-4 w-4 mr-2" /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Mobile nav */}
        <div className="md:hidden flex overflow-x-auto gap-1 border-b bg-card px-3 py-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => onSelect(item.key)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium ${
                item.key === activeKey ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>

        <main className="flex-1 min-w-0 p-4 md:p-8 fade-in">{children}</main>
      </div>
    </div>
  );
}
