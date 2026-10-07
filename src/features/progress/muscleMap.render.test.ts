// The muscle map: MuscleMap's body artwork (bodyFigures.ts, generated) mapped onto Heft's muscles (anatomy.ts), and
// the component's server-rendered output (no DOM library: live queries return undefined, so useSettings() is mocked).
import 'fake-indexeddb/auto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MUSCLES, type Muscle, type Settings } from '../../types';
import { HEAT_STEPS, MuscleMap, heatOpacity, regionOpacity, regionTitle, type MuscleMapProps } from '../../components/MuscleMap';
import { BODY_FIGURES } from './bodyFigures';
import {
  ALSO_LIT_BY,
  DRAWN_MUSCLES,
  MAP_FIGURES,
  OWN_REGION_MUSCLES,
  figureSex,
  regionsToOutline,
  type FigureSex,
  type FigureView,
  type MapRegion,
} from './anatomy';

const settings = vi.hoisted(() => ({ sex: null as 'male' | 'female' | null }));
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, useSettings: (): Settings => ({ ...real.DEFAULT_SETTINGS, sex: settings.sex }) };
});

beforeEach(() => {
  settings.sex = null;
});

const SEXES: FigureSex[] = ['male', 'female'];
const VIEWS: FigureView[] = ['front', 'back'];
const NOT_DRAWN: Muscle[] = ['cardio', 'other', 'full_body'];

const region = (sex: FigureSex, view: FigureView, m: Muscle): MapRegion => {
  const r = MAP_FIGURES[sex][view].regions.find((x) => x.muscle === m);
  if (!r) throw new Error(`no ${m} region on ${sex} ${view}`);
  return r;
};
const render = (props: MuscleMapProps) => renderToStaticMarkup(h(MuscleMap, props));
/** The markup of the tappable group labelled `label` in rendered HTML (needs onSelect). */
const groupHtml = (html: string, label: string): string[] =>
  [...html.matchAll(/<g role="button"[^>]*>[\s\S]*?<\/g>/g)].map((m) => m[0]).filter((g) => g.includes(`aria-label="${label}"`));
const accentOpacity = (g: string) => Number(g.match(/fill:var\(--c-accent\);fill-opacity:([\d.]+)/)?.[1] ?? 0);

