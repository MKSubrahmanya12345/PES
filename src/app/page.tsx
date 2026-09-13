'use client';

import Link from 'next/link';

import { PromptForm } from '@/components/PromptForm';
import { useAuth } from '@/components/auth/AuthProvider';

export default function HomePage() {
  const { loading, authenticated, user, plan, usage, signOut } = useAuth();

  return (
    <>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span>Wireup</span>
        </Link>
        <span className="topbar__spacer" />
        <Link href="/pricing" className="btn btn--sm" style={{ marginRight: 8 }}>
          Pricing
        </Link>
        {!loading && authenticated && user ? (
          <>
            <Link href="/account" className="btn btn--sm" style={{ marginRight: 8 }}>
              {user.name.split(' ')[0]} · {plan?.name ?? user.plan}
            </Link>
            {user.role === 'admin' ? (
              <Link href="/admin" className="btn btn--sm" style={{ marginRight: 8 }}>
                Admin
              </Link>
            ) : null}
            <button type="button" className="btn btn--sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <Link href="/login" className="btn btn--sm" style={{ marginRight: 8 }}>
              Sign in
            </Link>
            <Link href="/register" className="btn btn--sm btn--primary">
              Start free
            </Link>
          </>
        )}
      </header>

      <main className="landing">
        <div className="landing__inner">
          {authenticated && usage && plan ? (
            <div className="store-banner" style={{ marginBottom: 18 }}>
              <strong>{plan.name} plan</strong> — {usage.projectsThisMonth} project(s) this month
              {typeof (plan as { projectsPerMonth?: number }).projectsPerMonth === 'number'
                ? ` / ${(plan as { projectsPerMonth: number }).projectsPerMonth}`
                : ''}
              . Hosted dashboard preview included.
            </div>
          ) : null}

          {!loading && !authenticated ? (
            <div className="store-banner" style={{ marginBottom: 18 }}>
              <strong>Sign in to build.</strong> Projects are private to your account, metered by plan, and
              exportable anytime.{' '}
              <Link href="/register">Create a free account</Link> or <Link href="/login">sign in</Link>.
            </div>
          ) : null}

          <div className="landing__beacon" aria-hidden="true">
            <span className="landing__beacon-orbit landing__beacon-orbit--outer" />
            <span className="landing__beacon-orbit landing__beacon-orbit--inner" />
            <span className="landing__beacon-core">W</span>
            <span className="landing__beacon-label">brief / build / ship</span>
          </div>
          <div className="landing__signal" aria-hidden="true">
            <span className="landing__signal-line" />
            <span>hardware engineering workspace</span>
            <span className="landing__signal-line landing__signal-line--short" />
          </div>
          <p className="landing__eyebrow">PROMPT → BOM → PINS → FIRMWARE → HOSTED PREVIEW</p>
          <h1 className="landing__title">From messy idea to wires you can trust.</h1>
          <p className="landing__subtitle">
            Describe the device. Wireup picks real parts, assigns legal pins, writes firmware that matches the
            wiring graph, validates it, and opens a hosted dashboard — under your account, on a real plan.
          </p>

          <div className="landing__form-label">
            <span>Tell the bench what you&apos;re making</span>
            <span className="landing__form-label-detail">
              {authenticated ? 'one brief in · owned project out' : 'sign in required to create projects'}
            </span>
          </div>
          <PromptForm requireAuth={!authenticated && !loading} />

          <div className="landing__proof">
            <span className="landing__proof-mark" aria-hidden="true" />
            <p className="landing__note">
              Multi-tenant by default. No shared anonymous bucket. Admin is a real role — not admin123.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
