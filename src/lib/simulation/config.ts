/**
 * Simulation endpoints.
 *
 * Product mode prefers a HOSTED Velxio URL (WIREUP_VELXIO_URL). Localhost is
 * only the developer fallback — never the default story told to end users.
 *
 * The generated dashboard is served by Wireup itself at
 * `/api/projects/:id/simulation/dashboard/` so users do not run a second
 * Vite server. WIREUP_WEBSITE_URL overrides that when you deliberately want
 * an external dashboard host.
 */

export interface SimulationEndpoints {
  /** Velxio frontend (the emulator canvas). Empty string = not configured. */
  velxioUrl: string;
  /** Dashboard origin or path. */
  websiteUrl: string;
  /** Which half the page opens on. */
  defaultView: 'simulation' | 'website';
  /** True when Velxio is a real hosted/public URL (not localhost). */
  velxioHosted: boolean;
  /** True when the dashboard is the in-app preview (no user zip server). */
  dashboardHosted: boolean;
}

function clean(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    // Allow relative paths like /api/projects/x/simulation/dashboard
    if (trimmed.startsWith('/')) return trimmed.replace(/\/$/, '');
    return '';
  }
}

function isLocalhost(url: string): boolean {
  if (!url) return true;
  try {
    const host = new URL(url, 'http://localhost').hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return true;
  }
}

export function simulationConfig(projectId?: string): SimulationEndpoints {
  const fromEnv = clean(process.env.WIREUP_VELXIO_URL);
  const websiteOverride = clean(process.env.WIREUP_WEBSITE_URL);
  const view = process.env.WIREUP_SIM_DEFAULT_VIEW?.trim().toLowerCase();

  const velxioUrl = fromEnv;
  const dashboardHosted = !websiteOverride;
  const websiteUrl =
    websiteOverride ||
    (projectId ? `/api/projects/${projectId}/simulation/dashboard` : '/api/simulation/dashboard-placeholder');

  const velxioHosted = Boolean(velxioUrl) && !isLocalhost(velxioUrl);

  return {
    velxioUrl,
    websiteUrl,
    defaultView: view === 'website' || !velxioUrl ? 'website' : 'simulation',
    velxioHosted,
    dashboardHosted,
  };
}
