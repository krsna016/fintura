"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase-client';

export default function SignupPage() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const router = useRouter();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
          },
        },
      });

      if (error) throw error;

      if (data?.session) {
        // Log user in directly
        document.cookie = `sb-access-token=${data.session.access_token}; path=/; max-age=${data.session.expires_in}; SameSite=Lax; Secure`;
        document.cookie = `sb-refresh-token=${data.session.refresh_token}; path=/; max-age=${data.session.expires_in}; SameSite=Lax; Secure`;
        router.push('/dashboard');
      } else {
        setErrorMsg('Verification link sent to email. Please verify and log in.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to register account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 font-sans text-slate-100">
      {/* Background radial glow */}
      <div className="absolute top-[-20%] left-[-20%] h-[60%] w-[60%] rounded-full bg-violet-600/10 blur-[120px]" />
      <div className="absolute bottom-[-20%] right-[-20%] h-[60%] w-[60%] rounded-full bg-indigo-600/10 blur-[120px]" />

      <div className="relative w-full max-w-md p-2">
        {/* Glass card container */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/40 p-8 shadow-2xl backdrop-blur-xl">
          <div className="mb-8 flex flex-col items-center text-center">
            <img src="/logo.png" alt="Fintura Logo" className="h-12 w-12 rounded-xl border border-slate-800 bg-slate-950/80 p-1 shadow-lg" />
            <h1 className="mt-4 bg-gradient-to-r from-violet-400 via-indigo-300 to-indigo-500 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent">
              Fintura
            </h1>
            <p className="mt-2 text-xs text-slate-400">
              Create your organization and start reconciling statements
            </p>
          </div>

          <form onSubmit={handleSignup} className="space-y-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Full Name
              </label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Rakesh Sharma"
                className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all focus:border-violet-500/80 focus:ring-1 focus:ring-violet-500/30"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all focus:border-violet-500/80 focus:ring-1 focus:ring-violet-500/30"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all focus:border-violet-500/80 focus:ring-1 focus:ring-violet-500/30"
              />
            </div>

            {errorMsg && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-400">
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="relative w-full overflow-hidden rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 py-3 text-sm font-semibold tracking-wide text-white shadow-lg transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Registering Account...' : 'Get Started'}
            </button>
          </form>

          <div className="mt-6 text-center text-xs text-slate-500">
            Already have an account?{' '}
            <Link href="/auth/login" className="text-violet-400 hover:underline">
              Log in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
