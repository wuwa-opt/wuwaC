import type { CSSProperties, ReactNode } from 'react';
import type { Attribute } from '../../data/schema.ts';
import { useReveal } from '../motion.ts';

/* Shared terminal primitives. One source of truth for panel chrome so
 * pages stay consistent without restyling each other. Accessible names
 * live at the call site — this file only styles. Class strings live in
 * ./classes.ts (components only here, per the react-refresh rule). */

type AlertTone = 'danger' | 'warning' | 'success' | 'info';

const ALERT_STYLES: Record<AlertTone, string> = {
  danger: 'border-ember/40 bg-ember-wash text-ember-ink',
  warning: 'border-amber/40 bg-amber-wash text-amber',
  success: 'border-tide/40 bg-tide-wash text-tide',
  info: 'border-line-strong bg-panel-2 text-fog',
};

export function Alert({
  tone,
  role = 'alert',
  className = '',
  children,
}: {
  tone: AlertTone;
  role?: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role={role} className={`border-2 px-3 py-2 text-sm ${ALERT_STYLES[tone]} ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-4xl leading-none font-bold text-ink">{title}</h2>
          {description !== undefined && <p className="mt-1.5 max-w-2xl text-sm text-fog">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      <div className="rule mt-3" aria-hidden="true" />
    </div>
  );
}

/**
 * Pixel window: stepped frame + hard drop shadow, optional coloured title
 * bar (`a` = cyan "Echo Box" bar, `b` = pink "Status" bar). Replaces Panel.
 */
export function Window({
  label,
  title,
  bar = 'a',
  actions,
  actionsClassName = '',
  className = '',
  bodyClassName = 'p-4',
  children,
}: {
  label?: string;
  title?: ReactNode;
  bar?: 'a' | 'b';
  actions?: ReactNode;
  /** Extra classes on the actions box (e.g. full width when it wraps on phones). */
  actionsClassName?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const labelledBy = label ?? (typeof title === 'string' ? title : undefined);
  const barClass = bar === 'a' ? 'bg-bar-a text-bar-a-ink' : 'bg-bar-b text-bar-b-ink';
  const { ref, visible } = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      aria-label={labelledBy}
      className={`px-frame px-reveal bg-panel ${visible ? 'is-visible' : ''} ${className}`}
    >
      {(title !== undefined || actions !== undefined) && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-outline px-3 py-1.5 ${barClass}`}
        >
          {title !== undefined && <h3 className="min-w-0 font-display text-xl leading-tight font-bold">{title}</h3>}
          {actions !== undefined && <div className={`flex flex-wrap items-center gap-3 ${actionsClassName}`}>{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const ATTRIBUTE_DOT: Record<Attribute, string> = {
  Glacio: 'bg-glacio',
  Fusion: 'bg-fusion',
  Electro: 'bg-electro',
  Aero: 'bg-aero',
  Spectro: 'bg-spectro',
  Havoc: 'bg-havoc',
};

export function AttributeDot({ attribute, className = '' }: { attribute: Attribute; className?: string }) {
  return (
    <span
      aria-hidden="true"
      title={attribute}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${ATTRIBUTE_DOT[attribute]} ${className}`}
    />
  );
}

/** Cost pips: 4 square 5px slots, `cost` filled. Purely visual (cost stays in text). */
export function CostPips({ cost }: { cost: number }) {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4].map((slot) => (
        <span key={slot} className={`h-[5px] w-[5px] ${slot <= cost ? 'bg-pip' : 'bg-panel-3'}`} />
      ))}
    </span>
  );
}

const METER_BLOCK = {
  /** Roll value: 10 blocks of 6x10px. */
  roll: 'h-[10px] w-[6px]',
  /** Substat tier: 4 blocks of 8x8px. */
  tier: 'h-2 w-2',
} as const;

/**
 * Segment meter: `total` blocks with 2px gaps inside a 2px outline, the
 * first `filled` lit. Exposed as an image with `label` for assistive tech.
 */
export function SegmentMeter({
  filled,
  total,
  size = 'roll',
  label,
}: {
  filled: number;
  total: number;
  size?: keyof typeof METER_BLOCK;
  label: string;
}) {
  const lit = Math.max(0, Math.min(total, Math.round(filled)));
  return (
    <span role="img" aria-label={label} className="inline-flex gap-0.5 border-2 border-outline bg-panel p-0.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{ '--i': i } as CSSProperties}
          className={`${METER_BLOCK[size]} ${i < lit ? 'px-meter-on bg-meter' : 'bg-panel-3'}`}
        />
      ))}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="border-2 border-dashed border-line-strong bg-panel px-4 py-8 text-center">
      <p className="text-sm text-fog">{children}</p>
    </div>
  );
}
