'use client';

/**
 * Shared live state for a project's output pages.
 *
 * The `/project/[id]` layout runs the single `useProjectStream` poller once and
 * exposes the result through this context, so every child "page" (Overview,
 * Parts, Wiring, Firmware, Guide, Quality, Run log) renders the same live
 * project without each re-fetching or re-polling.
 */

import { createContext, useContext } from 'react';

import type { AgentEvent } from '@/types/generation';
import type { GenerationStage, ProjectState } from '@/types/project';

export interface HubValue {
  project: ProjectState | null;
  events: AgentEvent[];
  running: boolean;
  terminal: boolean;
  stage: GenerationStage;
  revision: number;
  error: string | null;
  polledAt: number | null;
  lastEventAt: string | null;
  refresh: () => Promise<void>;
  /** "Show technical detail" toggle — reveals provenance, ids, raw JSON, etc. */
  details: boolean;
  toggleDetails: () => void;
  /**
   * The terminal dock: whether it is open, and the gate it watches. Any tab can
   * open it (the /simulation page's Website half does), and it opens itself once
   * `checks.passed` flips true.
   */
  dockOpen: boolean;
  openDock: () => void;
  closeDock: () => void;
  toggleDock: () => void;
  checks: { passed: boolean; label: string; detail: string };
}

export const HubContext = createContext<HubValue | null>(null);

export function useHub(): HubValue {
  const value = useContext(HubContext);
  if (!value) throw new Error('useHub must be used within <ProjectHub>.');
  return value;
}
