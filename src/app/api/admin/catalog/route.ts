import { NextResponse } from 'next/server';

import { getCatalog } from '@/modules/components';

export const dynamic = 'force-dynamic';

/**
 * Read-only admin view of the same catalog the build pipeline consumes.
 * There is deliberately no second admin-only parts list: the UI reads this
 * endpoint so what is visible in the control plane is what the planner can
 * actually select.
 */
export async function GET() {
  try {
    const catalog = await getCatalog();
    return NextResponse.json({
      ok: true,
      source: catalog.source,
      loadedAt: catalog.loadedAt,
      error: catalog.error ?? null,
      total: catalog.components.length,
      components: catalog.components,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to read the component catalog.' },
      { status: 500 },
    );
  }
}
