// Per-customer brand-sound Settings dialog — Angular standalone component.
// Sibling of brand-sound-settings-dialog.tsx (React). Shares the same
// backend contract via brand-alert-sound.js.
//
// Mount from any admin / operator SPA that imports brand-alert-sound:
//
//   @Component({ ..., imports: [BrandSoundSettingsDialogComponent] })
//   ...
//   showSoundSettings = false;
//   // In template:
//   <brand-sound-settings-dialog
//     *ngIf="showSoundSettings"
//     apiBase="/rest"
//     [customersListPath]="'/admin/customer-directory/'"
//     [customerPutPathPrefix]="'/admin/customer-directory/'"
//     (close)="showSoundSettings = false">
//   </brand-sound-settings-dialog>
//
// The dialog fetches the customers list, lets the operator pick instrument
// + note per customer (debounced auto-save), fires preview via
// previewBrandSound, and invalidates the per-slug cache on each save.

import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  BRAND_SOUND_INSTRUMENTS,
  BRAND_SOUND_NOTES,
  invalidateBrandSoundCustomer,
  previewBrandSound,
} from './brand-alert-sound.js';

interface CustomerRow {
  _id: string;
  name?: string;
  error_alert_sound?: { enabled: boolean; instrument: string; note: string };
  _saveState?: 'saving' | 'saved' | 'error' | null;
  _saveErr?: string;
}

