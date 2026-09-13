'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { RegisterForm } from '@/components/auth/AuthForms';

function RegisterInner() {
  const params = useSearchParams();
  const next = params.get('next') || '/';
  return (
    <main className="auth-page">
      <Link href="/" className="auth-page__brand">
        <span className="topbar__mark">W</span> Wireup
      </Link>
      <RegisterForm next={next} />
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<main className="auth-page">Loading…</main>}>
      <RegisterInner />
    </Suspense>
  );
}
