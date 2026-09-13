'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { LoginForm } from '@/components/auth/AuthForms';

function LoginInner() {
  const params = useSearchParams();
  const next = params.get('next') || '/';
  return (
    <main className="auth-page">
      <Link href="/" className="auth-page__brand">
        <span className="topbar__mark">W</span> Wireup
      </Link>
      <LoginForm next={next} />
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth-page">Loading…</main>}>
      <LoginInner />
    </Suspense>
  );
}
