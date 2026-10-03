import React, { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle, ArrowRight, Loader2, Sparkles, FileEdit, UserCheck, ShieldCheck } from 'lucide-react';

const DEMO_CREDENTIALS = [
  { role: 'HR Admin', email: 'hr@demo.com', password: 'Hr@123' },
  { role: 'Manager', email: 'manager@demo.com', password: 'Mgr@123' },
  { role: 'Employee', email: 'employee@demo.com', password: 'Emp@123' },
  { role: 'Peer', email: 'peer@demo.com', password: 'Peer@123' },
];

const Login = () => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'employee' | 'hr' | ''>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isSignUp) {
      if (password !== confirmPassword) return setError('Passwords do not match.');
      if (password.length < 6) return setError('Password must be at least 6 characters long.');
      if (!role) return setError('Please select your role.');
    }

    setLoading(true);
    const result = isSignUp
      ? await register({ name, email, password, role: role as 'employee' | 'hr' })
      : await login(email, password);
    setLoading(false);

    if (result.ok) {
      navigate('/dashboard');
    } else {
      setError(result.error || 'Something went wrong. Please try again.');
    }
  };

  const toggleMode = () => {
    setIsSignUp(!isSignUp);
    setError('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setName('');
    setRole('');
  };

  const fillCredentials = (demoEmail: string, demoPassword: string) => {
    setEmail(demoEmail);
    setPassword(demoPassword);
    setError('');
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Left - brand panel */}
      <div
        className="hidden lg:flex flex-col justify-between p-12 text-white relative overflow-hidden"
        style={{ background: 'var(--gradient-hero)' }}
      >
        <div className="absolute inset-0 opacity-[0.07]" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }} />
        <div className="relative flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-lg bg-white/10 flex items-center justify-center">
            <Sparkles className="h-4.5 w-4.5" />
          </div>
          <span className="font-display font-semibold text-lg">Rolewrite</span>
        </div>

        <div className="relative space-y-8 max-w-md">
          <h1 className="font-display text-4xl font-semibold leading-tight">
            Job descriptions, written together.
          </h1>
          <p className="text-white/70 leading-relaxed">
            A conversational assistant turns a five-minute chat into a polished JD, then routes it through
            manager and HR sign-off automatically — with peers looped in exactly when they're needed.
          </p>

          <div className="space-y-4 pt-2 font-mono text-sm">
            <div className="flex items-center gap-3 text-white/80">
              <FileEdit className="h-4 w-4" /> Draft with the AI agent
            </div>
            <div className="flex items-center gap-3 text-white/80">
              <UserCheck className="h-4 w-4" /> Manager reviews the downline
            </div>
            <div className="flex items-center gap-3 text-white/80">
              <ShieldCheck className="h-4 w-4" /> HR gives final approval
            </div>
          </div>
        </div>

        <p className="relative text-xs text-white/40 font-mono">© {new Date().getFullYear()} Rolewrite</p>
      </div>

      {/* Right - form */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="lg:hidden flex items-center gap-2 justify-center mb-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <span className="font-display font-semibold text-lg">Rolewrite</span>
          </div>

          <div>
            <h2 className="font-display text-2xl font-semibold">
              {isSignUp ? 'Create your account' : 'Welcome back'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {isSignUp ? 'Set up access to start collecting job descriptions.' : 'Sign in to continue to your workspace.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" required />
              </div>
            )}

            {isSignUp && (
              <div className="space-y-1.5">
                <Label htmlFor="role">Role</Label>
                <select
                  id="role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  required
                >
                  <option value="">Select your role</option>
                  <option value="employee">Employee</option>
                  <option value="hr">HR Admin</option>
                </select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {isSignUp && (
              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full btn-corporate gap-1.5" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {loading ? (isSignUp ? 'Creating account…' : 'Signing in…') : isSignUp ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <p className="text-center text-sm">
            <button type="button" onClick={toggleMode} className="text-muted-foreground hover:text-primary transition-colors">
              {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
            </button>
          </p>

          {!isSignUp && (
            <div className="border rounded-xl p-4 space-y-2 bg-muted/40">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide font-mono">Demo accounts</p>
              {DEMO_CREDENTIALS.map((cred) => (
                <button
                  key={cred.email}
                  onClick={() => fillCredentials(cred.email, cred.password)}
                  className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-background transition-colors"
                >
                  <span className="font-medium">{cred.role}</span>
                  <span className="text-muted-foreground text-xs font-mono">{cred.email}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Login;
