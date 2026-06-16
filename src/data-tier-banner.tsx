import React, { useEffect, useState } from 'react';
import { resolveDataTier } from './agreements.js';

/**
 * React equivalent of f2-data-tier-banner (Angular). Single canonical
 * implementation for every React SPA (members, alpha-shark-flow,
 * trend-labs-react) so the COPY + COLORS stay in lockstep with the
 * Angular SPAs.
 *
 * Self-contained: calls resolveDataTier internally. The caller only
 * passes auth context (`isAdmin`, optional `userLiveAccess`). Render
 * as the FIRST CHILD of the app root so it pushes content down rather
 * than overlaying.
 */

type Mode = 'delayed' | 'realtime' | 'disabled' | null;

const STYLES: Record<Exclude<Mode, null>, { bg: string; text: string }> = {
  delayed: { bg: '#f59e0b', text: 'Delayed Data Mode — F2 has switched all scanners to delayed feeds.' },
  realtime: { bg: '#2563eb', text: 'Realtime Data Mode — all users serving live data.' },
  disabled: { bg: '#dc2626', text: 'Service Disabled — F2 has temporarily disabled scanners.' },
};

export interface DataTierBannerProps {
  isAdmin: boolean;
  userLiveAccess?: boolean;
}

export function DataTierBanner({ isAdmin, userLiveAccess = false }: DataTierBannerProps) {
  const [mode, setMode] = useState<Mode>(null);

  useEffect(() => {
    let cancelled = false;
    resolveDataTier({ userLiveAccess, isAdmin })
      .then((r: any) => { if (!cancelled) setMode((r?.bannerMode as Mode) ?? null); })
      .catch(() => { if (!cancelled) setMode(null); });
    return () => { cancelled = true; };
  }, [isAdmin, userLiveAccess]);

  if (!mode) return null;
  const cfg = STYLES[mode];
  return (
    <div
      style={{
        width: '100%',
        padding: '8px 16px',
        textAlign: 'center',
        color: 'white',
        fontSize: 14,
        fontWeight: 500,
        boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
        background: cfg.bg,
      }}
      role="status"
      aria-live="polite"
    >
      {cfg.text}
    </div>
  );
}
