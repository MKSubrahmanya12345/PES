/**
 * Product auth + metering unit tests (no network, no Mongo).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, signSession, verifyPassword, verifySession, generateApiKey, hashApiKey } from './crypto';
import { checkProjectCreate, planOf, PLANS } from './plans';
import { memoryResetUsers } from '@/lib/store/users-memory';
import { createUser, getUserByEmail, findUserByApiKeyHash, addApiKey } from './users';
import { resetEnvCache } from '@/lib/validation/env';
import { resetMemoryDb } from '@/lib/store/memory';
import { createProjectRecord, listProjectStates, countProjectsForOwner } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';

beforeEach(() => {
  process.env.WIREUP_IN_MEMORY_STORE = 'true';
  process.env.WIREUP_AUTH_REQUIRED = 'true';
  process.env.WIREUP_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
  process.env.MONGODB_URI = '';
  resetEnvCache();
  memoryResetUsers();
  resetMemoryDb();
});

describe('password + jwt', () => {
  it('hashes and verifies passwords', () => {
    const hash = hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('signs and verifies session tokens', async () => {
    const token = await signSession({
      sub: 'user_1',
      email: 'a@b.co',
      role: 'user',
      plan: 'free',
      name: 'Ada',
    });
    const claims = await verifySession(token);
    expect(claims?.sub).toBe('user_1');
    expect(claims?.email).toBe('a@b.co');
    expect(await verifySession('garbage')).toBeNull();
  });

  it('rejects hardcoded-style weak admin tokens', async () => {
    expect(await verifySession(`wireup_adm_${Date.now()}_auth_token`)).toBeNull();
  });
});

describe('users + api keys', () => {
  it('creates unique users and looks them up', async () => {
    const user = await createUser({
      email: 'maker@example.com',
      name: 'Maker',
      passwordHash: hashPassword('password123'),
    });
    expect(user.plan).toBe('free');
    const found = await getUserByEmail('Maker@Example.com');
    expect(found?.id).toBe(user.id);

    await expect(
      createUser({
        email: 'maker@example.com',
        name: 'Dup',
        passwordHash: hashPassword('password123'),
      }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('stores api keys by hash only', async () => {
    const user = await createUser({
      email: 'api@example.com',
      name: 'API',
      passwordHash: hashPassword('password123'),
    });
    const material = generateApiKey();
    await addApiKey(
      user.id,
      {
        id: createId('key'),
        prefix: material.prefix,
        hash: material.hash,
        name: 'ci',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      },
      5,
    );
    const found = await findUserByApiKeyHash(hashApiKey(material.raw));
    expect(found?.id).toBe(user.id);
    expect(found?.apiKeys[0]?.hash).not.toContain(material.raw.slice(12));
  });
});

describe('metering + ownership', () => {
  it('blocks project create past free quota', () => {
    const plan = planOf('free');
    const decision = checkProjectCreate(plan, {
      projectsThisMonth: plan.projectsPerMonth,
      llmCallsThisMonth: 0,
      simSessionsToday: 0,
      storedProjects: 0,
      concurrentRuns: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('project_quota');
  });

  it('scopes project lists to owner', async () => {
    const a = await createUser({
      email: 'a@x.co',
      name: 'A',
      passwordHash: hashPassword('password123'),
    });
    const b = await createUser({
      email: 'b@x.co',
      name: 'B',
      passwordHash: hashPassword('password123'),
    });
    await createProjectRecord({ prompt: 'Build a blinking LED with an Arduino Uno board now.', ownerId: a.id });
    await createProjectRecord({ prompt: 'Build a temperature logger with DHT22 and OLED.', ownerId: b.id });
    await createProjectRecord({ prompt: 'Build a second LED project for owner A please.', ownerId: a.id });

    const listA = await listProjectStates(50, a.id);
    const listB = await listProjectStates(50, b.id);
    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
    expect(listA.every((p) => p.ownerId === a.id)).toBe(true);
    expect(await countProjectsForOwner(a.id)).toBe(2);
  });

  it('exposes paid plans with real limits', () => {
    expect(PLANS.pro.projectsPerMonth).toBeGreaterThan(PLANS.free.projectsPerMonth);
    expect(PLANS.team.seats).toBeGreaterThan(1);
    expect(PLANS.free.priceMonthlyUsd).toBe(0);
  });
});
