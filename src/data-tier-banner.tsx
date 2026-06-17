import { useEffect, useState } from 'react';
import { resolveDataTier } from './agreements.js';

/**
 * React equivalent of f2-data-tier-banner (Angular). Single canonical
 * implementation for every React SPA (members, alpha-shark-flow,
 * trend-labs-react) so the COPY + COLORS stay in lockstep with the
 * Angular SPAs.
 *
 * Self-contained: calls resolveDataTier internally. Two equally-valid
 * call shapes:
 *
 *   <DataTierBanner role={user?.role} userLiveAccess={...} />   (preferred)
 *   <DataTierBanner isAdmin={...} isClient={...} userLiveAccess={...} />
 *
 * The `role` form is the single-prop entry-point so consumer SPAs don't
 * have to derive isAdmin/isClient by hand each time the gate changes.
 * Passing `role=undefined` (user not yet loaded) suppresses the banner
 * automatically — so SPAs don't need a separate `{user && <banner/>}`
 * mount gate to keep the realtime/delayed banner off their login page.
 *
 * Render as the FIRST CHILD of the app root so it pushes content down
 * rather than overlaying.
 */

type Mode = 'delayed' | 'realtime' | 'disabled' | null;

const STYLES: Record<Exclude<Mode, null>, { bg: string; text: string }> = {
  delayed: { bg: '#f59e0b', text: 'Delayed Data Mode — F2 has switched all scanners to delayed feeds.' },
  realtime: { bg: '#2563eb', text: 'Realtime Data Mode — all users serving live data.' },
  disabled: { bg: '#dc2626', text: 'Service Disabled — F2 has temporarily disabled scanners.' },
};

export interface DataTierBannerProps {
  /**
   * Preferred prop: the user's Cognito `custom:role` lowercased
   * ('admin' | 'client' | 'member' | other). When `undefined` (no user
   * yet) the banner is suppressed — the login page never renders it.
   * When supplied, isAdmin / isClient props are ignored.
   */
  role?: string;
  isAdmin?: boolean;
  isClient?: boolean;
  userLiveAccess?: boolean;
}

export function DataTierBanner(props: DataTierBannerProps) {
  const { role, userLiveAccess = false } = props;
  const roleProvided = role !== undefined;
  const roleLower = String(role || '').trim().toLowerCase();
  const isAdmin = roleProvided ? roleLower === 'admin' : !!props.isAdmin;
  const isClient = roleProvided ? roleLower === 'client' : !!props.isClient;
  // When `role` is explicitly passed as undefined the consumer is
  // telling us "user not loaded yet" — don't even ask the backend for
  // the brand override. Saves a /rest/api/brand-config round trip on
  // every login-page mount.
  const skip = roleProvided && !role;

  const [mode, setMode] = useState<Mode>(null);

  useEffect(() => {
    if (skip) { setMode(null); return; }
    let cancelled = false;
    resolveDataTier({ userLiveAccess, isAdmin, isClient })
      .then((r: any) => { if (!cancelled) setMode((r?.bannerMode as Mode) ?? null); })
      .catch(() => { if (!cancelled) setMode(null); });
    return () => { cancelled = true; };
  }, [skip, isAdmin, isClient, userLiveAccess]);

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
