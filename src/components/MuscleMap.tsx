import { memo, useMemo, type KeyboardEvent } from 'react';
import type { Muscle } from '../types';
import { MUSCLE_LABEL } from '../lib/exerciseMeta';
import { useSettings } from '../lib/settings';
import {
  DRAWN_MUSCLES,
  MAP_FIGURES,
  figureSex,
  regionsToOutline,
  type FigureSex,
  type MapFigure,
  type MapRegion,
} from '../features/progress/anatomy';
import { cx } from './ui/Button';

/*
 * Front/back anatomical muscle map (inline SVG, scales to its container width). Body artwork: MuscleMap by
 * Melih Colpan (MIT, see THIRD_PARTY_NOTICES.md); regions and shared lighting: features/progress/anatomy.ts.
 *
 * Heat mode (`values`): each muscle is tinted with the accent color, opacity stepped by value / max.
 * Highlight mode (`highlight`): primary muscles solid accent, secondary muscles lighter.
 * A region lit by several muscles (glutes + abductors) shows the strongest of them.
 * cardio / other are not drawn; full_body tints every region lightly.
 */

export interface MuscleMapProps {
  /** Heat values per muscle (e.g. sets in the period). Colored relative to the max value. */
  values?: Partial<Record<Muscle, number>>;
  /** Exercise mode: primary muscles solid accent, secondary muscles lighter. Overrides `values` coloring. */
  highlight?: { primary?: Muscle[]; secondary?: Muscle[] };
  view?: 'front' | 'back' | 'both';
  className?: string;
  /** Called when a muscle region is tapped. */
  onSelect?: (m: Muscle) => void;
  /** Outline this muscle (e.g. the one whose details are expanded). */
  selected?: Muscle | null;
  /** Body figure; defaults to the user's `sex` setting (female → female figure, else male). */
  figure?: 'male' | 'female';
}

/** Opacity steps for the heat map (value / max → one of these). */
export const HEAT_STEPS = [0.25, 0.43, 0.62, 0.81, 1] as const;
const SECONDARY_OPACITY = 0.4;
const FULL_BODY_TINT = 0.18;
/** Untrained muscles. */
const MUSCLE_FILL = 'var(--c-surface-3)';
/** Head, hands, feet, knees, shins: a step quieter than the muscles (opaque, so hair behind a face never shows). */
const BODY_FILL = 'color-mix(in srgb, var(--c-surface-3) 70%, var(--c-surface))';
/** Hair: a touch of the text color, so it reads darker on light and lighter on dark, without drawing the eye. */
const HAIR_FILL = 'color-mix(in srgb, var(--c-surface-3) 90%, var(--c-fg))';
/** Selection outline width in CSS px (non-scaling, so it reads the same at every map size). */
const OUTLINE_PX = 1.5;

/** Accent opacity for a heat value (0 when the muscle wasn't trained). */
export function heatOpacity(value: number | null | undefined, max: number): number {
  if (!value || value <= 0 || max <= 0) return 0;
  const r = Math.min(1, value / max);
  return HEAT_STEPS[Math.max(0, Math.ceil(r * HEAT_STEPS.length) - 1)];
}

function computeOpacities(
  values: MuscleMapProps['values'],
  highlight: MuscleMapProps['highlight'],
): Map<Muscle, number> {
  const out = new Map<Muscle, number>();
  if (highlight) {
    const primary = highlight.primary ?? [];
    const secondary = highlight.secondary ?? [];
    const fullBody = primary.includes('full_body') || secondary.includes('full_body');
    if (fullBody) for (const m of DRAWN_MUSCLES) out.set(m, primary.includes('full_body') ? SECONDARY_OPACITY : FULL_BODY_TINT);
    for (const m of secondary) if (DRAWN_MUSCLES.has(m)) out.set(m, Math.max(out.get(m) ?? 0, SECONDARY_OPACITY));
    for (const m of primary) if (DRAWN_MUSCLES.has(m)) out.set(m, 1);
    return out;
  }
  if (values) {
    let max = 0;
    for (const m of DRAWN_MUSCLES) max = Math.max(max, values[m] ?? 0);
    const tint = (values.full_body ?? 0) > 0 ? FULL_BODY_TINT : 0;
    for (const m of DRAWN_MUSCLES) {
      const o = Math.max(heatOpacity(values[m], max), tint);
      if (o > 0) out.set(m, o);
    }
  }
  return out;
}

