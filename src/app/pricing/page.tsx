'use client';

import Link from 'next/link';

import { useAuth } from '@/components/auth/AuthProvider';

const FALLBACK = [
  {
    id: 'free',
    name: 'Free',
    priceMonthlyUsd: 0,
    projectsPerMonth: 15,
    features: [
      'Prompt → BOM, pins, wiring, firmware',
      'Hosted dashboard preview',
      'Export zip',
      '15 projects / month',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthlyUsd: 29,
    projectsPerMonth: 200,
    features: ['Everything in Free', 'Priority LLM codegen', '200 projects / month', 'API keys', 'Hosted Velxio when configured'],
  },
  {
    id: 'team',
    name: 'Team',
    priceMonthlyUsd: 99,
    projectsPerMonth: 1000,
    features: ['Everything in Pro', '10 seats', 'Shared org ownership', 'Usage analytics'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthlyUsd: null,
    projectsPerMonth: 50_000,
    features: ['Custom limits', 'VPC / on-prem', 'SLA + support', 'Private catalog extensions'],
  },
];

export default function PricingPage() {
  const { plans, authenticated, plan } = useAuth();
  const list = plans.length > 0 ? plans : FALLBACK;

  return (
    <>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span>Wireup</span>
        </Link>
        <span className="topbar__spacer" />
        <Link href="/pricing" className="btn btn--sm">
          Pricing
        </Link>
        {authenticated ? (
          <Link href="/" className="btn btn--sm btn--primary">
            Open bench
          </Link>
        ) : (
          <>
            <Link href="/login" className="btn btn--sm">
              Sign in
            </Link>
            <Link href="/register" className="btn btn--sm btn--primary">
              Start free
            </Link>
          </>
        )}
      </header>
      <main className="pricing">
        <div className="pricing__inner">
          <p className="landing__eyebrow">PLANS</p>
          <h1 className="landing__title">Ship hardware ideas. Pay when you scale.</h1>
          <p className="landing__subtitle">
            Free is a real product tier — not a crippled demo. Upgrade when your lab outgrows monthly limits.
          </p>
          {plan ? (
            <p className="pricing__current">
              Current plan: <strong>{plan.name}</strong>
            </p>
          ) : null}
          <div className="pricing__grid">
            {list.map((entry) => (
              <article key={entry.id} className={`pricing__card${plan?.id === entry.id ? ' pricing__card--current' : ''}`}>
                <h2>{entry.name}</h2>
                <p className="pricing__price">
                  {entry.priceMonthlyUsd === null
                    ? 'Custom'
                    : entry.priceMonthlyUsd === 0
                      ? '$0'
                      : `$${entry.priceMonthlyUsd}`}
                  {entry.priceMonthlyUsd !== null ? <span className="faint"> / mo</span> : null}
                </p>
                <p className="faint">{entry.projectsPerMonth.toLocaleString()} projects / month</p>
                <ul>
                  {entry.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                {entry.id === 'free' ? (
                  <Link href={authenticated ? '/' : '/register'} className="btn btn--primary">
                    {authenticated ? 'Open bench' : 'Start free'}
                  </Link>
                ) : entry.id === 'enterprise' ? (
                  <a className="btn" href="mailto:sales@wireup.dev">
                    Contact sales
                  </a>
                ) : (
                  <Link href={authenticated ? '/account' : '/register'} className="btn">
                    {authenticated ? 'Upgrade' : 'Get started'}
                  </Link>
                )}
              </article>
            ))}
          </div>
          <p className="pricing__note faint">
            Stripe checkout hooks are wired for Pro/Team when <code>STRIPE_SECRET_KEY</code> and price ids are set.
            Until then, plan changes are admin-promoted.
          </p>
        </div>
      </main>
    </>
  );
}
