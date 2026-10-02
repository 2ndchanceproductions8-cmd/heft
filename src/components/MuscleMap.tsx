import { Fragment, memo, useMemo, type KeyboardEvent, type SVGProps } from 'react';
import type { Muscle } from '../types';
import { MUSCLE_LABEL } from '../lib/exerciseMeta';
import { BACK, DRAWN_MUSCLES, FIGURE_H, FIGURE_W, FRONT, type Figure, type Region } from '../features/progress/anatomy';
import { cx } from './ui/Button';

/*
 * Front/back anatomical muscle map (inline SVG, scales to its container width).
 *
 * Heat mode (`values`): each muscle is tinted with the accent color, opacity stepped by value / max.
 * Highlight mode (`highlight`): primary muscles solid accent, secondary muscles lighter.
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
}

/** Opacity steps for the heat map (value / max → one of these). */
export const HEAT_STEPS = [0.25, 0.43, 0.62, 0.81, 1] as const;
const SECONDARY_OPACITY = 0.4;
const FULL_BODY_TINT = 0.18;
const BODY_OPACITY = 0.7;
const STROKE = 1.1;
const MIRROR = `matrix(-1 0 0 1 ${FIGURE_W} 0)`;

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

/** Regions grouped by muscle, preserving draw order (same-muscle regions are adjacent in the figure data). */
function groupRegions(regions: Region[]): { muscle: Muscle; paths: string[] }[] {
  const groups: { muscle: Muscle; paths: string[] }[] = [];
  for (const r of regions) {
    const last = groups[groups.length - 1];
    if (last && last.muscle === r.muscle) last.paths.push(r.d);
    else groups.push({ muscle: r.muscle, paths: [r.d] });
  }
  return groups;
}

const FRONT_GROUPS = groupRegions(FRONT.regions);
const BACK_GROUPS = groupRegions(BACK.regions);

function Mirrored({ d, ...rest }: { d: string } & SVGProps<SVGPathElement>) {
  return (
    <>
      <path d={d} {...rest} />
      <path d={d} transform={MIRROR} {...rest} />
    </>
  );
}

function FigureSvg({
  figure,
  groups,
  label,
  opacities,
  values,
  selected,
  onSelect,
}: {
  figure: Figure;
  groups: { muscle: Muscle; paths: string[] }[];
  label: string;
  opacities: Map<Muscle, number>;
  values?: Partial<Record<Muscle, number>>;
  selected?: Muscle | null;
  onSelect?: (m: Muscle) => void;
}) {
  const interactive = !!onSelect;
  const strokeProps = { stroke: 'var(--c-bg)', strokeWidth: STROKE, strokeLinejoin: 'round' as const };
  const selectedGroups = selected ? groups.filter((g) => g.muscle === selected) : [];

  return (
    <figure className="m-0 flex min-w-0 flex-1 flex-col items-center">
      <svg
        viewBox={`0 0 ${FIGURE_W} ${FIGURE_H}`}
        className="block h-auto w-full select-none"
        role={interactive ? 'group' : 'img'}
        aria-label={`${label} muscle map`}
      >
        {/* body silhouette (non-muscle parts: head, hands, joints, feet) */}
        <g style={{ fill: 'var(--c-surface-3)', fillOpacity: BODY_OPACITY }}>
          {figure.body.map((d, i) => (
            <Mirrored key={i} d={d} />
          ))}
          {figure.details.map((d, i) => (
            <Mirrored key={'d' + i} d={d} {...strokeProps} />
          ))}
        </g>

        {groups.map((g, gi) => {
          const o = opacities.get(g.muscle) ?? 0;
          const v = values?.[g.muscle];
          const title = MUSCLE_LABEL[g.muscle] + (v ? ` · ${Math.round(v * 10) / 10}` : '');
          return (
            <g
              key={g.muscle + gi}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? MUSCLE_LABEL[g.muscle] : undefined}
              aria-pressed={interactive ? selected === g.muscle : undefined}
              className={cx(interactive && 'cursor-pointer outline-none active:opacity-75')}
              onClick={interactive ? () => onSelect!(g.muscle) : undefined}
              onKeyDown={
                interactive
                  ? (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect!(g.muscle);
                      }
                    }
                  : undefined
              }
            >
              <title>{title}</title>
              {g.paths.map((d, i) => (
                <Fragment key={i}>
                  <Mirrored d={d} style={{ fill: 'var(--c-surface-3)' }} {...strokeProps} />
                  {o > 0 ? (
                    <Mirrored
                      d={d}
                      style={{ fill: 'var(--c-accent)', fillOpacity: o, transition: 'fill-opacity .25s ease' }}
                      {...strokeProps}
                    />
                  ) : null}
                </Fragment>
              ))}
            </g>
          );
        })}

        {/* head on top of the neck (nothing is drawn underneath it, so the body tone stays even) */}
        <g style={{ fill: 'var(--c-surface-3)', fillOpacity: BODY_OPACITY }} {...strokeProps}>
          {figure.top.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>

        {/* selection outline */}
        {selectedGroups.length ? (
          <g style={{ fill: 'none', stroke: 'var(--c-fg)', strokeWidth: 1.6, strokeLinejoin: 'round' }} pointerEvents="none">
            {selectedGroups.flatMap((g) => g.paths).map((d, i) => (
              <Mirrored key={i} d={d} />
            ))}
          </g>
        ) : null}
      </svg>
      <figcaption className="mt-1.5 text-[12px] font-semibold text-muted">{label}</figcaption>
    </figure>
  );
}

function MuscleMapImpl({ values, highlight, view = 'both', className, onSelect, selected }: MuscleMapProps) {
  const opacities = useMemo(() => computeOpacities(values, highlight), [values, highlight]);
  const shared = { opacities, values: highlight ? undefined : values, selected, onSelect };
  return (
    <div className={cx('flex w-full items-start justify-center gap-3', className)}>
      {view !== 'back' ? <FigureSvg figure={FRONT} groups={FRONT_GROUPS} label="Front" {...shared} /> : null}
      {view !== 'front' ? <FigureSvg figure={BACK} groups={BACK_GROUPS} label="Back" {...shared} /> : null}
    </div>
  );
}

export const MuscleMap = memo(MuscleMapImpl);
