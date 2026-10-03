import { describe, expect, it } from 'vitest';
import { buildPrompt } from './prompt';

describe('buildPrompt', () => {
  it('one photo: the full 5-step scale procedure, densities, sanity check, oil item, confidence + not-food guidance', () => {
    const p = buildPrompt({ imageCount: 1 });
    for (const s of [
      'STEP 1 — Find a scale reference',
      'US quarter: 24.3 mm',
      'Credit/debit/ID card: 85.6 x 54 mm',
      'STEP 2 — Establish scale',
      'STEP 3 — Estimate volume, not grams',
      'STEP 4 — Convert volume to mass',
      'cooked rice, pasta, grains: 0.75',
      'STEP 5 — Sanity-check against normal serving sizes',
      'include a separate item for it',
      'set confidence no higher than "medium"',
      '"fdc_query"',
      '"high" only with a clear photo',
      'If the image does not depict food',
    ]) {
      expect(p).toContain(s);
    }
    expect(p).not.toContain('PHOTOS OF THE SAME MEAL');
    expect(p).not.toContain('USER-PROVIDED CONTEXT');
  });

  it('drops the STRICT JSON / schema paragraph (structured outputs enforce the format)', () => {
    const p = buildPrompt({ imageCount: 2, description: 'x', weightG: 100 });
    expect(p).not.toMatch(/STRICT JSON|markdown fences|Match this schema/i);
  });

  it('several photos: one meal, the union not the sum, labelled like the request', () => {
    const p = buildPrompt({ imageCount: 3 });
    expect(p).toContain('3 PHOTOS OF THE SAME MEAL');
    expect(p).toContain('"Photo 1 of 3"');
    expect(p).toContain('This is ONE meal, not 3 meals. NEVER add up the same food across photos.');
    expect(p).toContain('UNION of distinct foods');
  });

  it('user description and weight are authoritative ground truth', () => {
    const p = buildPrompt({ imageCount: 1, description: '  turkey sandwich ', weightG: 245.04 });
    expect(p).toContain('TREAT AS AUTHORITATIVE GROUND TRUTH');
    expect(p).toContain('- Food description: turkey sandwich');
    expect(p).toContain('- Weight: 245 grams (use this exact weight; do not re-estimate portion)');
    expect(p).toContain("The user's description and weight are final.");
  });

  it('text only: no photo procedure, description-based not-food rule', () => {
    const p = buildPrompt({ imageCount: 0, description: '2 eggs' });
    expect(p).not.toContain('STEP 1');
    expect(p).toContain('No image was provided.');
    expect(p).toContain('If the description does not refer to food');
    expect(buildPrompt({ imageCount: 0, description: 'x', weightG: 0 })).not.toContain('- Weight:');
  });
});
