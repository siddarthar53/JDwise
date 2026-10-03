import React, { createContext, useContext, useState, useEffect } from 'react';
import { api, getToken, setToken, ApiError } from '@/lib/api';

export type UserRole = 'hr' | 'employee';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  title?: string;
  department?: string;
  reportsTo?: string | null;
}

interface RegisterInput {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  department?: string;
  title?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  register: (input: RegisterInput) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get<{ user: User }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
      setToken(res.token);
      setUser(res.user);
      return { ok: true };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Unable to reach the server';
      return { ok: false, error: message };
    }
  };

  const register = async (input: RegisterInput) => {
    try {
      const res = await api.post<{ token: string; user: User }>('/auth/register', input);
      setToken(res.token);
      setUser(res.user);
      return { ok: true };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Unable to reach the server';
      return { ok: false, error: message };
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  const value: AuthContextType = {
    user,
    loading,
    login,
    register,
    logout,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
