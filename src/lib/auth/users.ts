/**
 * User repository — Mongo or in-memory, same shapes.
 */

import { getUserModel, type UserDocument } from '@/models/User';
import type { PlanId } from '@/lib/auth/plans';
import { utcDayKey, utcMonthKey } from '@/lib/auth/plans';
import type { ApiKeyRecord, UserRecord, UserRole } from '@/lib/auth/types';
import { connectMongo } from '@/lib/mongodb/client';
import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import {
  memoryCreateUser,
  memoryFindUserByApiKeyHash,
  memoryGetUserByEmail,
  memoryGetUserById,
  memorySaveUser,
} from '@/lib/store/users-memory';

function useMemory(): boolean {
  return env().store.mode === 'memory';
}

function emptyUsage() {
  return {
    monthKey: utcMonthKey(),
    projectsThisMonth: 0,
    llmCallsThisMonth: 0,
    dayKey: utcDayKey(),
    simSessionsToday: 0,
  };
}

function serialize(doc: UserDocument | UserRecord): UserRecord {
  if ('passwordHash' in doc && typeof (doc as UserRecord).id === 'string' && !('_id' in doc)) {
    return doc as UserRecord;
  }
  const raw = doc as UserDocument;
  return {
    id: raw._id.toString(),
    email: raw.email,
    name: raw.name,
    passwordHash: raw.passwordHash,
    role: raw.role,
    plan: raw.plan,
    orgId: raw.orgId ?? null,
    createdAt: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : String(raw.createdAt),
    updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : String(raw.updatedAt),
    usage: raw.usage?.monthKey ? raw.usage : emptyUsage(),
    apiKeys: Array.isArray(raw.apiKeys) ? raw.apiKeys : [],
    stripeCustomerId: raw.stripeCustomerId ?? null,
    stripeSubscriptionId: raw.stripeSubscriptionId ?? null,
  };
}

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role?: UserRole;
  plan?: PlanId;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const email = input.email.trim().toLowerCase();
  const at = nowIso();
  const record: UserRecord = {
    id: createId('user'),
    email,
    name: input.name.trim().slice(0, 80) || email.split('@')[0] || 'Maker',
    passwordHash: input.passwordHash,
    role: input.role ?? 'user',
    plan: input.plan ?? 'free',
    orgId: null,
    createdAt: at,
    updatedAt: at,
    usage: emptyUsage(),
    apiKeys: [],
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  };

  if (useMemory()) {
    try {
      return memoryCreateUser(record);
    } catch {
      throw new UserError('email_taken', 'An account with that email already exists.');
    }
  }

  await connectMongo();
  const User = getUserModel();
  try {
    const doc = await User.create({
      email: record.email,
      name: record.name,
      passwordHash: record.passwordHash,
      role: record.role,
      plan: record.plan,
      orgId: null,
      usage: record.usage,
      apiKeys: [],
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    return serialize(doc.toObject() as UserDocument);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000) {
      throw new UserError('email_taken', 'An account with that email already exists.');
    }
    throw error;
  }
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  if (useMemory()) return memoryGetUserById(id);
  await connectMongo();
  const User = getUserModel();
  const doc = await User.findById(id).lean();
  return doc ? serialize(doc as UserDocument) : null;
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const normalised = email.trim().toLowerCase();
  if (useMemory()) return memoryGetUserByEmail(normalised);
  await connectMongo();
  const User = getUserModel();
  const doc = await User.findOne({ email: normalised }).lean();
  return doc ? serialize(doc as UserDocument) : null;
}

export async function saveUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
  if (useMemory()) return memorySaveUser(id, patch);
  await connectMongo();
  const User = getUserModel();
  const { id: _drop, createdAt: _c, ...rest } = patch as Partial<UserRecord> & { id?: string; createdAt?: string };
  const doc = await User.findByIdAndUpdate(id, { $set: rest }, { new: true }).lean();
  return doc ? serialize(doc as UserDocument) : null;
}

/** Roll usage windows forward if the calendar period changed. */
export function rollUsage(user: UserRecord): UserRecord {
  const month = utcMonthKey();
  const day = utcDayKey();
  let usage = { ...user.usage };
  if (usage.monthKey !== month) {
    usage = { ...usage, monthKey: month, projectsThisMonth: 0, llmCallsThisMonth: 0 };
  }
  if (usage.dayKey !== day) {
    usage = { ...usage, dayKey: day, simSessionsToday: 0 };
  }
  return { ...user, usage };
}

export async function incrementUsage(
  userId: string,
  field: 'projectsThisMonth' | 'llmCallsThisMonth' | 'simSessionsToday',
  by = 1,
): Promise<UserRecord | null> {
  const current = await getUserById(userId);
  if (!current) return null;
  const rolled = rollUsage(current);
  const usage = { ...rolled.usage, [field]: (rolled.usage[field] ?? 0) + by };
  return saveUser(userId, { usage });
}

export async function findUserByApiKeyHash(hash: string): Promise<UserRecord | null> {
  if (useMemory()) return memoryFindUserByApiKeyHash(hash);
  await connectMongo();
  const User = getUserModel();
  const doc = await User.findOne({ 'apiKeys.hash': hash }).lean();
  return doc ? serialize(doc as UserDocument) : null;
}

export async function addApiKey(userId: string, key: ApiKeyRecord, maxKeys: number): Promise<UserRecord | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  if (user.apiKeys.length >= maxKeys) {
    throw new UserError('api_key_limit', `Your plan allows ${maxKeys} API key(s). Revoke one first.`);
  }
  return saveUser(userId, { apiKeys: [...user.apiKeys, key] });
}

export async function revokeApiKey(userId: string, keyId: string): Promise<UserRecord | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  return saveUser(userId, { apiKeys: user.apiKeys.filter((key) => key.id !== keyId) });
}

export class UserError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}
