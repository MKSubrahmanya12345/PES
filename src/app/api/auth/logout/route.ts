import { NextResponse } from 'next/server';

import { clearSessionCookie } from '@/lib/auth/session';
import { jsonOk } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const response = jsonOk({ signedOut: true });
  return clearSessionCookie(response);
}
