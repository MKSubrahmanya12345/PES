/**
 * In-memory user store — same contract as Mongo path for zero-infra dev.
 */

import type { UserRecord } from '@/lib/auth/types';

interface UsersDb {
  users: Map<string, UserRecord>;
  byEmail: Map<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupUsersDb: UsersDb | undefined;
}

function db(): UsersDb {
  if (!globalThis.__wireupUsersDb) {
    globalThis.__wireupUsersDb = { users: new Map(), byEmail: new Map() };
  }
  return globalThis.__wireupUsersDb;
}

export function memoryResetUsers(): void {
  globalThis.__wireupUsersDb = { users: new Map(), byEmail: new Map() };
}

export function memoryCreateUser(user: UserRecord): UserRecord {
  const store = db();
  const email = user.email.toLowerCase();
  if (store.byEmail.has(email)) throw new Error('email_taken');
  store.users.set(user.id, { ...user, email });
  store.byEmail.set(email, user.id);
  return store.users.get(user.id)!;
}

export function memoryGetUserById(id: string): UserRecord | null {
  return db().users.get(id) ?? null;
}

export function memoryGetUserByEmail(email: string): UserRecord | null {
  const id = db().byEmail.get(email.toLowerCase());
  if (!id) return null;
  return db().users.get(id) ?? null;
}

export function memorySaveUser(id: string, patch: Partial<UserRecord>): UserRecord | null {
  const store = db();
  const current = store.users.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
  store.users.set(id, next);
  if (patch.email && patch.email.toLowerCase() !== current.email) {
    store.byEmail.delete(current.email);
    store.byEmail.set(patch.email.toLowerCase(), id);
  }
  return next;
}

export function memoryFindUserByApiKeyHash(hash: string): UserRecord | null {
  for (const user of db().users.values()) {
    if (user.apiKeys.some((key) => key.hash === hash)) return user;
  }
  return null;
}

export function memoryCountUsers(): number {
  return db().users.size;
}
