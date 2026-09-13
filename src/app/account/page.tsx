'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/auth/AuthProvider';

interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function AccountPage() {
  const router = useRouter();
  const { loading, authenticated, user, plan, usage, signOut, refresh } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [keyLimit, setKeyLimit] = useState(1);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bootstrapMsg, setBootstrapMsg] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    const response = await fetch('/api/auth/api-keys', { credentials: 'include' });
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: { keys?: ApiKeyRow[]; limit?: number };
      error?: { message?: string };
    };
    if (response.ok && payload.ok && payload.data) {
      setKeys(payload.data.keys ?? []);
      setKeyLimit(payload.data.limit ?? 1);
    }
  }, []);

  useEffect(() => {
    if (!loading && !authenticated) {
      router.replace('/login?next=/account');
      return;
    }
    if (authenticated) void loadKeys();
  }, [loading, authenticated, router, loadKeys]);

  async function createKey() {
    setBusy(true);
    setError(null);
    setNewKey(null);
    try {
      const response = await fetch('/api/auth/api-keys', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'default' }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { key?: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? 'Could not create key');
      setNewKey(payload.data?.key ?? null);
      await loadKeys();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await fetch('/api/auth/api-keys', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await loadKeys();
  }

  async function claimAdmin() {
    setBusy(true);
    setBootstrapMsg(null);
    setError(null);
    try {
      const response = await fetch('/api/admin/bootstrap', {
        method: 'POST',
        credentials: 'include',
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { role?: string; alreadyAdmin?: boolean };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error?.message ?? 'Bootstrap failed');
      }
      setBootstrapMsg(
        payload.data?.alreadyAdmin
          ? 'Already admin.'
          : `Promoted to ${payload.data?.role ?? 'admin'}.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !authenticated || !user) {
    return (
      <main className="auth-page">
        <p>Loading account…</p>
      </main>
    );
  }

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
        <button type="button" className="btn btn--sm" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="account">
        <div className="account__inner">
          <h1>Account</h1>
          <section className="account__card">
            <h2>Profile</h2>
            <p>
              <strong>{user.name}</strong> · {user.email}
            </p>
            <p className="faint">
              Role: {user.role} · Plan: {plan?.name ?? user.plan}
            </p>
            {user.role !== 'admin' ? (
              <p className="faint" style={{ marginTop: '0.75rem' }}>
                <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void claimAdmin()}>
                  Claim bootstrap admin
                </button>{' '}
                (only if your email matches <code>WIREUP_BOOTSTRAP_ADMIN_EMAIL</code>)
              </p>
            ) : null}
            {bootstrapMsg ? <p className="faint">{bootstrapMsg}</p> : null}
          </section>
          <section className="account__card">
            <h2>Usage this period</h2>
            {usage ? (
              <ul className="account__usage">
                <li>
                  Projects this month: <strong>{usage.projectsThisMonth}</strong>
                  {plan ? ` / ${plan.projectsPerMonth ?? '—'}` : ''}
                </li>
                <li>
                  LLM calls: <strong>{usage.llmCallsThisMonth}</strong>
                </li>
                <li>
                  Sim sessions today: <strong>{usage.simSessionsToday}</strong>
                </li>
                <li>
                  Stored projects: <strong>{usage.storedProjects}</strong>
                </li>
                <li>
                  Concurrent runs: <strong>{usage.concurrentRuns}</strong>
                </li>
              </ul>
            ) : (
              <p className="faint">No usage data.</p>
            )}
            <Link href="/pricing" className="btn btn--sm">
              View plans
            </Link>
          </section>
          <section className="account__card">
            <h2>API keys</h2>
            <p className="faint">
              Bearer <code>wup_…</code> keys for CI and integrations ({keys.length}/{keyLimit}).
            </p>
            {newKey ? (
              <p className="account__secret" role="status">
                Copy now — shown once: <code>{newKey}</code>
              </p>
            ) : null}
            {error ? <p className="auth-form__error">{error}</p> : null}
            <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void createKey()}>
              {busy ? 'Creating…' : 'Create API key'}
            </button>
            <ul className="account__keys">
              {keys.map((key) => (
                <li key={key.id}>
                  <code>{key.prefix}…</code> {key.name}{' '}
                  <button type="button" className="btn btn--sm" onClick={() => void revoke(key.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
