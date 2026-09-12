'use client';

import { useEffect, useMemo, useState } from 'react';

type CatalogPin = {
  name: string;
  type: string;
  direction: string;
  required: boolean;
  aliases?: string[];
};

type CatalogComponent = {
  id: string;
  name: string;
  category: string;
  description: string;
  voltage?: number;
  minVoltage?: number;
  maxVoltage?: number;
  currentRequirements?: { typicalMa?: number; maxMa?: number; note?: string };
  pins: CatalogPin[];
  aliases?: string[];
  keywords?: string[];
  simulator?: { part?: string; supported?: boolean; attrs?: Record<string, string>; notes?: string };
  metadata: Record<string, unknown>;
};

type CatalogResponse = {
  ok: boolean;
  source?: string;
  error?: string | null;
  components?: CatalogComponent[];
};

function formatVoltage(component: CatalogComponent): string {
  if (component.minVoltage !== undefined && component.maxVoltage !== undefined) return `${component.minVoltage}–${component.maxVoltage} V`;
  if (component.voltage !== undefined) return `${component.voltage} V`;
  if (component.minVoltage !== undefined) return `≥${component.minVoltage} V`;
  if (component.maxVoltage !== undefined) return `≤${component.maxVoltage} V`;
  return 'voltage not stated';
}

function formatCurrent(component: CatalogComponent): string {
  const current = component.currentRequirements;
  if (!current) return 'current not stated';
  if (current.maxMa !== undefined) return `${current.maxMa} mA max`;
  if (current.typicalMa !== undefined) return `${current.typicalMa} mA typical`;
  return 'current not stated';
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return <div className="control-section-heading"><div className="control-eyebrow">SYSTEM / AUTHORITATIVE HARDWARE DATA</div><h1>{title}</h1><p>{description}</p></div>;
}

export function CatalogView() {
  const [items, setItems] = useState<CatalogComponent[]>([]);
  const [source, setSource] = useState('loading');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/admin/catalog')
      .then(async (response) => {
        const payload = (await response.json()) as CatalogResponse;
        if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'The catalog could not be loaded.');
        if (cancelled) return;
        const next = payload.components ?? [];
        setItems(next);
        setSource(payload.source ?? 'unknown');
        setSelectedId((current) => current ?? next[0]?.id ?? null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'The catalog could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(() => [...new Set(items.map((item) => item.category))].sort(), [items]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (!needle) return true;
      return [item.id, item.name, item.category, item.description, ...(item.aliases ?? []), ...(item.keywords ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [category, items, query]);
  const selected = items.find((item) => item.id === selectedId) ?? filtered[0] ?? null;

  return (
    <>
      <div className="control-hero-row">
        <SectionHeading title="Component catalog" description="The live registry used by intake, hardware planning, wiring, CAD and simulation. If a part is not here, the agent may not silently invent it." />
        <div className="control-repo-status"><span className="control-status-dot control-status-dot--ok" /><span>{items.length || '…'} catalog parts</span><code>{source}</code></div>
      </div>

      <div className="control-catalog-callout">
        <span className="control-catalog-callout__mark">CATALOG</span>
        <div><strong>One source of truth</strong><span>This is not a separate showcase list. These are the exact component definitions the build pipeline can resolve.</span></div>
        <span className="control-catalog-callout__meta">{items.length} loaded · {filtered.length} shown</span>
      </div>

      <section className="control-card control-catalog-toolbar">
        <label className="control-catalog-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search id, name, alias or capability…" aria-label="Search catalog" /></label>
        <select className="control-select" value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter catalog category">
          <option value="all">All categories</option>
          {categories.map((value) => <option value={value} key={value}>{value.replace(/_/g, ' ')}</option>)}
        </select>
      </section>

      {error ? <div className="control-inline-notice is-warning"><span className="control-status-dot control-status-dot--blocked" />{error}</div> : null}

      <div className="control-catalog-layout">
        <section className="control-card control-catalog-list" aria-label="Catalog components">
          <div className="control-card__heading"><div><div className="control-card__eyebrow">REGISTRY / {filtered.length} MATCHES</div><h2>Available parts</h2></div><span className="control-version-pill">live read</span></div>
          <div className="control-catalog-items">
            {filtered.map((item) => (
              <button type="button" className={`control-catalog-item${selected?.id === item.id ? ' is-selected' : ''}`} key={item.id} onClick={() => setSelectedId(item.id)}>
                <span className="control-catalog-item__icon">{item.category.slice(0, 2).toUpperCase()}</span>
                <span className="control-catalog-item__body"><strong>{item.name}</strong><small>{item.id}</small></span>
                <span className="control-catalog-item__tags"><em>{item.category.replace(/_/g, ' ')}</em>{item.simulator?.part ? <em className={item.simulator.supported === false ? 'is-warning' : 'is-ok'}>{item.simulator.supported === false ? 'CAD only' : 'sim mapped'}</em> : <em className="is-warning">no sim map</em>}</span>
              </button>
            ))}
            {filtered.length === 0 ? <div className="control-empty-state"><strong>No catalog entries match.</strong><span>Try a different term or category.</span></div> : null}
          </div>
        </section>

        <aside className="control-card control-catalog-inspector" aria-label="Catalog part details">
          {selected ? (
            <>
              <div className="control-card__eyebrow">PART INSPECTOR</div>
              <h2>{selected.name}</h2>
              <code className="control-catalog-id">{selected.id}</code>
              <p className="control-catalog-description">{selected.description}</p>
              <div className="control-catalog-facts"><div><span>category</span><strong>{selected.category}</strong></div><div><span>voltage</span><strong>{formatVoltage(selected)}</strong></div><div><span>current</span><strong>{formatCurrent(selected)}</strong></div><div><span>pins</span><strong>{selected.pins.length}</strong></div></div>
              <div className="control-field-label">Simulator mapping</div>
              <div className="control-catalog-mapping"><span className={`control-status-dot control-status-dot--${selected.simulator?.part && selected.simulator.supported !== false ? 'ok' : 'blocked'}`} /><code>{selected.simulator?.part ?? 'not mapped'}</code><span>{selected.simulator?.supported === false ? 'CAD geometry only' : selected.simulator?.part ? 'available to projection' : 'requires catalog addition'}</span></div>
              <div className="control-field-label">Physical pins</div>
              <div className="control-catalog-pins">{selected.pins.map((pin) => <span key={pin.name}><strong>{pin.name}</strong><small>{pin.type} · {pin.direction}{pin.required ? ' · required' : ''}</small></span>)}</div>
              {selected.aliases?.length ? <><div className="control-field-label">Aliases</div><div className="control-chip-row">{selected.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div></> : null}
            </>
          ) : <div className="control-empty-state"><strong>Select a part</strong><span>Catalog details appear here.</span></div>}
        </aside>
      </div>
    </>
  );
}
