/**
 * MongoDB user model — accounts, plans, usage, API keys.
 */

import mongoose, { type Model, type Types } from 'mongoose';

import type { PlanId } from '@/lib/auth/plans';
import type { UserRole } from '@/lib/auth/types';

export interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  plan: PlanId;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
  usage: {
    monthKey: string;
    projectsThisMonth: number;
    llmCallsThisMonth: number;
    dayKey: string;
    simSessionsToday: number;
  };
  apiKeys: {
    id: string;
    prefix: string;
    hash: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

const Mixed = mongoose.Schema.Types.Mixed;

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    plan: { type: String, enum: ['free', 'pro', 'team', 'enterprise'], default: 'free', index: true },
    orgId: { type: String, default: null, index: true },
    usage: {
      type: Mixed,
      default: () => ({
        monthKey: '',
        projectsThisMonth: 0,
        llmCallsThisMonth: 0,
        dayKey: '',
        simSessionsToday: 0,
      }),
    },
    apiKeys: { type: Mixed, default: [] },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    versionKey: false,
    collection: 'users',
  },
);

export function getUserModel(): Model<UserDocument> {
  return (mongoose.models.User as Model<UserDocument>) || mongoose.model<UserDocument>('User', UserSchema);
}

export default getUserModel;