describe('muscle mapping', () => {
  const EXPECTED: Record<FigureSex, Record<FigureView, Muscle[]>> = {
    male: {
      front: ['abdominals', 'adductors', 'biceps', 'calves', 'chest', 'forearms', 'neck', 'quadriceps', 'shoulders', 'traps', 'triceps'],
      back: ['adductors', 'calves', 'forearms', 'glutes', 'hamstrings', 'lats', 'lower_back', 'neck', 'shoulders', 'traps', 'triceps', 'upper_back'],
    },
    female: {
      front: ['abdominals', 'adductors', 'biceps', 'calves', 'chest', 'forearms', 'neck', 'quadriceps', 'shoulders', 'traps', 'triceps'],
      back: ['adductors', 'calves', 'forearms', 'glutes', 'hamstrings', 'lats', 'lower_back', 'neck', 'shoulders', 'traps', 'triceps', 'upper_back'],
    },
  };

  it.each(SEXES)('every Heft muscle except cardio / other / full_body lights the %s figure', (sex) => {
    const lit = new Set([...MAP_FIGURES[sex].front.regions, ...MAP_FIGURES[sex].back.regions].flatMap((r) => r.lit));
    expect([...lit].sort()).toEqual(MUSCLES.filter((m) => !NOT_DRAWN.includes(m)).sort());
    // abductors have no shape of their own: they light the glutes
    expect(OWN_REGION_MUSCLES[sex].has('abductors')).toBe(false);
    expect(region(sex, 'back', 'glutes').lit).toEqual(['glutes', 'abductors']);
  });

  it('DRAWN_MUSCLES holds every muscle that lights a region, shared ones included', () => {
    expect([...DRAWN_MUSCLES].sort()).toEqual(MUSCLES.filter((m) => !NOT_DRAWN.includes(m)).sort());
    for (const m of NOT_DRAWN) expect(DRAWN_MUSCLES.has(m)).toBe(false);
  });

  it.each(SEXES.flatMap((sex) => VIEWS.map((view) => [sex, view] as const)))('%s %s has one region per expected muscle', (sex, view) => {
    const muscles = MAP_FIGURES[sex][view].regions.map((r) => r.muscle);
    expect([...muscles].sort()).toEqual(EXPECTED[sex][view]);
    expect(new Set(muscles).size).toBe(muscles.length);
  });

  it('shares lighting only where intended', () => {
    for (const sex of SEXES) {
      expect(region(sex, 'back', 'traps').lit).toEqual(['traps', 'upper_back']);
      expect(region(sex, 'front', 'traps').lit).toEqual(['traps']);
      expect(region(sex, 'back', 'lats').lit).toEqual(['lats']);
      expect(region(sex, 'back', 'upper_back').lit).toEqual(['upper_back']);
      for (const view of VIEWS)
        for (const r of MAP_FIGURES[sex][view].regions)
          expect(r.lit).toEqual([r.muscle, ...(ALSO_LIT_BY[view][r.muscle] ?? [])]);
    }
  });

  it('draws the neutral body and hair on every figure, and front/back of one sex share a viewBox', () => {
    for (const sex of SEXES) {
      const { front, back } = BODY_FIGURES[sex];
      expect([front.w, front.h]).toEqual([back.w, back.h]);
      for (const fig of [front, back]) {
        expect(fig.layers.some((l) => l.part === 'body' || l.part === 'hair')).toBe(true);
        for (const l of fig.layers) expect(l.d).toMatch(/^[mM][\d.-]/);
      }
    }
    // the generated module is shared by both sexes: keep it lean (it lands in the main chunk)
    expect(JSON.stringify(BODY_FIGURES).length).toBeLessThan(50_000);
  });

  it('picks the figure from the sex setting', () => {
    expect(figureSex('female')).toBe('female');
    expect(figureSex('male')).toBe('male');
    expect(figureSex(null)).toBe('male');
    expect(figureSex(undefined)).toBe('male');
  });

  it('outlines a selected muscle, or the regions it lights when it has none of its own', () => {
    const back = MAP_FIGURES.male.back;
    expect(regionsToOutline(back, 'male', 'lats').map((r) => r.muscle)).toEqual(['lats']);
    expect(regionsToOutline(back, 'male', 'abductors').map((r) => r.muscle)).toEqual(['glutes']);
    // upper_back has its own (teres) shapes, so the traps it also lights are not outlined
    expect(regionsToOutline(back, 'male', 'upper_back').map((r) => r.muscle)).toEqual(['upper_back']);
    expect(regionsToOutline(MAP_FIGURES.male.front, 'male', 'lats')).toEqual([]);
    expect(regionsToOutline(back, 'male', null)).toEqual([]);
  });
});

describe('heat', () => {
  it('heatOpacity steps are unchanged', () => {
    expect(HEAT_STEPS).toEqual([0.25, 0.43, 0.62, 0.81, 1]);
    expect(heatOpacity(0, 10)).toBe(0);
    expect(heatOpacity(null, 10)).toBe(0);
    expect(heatOpacity(undefined, 10)).toBe(0);
    expect(heatOpacity(5, 0)).toBe(0);
    expect(heatOpacity(-1, 10)).toBe(0);
    expect(heatOpacity(1, 10)).toBe(0.25);
    expect(heatOpacity(2, 10)).toBe(0.25);
    expect(heatOpacity(3, 10)).toBe(0.43);
    expect(heatOpacity(6, 10)).toBe(0.62);
    expect(heatOpacity(8, 10)).toBe(0.81);
    expect(heatOpacity(10, 10)).toBe(1);
    expect(heatOpacity(25, 10)).toBe(1);
  });

  it('a shared region takes the strongest of its muscles', () => {
    const glutes = region('male', 'back', 'glutes');
    expect(regionOpacity(glutes, new Map<Muscle, number>([['glutes', 0.25], ['abductors', 0.62]]))).toBe(0.62);
    expect(regionOpacity(glutes, new Map<Muscle, number>([['glutes', 0.81], ['abductors', 0.25]]))).toBe(0.81);
    expect(regionOpacity(glutes, new Map<Muscle, number>([['chest', 1]]))).toBe(0);
  });

  it('labels a shared region as its own muscle, with the other muscles that light it', () => {
    const glutes = region('female', 'back', 'glutes');
    expect(regionTitle(glutes)).toBe('Glutes');
    expect(regionTitle(glutes, { glutes: 2, abductors: 3 })).toBe('Glutes · 2 · Abductors 3');
    expect(regionTitle(glutes, { abductors: 3.25 })).toBe('Glutes · Abductors 3.3');
    expect(regionTitle(region('male', 'back', 'traps'), { upper_back: 4 })).toBe('Traps · Upper Back 4');
  });
});

