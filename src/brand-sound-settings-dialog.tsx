// Per-customer brand-sound Settings dialog — React component.
// Sibling of brand-sound-settings-dialog.component.ts (Angular).
// Shares backend contract via brand-alert-sound.js.
//
// Mount from any admin / operator SPA:
//
//   const [open, setOpen] = useState(false);
//   // ...toolbar:
//   <button onClick={() => setOpen(true)}>Sound settings</button>
//   {open && (
//     <BrandSoundSettingsDialog
//       apiBase="/rest"
//       customersListPath="/admin/customer-directory/"
//       customerPutPathPrefix="/admin/customer-directory/"
//       onClose={() => setOpen(false)}
//     />
//   )}

import React, { useEffect, useRef, useState } from 'react';
import {
  BRAND_SOUND_INSTRUMENTS,
  BRAND_SOUND_NOTES,
  invalidateBrandSoundCustomer,
  previewBrandSound,
} from './brand-alert-sound.js';

export interface BrandSoundSettingsDialogProps {
  /** Base path up to and including `/rest`. Default '/rest'. */
  apiBase?: string;
  /** Customer list GET endpoint. Default '/admin/customer-directory/'. */
  customersListPath?: string;
  /** Customer PUT endpoint prefix (slug appended). */
  customerPutPathPrefix?: string;
  /** Field on the Customer doc that stores the sound sub-doc. Default 'error_alert_sound'. */
  configField?: string;
  /** 'f2' row surfaced at top. */
  defaultSlug?: string;
  /** Dialog title. */
  title?: string;
  /** Include credentials on fetches. Default true. */
  withCredentials?: boolean;
  onClose: () => void;
}