@Component({
  selector: 'brand-sound-settings-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center"
         (click)="onBackdropClick($event)">
      <div class="bg-app-black-100 border border-[#434863] rounded-lg shadow-2xl w-[860px] max-w-[95vw] max-h-[85vh] flex flex-col"
           (click)="$event.stopPropagation()">
        <div class="flex items-center justify-between p-4 border-b border-[#434863]">
          <h2 class="text-base font-semibold text-white">
            <i class="fa-solid fa-music mr-2 text-app-teal-100"></i>
            {{ title }}
          </h2>
          <button type="button" (click)="close.emit()"
                  class="text-gray-400 hover:text-white text-lg" title="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="p-4 text-xs text-gray-400 border-b border-[#434863]">
          Per-customer alert tone played when a scoped event lands. Operator-level mute + volume live in the toolbar.
          The <b class="text-white">f2 (Default / non-customer reports)</b> row covers events without a customer slug.
        </div>

        <div *ngIf="loading" class="p-8 text-center text-gray-400 text-sm">
          <i class="fa-solid fa-spinner fa-spin mr-2"></i> Loading customer list&hellip;
        </div>

        <div *ngIf="!loading && err" class="p-4 text-sm text-red-400">{{ err }}</div>

        <div *ngIf="!loading && !err" class="flex-1 overflow-y-auto p-4 space-y-2">
          <div *ngFor="let c of customers"
               class="flex items-center gap-3 border border-[#434863] rounded px-3 py-2 hover:bg-app-black-200/40">
            <div class="flex-1 min-w-0">
              <div class="text-sm text-white truncate">
                {{ c.name || c._id }}
                <span *ngIf="c._id === defaultSlug" class="ml-1 text-[10px] uppercase tracking-wide text-amber-400">default</span>
              </div>
              <div class="text-[10px] text-gray-500 truncate font-mono">{{ c._id }}</div>
            </div>

            <label class="text-xs text-gray-300 flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox"
                     [checked]="c.error_alert_sound?.enabled === true"
                     (change)="onEnabledChange(c, $any($event.target).checked)" />
              Enabled
            </label>

            <select [ngModel]="c.error_alert_sound?.instrument || 'acoustic_grand_piano'"
                    (ngModelChange)="onInstrumentChange(c, $event)"
                    class="bg-app-black-200 border border-[#434863] text-gray-200 text-xs px-2 py-1 rounded"
                    [disabled]="c.error_alert_sound?.enabled !== true">
              <option *ngFor="let i of instruments" [value]="i.value">{{ i.label }}</option>
            </select>

            <select [ngModel]="c.error_alert_sound?.note || 'C5'"
                    (ngModelChange)="onNoteChange(c, $event)"
                    class="bg-app-black-200 border border-[#434863] text-gray-200 text-xs px-2 py-1 rounded w-20"
                    [disabled]="c.error_alert_sound?.enabled !== true">
              <option *ngFor="let n of notes" [value]="n">{{ n }}</option>
            </select>

            <button type="button" (click)="preview(c)"
                    class="text-xs px-2 py-1 border border-[#434863] rounded text-gray-300 hover:bg-app-black-200"
                    title="Preview this sound">
              <i class="fa-solid fa-volume-high"></i>
            </button>

            <div class="w-12 text-right">
              <span *ngIf="c._saveState === 'saving'" class="text-[10px] text-gray-400">Saving&hellip;</span>
              <span *ngIf="c._saveState === 'saved'" class="text-[10px] text-green-400">&#10003; Saved</span>
              <span *ngIf="c._saveState === 'error'" class="text-[10px] text-red-400"
                    [title]="c._saveErr || 'Save failed'">
                &#10005; Failed
              </span>
            </div>
          </div>
        </div>

        <div class="p-3 border-t border-[#434863] flex justify-between items-center text-[10px] text-gray-500">
          <div>Changes auto-save 500ms after the last edit.</div>
          <button type="button" (click)="close.emit()" class="dark-btn">Done</button>
        </div>
      </div>
    </div>
  `,
})
export class BrandSoundSettingsDialogComponent implements OnInit {
  /** Base path up to and including `/rest`. Example: '/rest' when same-origin. */
  @Input() apiBase = '/rest';
  /** Customer list GET endpoint (relative to apiBase). Default matches f2-admin-service. */
  @Input() customersListPath = '/admin/customer-directory/';
  /** Customer PUT endpoint prefix (slug appended). */
  @Input() customerPutPathPrefix = '/admin/customer-directory/';
  /** Field on the Customer doc that stores the sound sub-doc. */
  @Input() configField = 'error_alert_sound';
  /** 'f2' row label hint. */
  @Input() defaultSlug = 'f2';
  /** Dialog title. */
  @Input() title = 'Alert Sound Settings';
  /** Include credentials on fetches (same-site admin surfaces). */
  @Input() withCredentials = true;

  @Output() close = new EventEmitter<void>();

  customers: CustomerRow[] = [];
  loading = true;
  err: string | null = null;
  readonly instruments = BRAND_SOUND_INSTRUMENTS;
  readonly notes = BRAND_SOUND_NOTES;

  private _saveDebounce: Map<string, any> = new Map();

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.loading = true;
    this.err = null;
    try {
      const url = this._join(this.apiBase, this.customersListPath);
      const res = await fetch(url, { credentials: this.withCredentials ? 'include' : 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list: CustomerRow[] = Array.isArray(body) ? body : [];
      list.sort((a, b) => {
        if (a._id === this.defaultSlug) return -1;
        if (b._id === this.defaultSlug) return 1;
        return (a.name || a._id).toLowerCase().localeCompare((b.name || b._id).toLowerCase());
      });
      // Normalize the configured field into error_alert_sound so the template
      // uses one slot regardless of which configField was picked.
      if (this.configField !== 'error_alert_sound') {
        for (const c of list) {
          const anyC: any = c;
          if (anyC[this.configField] && !anyC.error_alert_sound) {
            anyC.error_alert_sound = anyC[this.configField];
          }
        }
      }
      this.customers = list;
    } catch (e: any) {
      this.err = e?.message || 'Failed to load customers';
      this.customers = [];
    }
    this.loading = false;
  }

  onBackdropClick(_e: MouseEvent) { this.close.emit(); }

  private _ensureSound(c: CustomerRow) {
    if (!c.error_alert_sound) {
      c.error_alert_sound = { enabled: false, instrument: 'acoustic_grand_piano', note: 'C5' };
    }
  }

  onEnabledChange(c: CustomerRow, v: boolean) {
    this._ensureSound(c);
    c.error_alert_sound!.enabled = v;
    this._save(c);
  }

  onInstrumentChange(c: CustomerRow, v: string) {
    this._ensureSound(c);
    c.error_alert_sound!.instrument = v;
    this._save(c);
  }

  onNoteChange(c: CustomerRow, v: string) {
    this._ensureSound(c);
    c.error_alert_sound!.note = v;
    this._save(c);
  }

  preview(c: CustomerRow) {
    this._ensureSound(c);
    previewBrandSound(
      c.error_alert_sound!.instrument || 'acoustic_grand_piano',
      c.error_alert_sound!.note || 'C5',
    );
  }

  private _join(base: string, path: string): string {
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    const p = path.startsWith('/') ? path : '/' + path;
    return b + p;
  }

  private _save(c: CustomerRow) {
    const existing = this._saveDebounce.get(c._id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      this._saveDebounce.delete(c._id);
      c._saveState = 'saving';
      try {
        const url = this._join(this.apiBase, this.customerPutPathPrefix + encodeURIComponent(c._id));
        const body: any = {};
        body[this.configField] = c.error_alert_sound;
        const res = await fetch(url, {
          method: 'PUT',
          credentials: this.withCredentials ? 'include' : 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        c._saveState = 'saved';
        invalidateBrandSoundCustomer(c._id);
        setTimeout(() => { if (c._saveState === 'saved') c._saveState = null; }, 2000);
      } catch (e: any) {
        c._saveState = 'error';
        c._saveErr = e?.message || 'save failed';
      }
    }, 500);
    this._saveDebounce.set(c._id, t);
  }
}