describe('<MuscleMap> render', () => {
  const viewBox = (sex: FigureSex) => `viewBox="0 0 ${BODY_FIGURES[sex].front.w} ${BODY_FIGURES[sex].front.h}"`;

  it('draws the female figure when the setting says female', () => {
    settings.sex = 'female';
    const html = render({ values: { chest: 3 } });
    expect(html).toContain('data-figure="female"');
    expect(html).toContain(viewBox('female'));
    expect(html).not.toContain(viewBox('male'));
    expect(html).toContain(BODY_FIGURES.female.back.layers[0].d);
  });

  it('draws the male figure for a male or unset setting, and the figure prop wins over the setting', () => {
    settings.sex = 'male';
    expect(render({})).toContain(viewBox('male'));
    settings.sex = null;
    expect(render({})).toContain('data-figure="male"');
    settings.sex = 'female';
    const html = render({ figure: 'male' });
    expect(html).toContain('data-figure="male"');
    expect(html).toContain(viewBox('male'));
    settings.sex = 'male';
    expect(render({ figure: 'female' })).toContain(viewBox('female'));
  });

  it('heat mode: shared regions light from either muscle, untrained regions stay neutral', () => {
    const html = render({ values: { chest: 10, abductors: 10, glutes: 1, upper_back: 3 }, onSelect: () => {}, figure: 'male' });
    const [glutes] = groupHtml(html, 'Glutes');
    expect(accentOpacity(glutes)).toBe(1); // abductors at the max light the glutes fully
    expect(glutes).toContain('<title>Glutes · 1 · Abductors 10</title>');
    const traps = groupHtml(html, 'Traps');
    expect(traps.map(accentOpacity)).toEqual([0, 0.43]); // front traps: traps only; back traps: + upper back
    expect(accentOpacity(groupHtml(html, 'Upper Back')[0])).toBe(0.43);
    expect(accentOpacity(groupHtml(html, 'Lats')[0])).toBe(0);
    expect(accentOpacity(groupHtml(html, 'Chest')[0])).toBe(1);
    expect(html).not.toContain('Cardio');
  });

  it('highlight mode: primary solid, secondary lighter, full body tints everything', () => {
    const html = render({ highlight: { primary: ['chest'], secondary: ['triceps', 'abductors'] }, onSelect: () => {} });
    expect(accentOpacity(groupHtml(html, 'Chest')[0])).toBe(1);
    expect(groupHtml(html, 'Triceps').map(accentOpacity)).toEqual([0.4, 0.4]);
    expect(accentOpacity(groupHtml(html, 'Glutes')[0])).toBe(0.4);
    expect(accentOpacity(groupHtml(html, 'Quadriceps')[0])).toBe(0);
    const full = render({ highlight: { primary: [], secondary: ['full_body'] }, onSelect: () => {} });
    for (const g of groupHtml(full, 'Calves')) expect(accentOpacity(g)).toBe(0.18);
  });

  it('is tappable and outlines the selection', () => {
    const html = render({ values: { lats: 4 }, onSelect: () => {}, selected: 'lats', figure: 'female' });
    const buttons = html.match(/role="button"/g) ?? [];
    expect(buttons.length).toBe(MAP_FIGURES.female.front.regions.length + MAP_FIGURES.female.back.regions.length);
    expect(html).toContain('tabindex="0"');
    expect(groupHtml(html, 'Lats')[0]).toContain('aria-pressed="true"');
    expect(groupHtml(html, 'Chest')[0]).toContain('aria-pressed="false"');
    const outline = html.match(/<g style="fill:none;stroke:var\(--c-fg\)[^"]*" pointer-events="none">([\s\S]*?)<\/g>/);
    expect(outline?.[1]).toContain(`d="${region('female', 'back', 'lats').d}"`);
    expect(outline?.[1]).toContain('vector-effect="non-scaling-stroke"');
    expect(html).toContain('>Front</figcaption>');
    expect(html).toContain('>Back</figcaption>');
  });

  it('is a static image without onSelect, and view picks the figures', () => {
    const html = render({ values: { chest: 2 }, view: 'front' });
    expect(html).not.toContain('role="button"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Front muscle map"');
    expect(html).not.toContain('Back muscle map');
    expect(render({ view: 'back' })).not.toContain('Front muscle map');
  });
});