interface CustomerRow {
  _id: string;
  name?: string;
  error_alert_sound?: { enabled: boolean; instrument: string; note: string };
  _saveState?: 'saving' | 'saved' | 'error' | null;
  _saveErr?: string;
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

export function BrandSoundSettingsDialog(props: BrandSoundSettingsDialogProps) {
  const {
    apiBase = '/rest',
    customersListPath = '/admin/customer-directory/',
    customerPutPathPrefix = '/admin/customer-directory/',
    configField = 'error_alert_sound',
    defaultSlug = 'f2',
    title = 'Alert Sound Settings',
    withCredentials = true,
    onClose,
  } = props;

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const saveTimers = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const url = joinUrl(apiBase, customersListPath);
        const res = await fetch(url, { credentials: withCredentials ? 'include' : 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const list: CustomerRow[] = Array.isArray(body) ? body : [];
        list.sort((a, b) => {
          if (a._id === defaultSlug) return -1;
          if (b._id === defaultSlug) return 1;
          return (a.name || a._id).toLowerCase().localeCompare((b.name || b._id).toLowerCase());
        });
        if (configField !== 'error_alert_sound') {
          for (const c of list) {
            const anyC: any = c;
            if (anyC[configField] && !anyC.error_alert_sound) {
              anyC.error_alert_sound = anyC[configField];
            }
          }
        }
        if (!cancelled) setCustomers(list);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || 'Failed to load customers');
          setCustomers([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, customersListPath, configField, defaultSlug, withCredentials]);

  function ensureSound(c: CustomerRow) {
    if (!c.error_alert_sound) {
      c.error_alert_sound = { enabled: false, instrument: 'acoustic_grand_piano', note: 'C5' };
    }
  }

  function scheduleSave(c: CustomerRow) {
    const existing = saveTimers.current.get(c._id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      saveTimers.current.delete(c._id);
      // Mutate the row in-place; trigger a re-render with a fresh array copy.
      c._saveState = 'saving';
      setCustomers((prev) => [...prev]);
      try {
        const url = joinUrl(apiBase, customerPutPathPrefix + encodeURIComponent(c._id));
        const payload: any = {};
        payload[configField] = c.error_alert_sound;
        const res = await fetch(url, {
          method: 'PUT',
          credentials: withCredentials ? 'include' : 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        c._saveState = 'saved';
        invalidateBrandSoundCustomer(c._id);
        setCustomers((prev) => [...prev]);
        setTimeout(() => {
          if (c._saveState === 'saved') {
            c._saveState = null;
            setCustomers((prev) => [...prev]);
          }
        }, 2000);
      } catch (e: any) {
        c._saveState = 'error';
        c._saveErr = e?.message || 'save failed';
        setCustomers((prev) => [...prev]);
      }
    }, 500);
    saveTimers.current.set(c._id, t);
  }

  function onEnabled(c: CustomerRow, v: boolean) {
    ensureSound(c);
    c.error_alert_sound!.enabled = v;
    setCustomers((prev) => [...prev]);
    scheduleSave(c);
  }
  function onInstrument(c: CustomerRow, v: string) {
    ensureSound(c);
    c.error_alert_sound!.instrument = v;
    setCustomers((prev) => [...prev]);
    scheduleSave(c);
  }
  function onNote(c: CustomerRow, v: string) {
    ensureSound(c);
    c.error_alert_sound!.note = v;
    setCustomers((prev) => [...prev]);
    scheduleSave(c);
  }
  function preview(c: CustomerRow) {
    ensureSound(c);
    previewBrandSound(
      c.error_alert_sound!.instrument || 'acoustic_grand_piano',
      c.error_alert_sound!.note || 'C5',
    );
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)',
               display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#161827', border: '1px solid #434863', borderRadius: 8,
                 boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
                 width: 860, maxWidth: '95vw', maxHeight: '85vh',
                 display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: 16, borderBottom: '1px solid #434863' }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', margin: 0 }}>{title}</h2>
          <button onClick={onClose}
                  style={{ color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer',
                           fontSize: 18 }}>
            &times;
          </button>
        </div>

        <div style={{ padding: 16, fontSize: 12, color: '#9ca3af', borderBottom: '1px solid #434863' }}>
          Per-customer alert tone played when a scoped event lands. Operator-level mute + volume live in
          the toolbar. The <strong style={{ color: '#fff' }}>f2 (Default / non-customer reports)</strong>{' '}
          row covers events without a customer slug.
        </div>

        {loading && (
          <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
            Loading customer list&hellip;
          </div>
        )}

        {!loading && err && (
          <div style={{ padding: 16, fontSize: 14, color: '#f87171' }}>{err}</div>
        )}

        {!loading && !err && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex',
                        flexDirection: 'column', gap: 8 }}>
            {customers.map((c) => {
              const enabled = c.error_alert_sound?.enabled === true;
              return (
                <div key={c._id}
                     style={{ display: 'flex', alignItems: 'center', gap: 12,
                              border: '1px solid #434863', borderRadius: 4,
                              padding: '8px 12px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: '#fff', overflow: 'hidden',
                                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name || c._id}
                      {c._id === defaultSlug && (
                        <span style={{ marginLeft: 6, fontSize: 10, textTransform: 'uppercase',
                                       color: '#fbbf24' }}>default</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>
                      {c._id}
                    </div>
                  </div>

                  <label style={{ fontSize: 12, color: '#d1d5db', display: 'flex',
                                  alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={enabled}
                           onChange={(e) => onEnabled(c, e.currentTarget.checked)} />
                    Enabled
                  </label>

                  <select value={c.error_alert_sound?.instrument || 'acoustic_grand_piano'}
                          onChange={(e) => onInstrument(c, e.currentTarget.value)}
                          disabled={!enabled}
                          style={{ background: '#1f2234', border: '1px solid #434863',
                                   color: '#e5e7eb', fontSize: 12, padding: '4px 8px',
                                   borderRadius: 4 }}>
                    {BRAND_SOUND_INSTRUMENTS.map((i) => (
                      <option key={i.value} value={i.value}>{i.label}</option>
                    ))}
                  </select>

                  <select value={c.error_alert_sound?.note || 'C5'}
                          onChange={(e) => onNote(c, e.currentTarget.value)}
                          disabled={!enabled}
                          style={{ background: '#1f2234', border: '1px solid #434863',
                                   color: '#e5e7eb', fontSize: 12, padding: '4px 8px',
                                   borderRadius: 4, width: 72 }}>
                    {BRAND_SOUND_NOTES.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>

                  <button onClick={() => preview(c)}
                          title="Preview this sound"
                          style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #434863',
                                   borderRadius: 4, color: '#d1d5db', background: 'transparent',
                                   cursor: 'pointer' }}>
                    &#9835;
                  </button>

                  <div style={{ width: 48, textAlign: 'right' }}>
                    {c._saveState === 'saving' && <span style={{ fontSize: 10, color: '#9ca3af' }}>Saving&hellip;</span>}
                    {c._saveState === 'saved'  && <span style={{ fontSize: 10, color: '#4ade80' }}>&#10003; Saved</span>}
                    {c._saveState === 'error'  && (
                      <span style={{ fontSize: 10, color: '#f87171' }} title={c._saveErr || 'Save failed'}>
                        &#10005; Failed
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ padding: 12, borderTop: '1px solid #434863', display: 'flex',
                      justifyContent: 'space-between', alignItems: 'center',
                      fontSize: 10, color: '#6b7280' }}>
          <div>Changes auto-save 500ms after the last edit.</div>
          <button onClick={onClose}
                  style={{ fontSize: 12, padding: '6px 12px', background: '#1f2234',
                           border: '1px solid #434863', color: '#e5e7eb', borderRadius: 4,
                           cursor: 'pointer' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