/** A region's accent opacity: the strongest of the muscles that light it. */
export function regionOpacity(region: MapRegion, opacities: ReadonlyMap<Muscle, number>): number {
  let o = 0;
  for (const m of region.lit) o = Math.max(o, opacities.get(m) ?? 0);
  return o;
}

const fmtValue = (v: number) => String(Math.round(v * 10) / 10);

/** Tooltip: "Glutes · 12", plus any other muscle lighting the region ("Glutes · 12 · Abductors 4"). */
export function regionTitle(region: MapRegion, values?: Partial<Record<Muscle, number>>): string {
  const own = values?.[region.muscle];
  let title = MUSCLE_LABEL[region.muscle] + (own ? ` · ${fmtValue(own)}` : '');
  for (const m of region.lit) {
    const v = values?.[m];
    if (m !== region.muscle && v) title += ` · ${MUSCLE_LABEL[m]} ${fmtValue(v)}`;
  }
  return title;
}

function FigureSvg({
  figure,
  sex,
  label,
  opacities,
  values,
  selected,
  onSelect,
}: {
  figure: MapFigure;
  sex: FigureSex;
  label: string;
  opacities: Map<Muscle, number>;
  values?: Partial<Record<Muscle, number>>;
  selected?: Muscle | null;
  onSelect?: (m: Muscle) => void;
}) {
  const interactive = !!onSelect;
  const outlined = regionsToOutline(figure, sex, selected);

  return (
    <figure className="m-0 flex min-w-0 flex-1 flex-col items-center">
      <svg
        viewBox={`0 0 ${figure.w} ${figure.h}`}
        className="block h-auto w-full select-none"
        role={interactive ? 'group' : 'img'}
        aria-label={`${label} muscle map`}
      >
        {figure.layers.map((layer, i) => {
          if (layer.kind !== 'muscle')
            return <path key={i} d={layer.d} style={{ fill: layer.kind === 'hair' ? HAIR_FILL : BODY_FILL }} />;
          const r = layer.region;
          const o = regionOpacity(r, opacities);
          return (
            <g
              key={i}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? MUSCLE_LABEL[r.muscle] : undefined}
              aria-pressed={interactive ? selected === r.muscle : undefined}
              className={cx(interactive && 'cursor-pointer outline-none active:opacity-75')}
              onClick={interactive ? () => onSelect!(r.muscle) : undefined}
              onKeyDown={
                interactive
                  ? (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect!(r.muscle);
                      }
                    }
                  : undefined
              }
            >
              <title>{regionTitle(r, values)}</title>
              <path d={r.d} style={{ fill: MUSCLE_FILL }} />
              {o > 0 ? (
                <path
                  d={r.d}
                  style={{ fill: 'var(--c-accent)', fillOpacity: o, transition: 'fill-opacity .25s ease' }}
                />
              ) : null}
            </g>
          );
        })}

        {/* selection outline */}
        {outlined.length ? (
          <g
            style={{ fill: 'none', stroke: 'var(--c-fg)', strokeWidth: OUTLINE_PX, strokeLinejoin: 'round' }}
            pointerEvents="none"
          >
            {outlined.map((r, i) => (
              <path key={i} d={r.d} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        ) : null}
      </svg>
      <figcaption className="mt-1.5 text-[12px] font-semibold text-muted">{label}</figcaption>
    </figure>
  );
}

function MuscleMapImpl({ values, highlight, view = 'both', className, onSelect, selected, figure }: MuscleMapProps) {
  const settings = useSettings();
  const sex = figureSex(figure ?? settings.sex);
  const opacities = useMemo(() => computeOpacities(values, highlight), [values, highlight]);
  const shared = { sex, opacities, values: highlight ? undefined : values, selected, onSelect };
  return (
    <div className={cx('flex w-full items-start justify-center gap-3', className)} data-figure={sex}>
      {view !== 'back' ? <FigureSvg figure={MAP_FIGURES[sex].front} label="Front" {...shared} /> : null}
      {view !== 'front' ? <FigureSvg figure={MAP_FIGURES[sex].back} label="Back" {...shared} /> : null}
    </div>
  );
}

export const MuscleMap = memo(MuscleMapImpl);
