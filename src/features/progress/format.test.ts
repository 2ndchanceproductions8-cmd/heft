import { describe, expect, it } from 'vitest';
import { anyToMeters } from '../../lib/units';
import { restOptionLabel } from '../../lib/rest';
import {
  CM_PER_IN,
  cmToLength,
  compactNumber,
  formatHeight,
  formatLength,
  formatMetric,
  formatPRValue,
  formatSets,
  lengthToCm,
  lengthUnitFor,
  parseHeight,
  relativeDay,
} from './format';

describe('lengths', () => {
  it('follows the weight unit and round-trips', () => {
    expect(lengthUnitFor('lb')).toBe('in');
    expect(lengthUnitFor('kg')).toBe('cm');
    expect(lengthToCm(cmToLength(84.07, 'in'), 'in')).toBeCloseTo(84.07, 10);
    expect(formatLength(84.07, 'in')).toBe('33.1 in');
    expect(formatLength(84.07, 'cm')).toBe('84.1 cm');
    expect(formatLength(null, 'cm')).toBe('–');
  });
});

describe('height', () => {
  it('formats feet/inches for lb users and cm for kg users', () => {
    expect(formatHeight(70 * CM_PER_IN, 'lb')).toBe(`5'10"`);
    expect(formatHeight(177.8, 'kg')).toBe('178 cm');
  });

  it('parses the common ways people type a height', () => {
    const inches = (n: number) => n * CM_PER_IN;
    expect(parseHeight(`5'10"`, 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight(`5’10”`, 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight(`5' 10`, 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight('5ft 10in', 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight('5 10', 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight('70', 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight('70in', 'lb')).toBeCloseTo(inches(70));
    expect(parseHeight('178 cm', 'lb')).toBe(178);
    expect(parseHeight('178', 'kg')).toBe(178);
    expect(parseHeight('1.78', 'kg')).toBeCloseTo(178);
    expect(parseHeight('1,78 m', 'kg')).toBeCloseTo(178);
    expect(parseHeight('', 'kg')).toBeNull();
    expect(parseHeight('tall', 'lb')).toBeNull();
  });
});

describe('small formatters', () => {
  it('formats set counts, axis numbers and rest times', () => {
    expect(formatSets(1)).toBe('1 set');
    expect(formatSets(4.5)).toBe('4.5 sets');
    expect(formatSets(12)).toBe('12 sets');
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(1250)).toBe('1.3k');
    expect(compactNumber(12_400)).toBe('12k');
    // Settings uses the app-wide rest labels (lib/rest.ts).
    expect(restOptionLabel(0)).toBe('Off');
    expect(restOptionLabel(45)).toBe('45s');
    expect(restOptionLabel(90)).toBe('1:30');
  });

  it('describes dates relative to now', () => {
    const now = new Date(2026, 9, 1, 10).getTime();
    expect(relativeDay(new Date(2026, 9, 1, 7).getTime(), now)).toBe('Today');
    expect(relativeDay(new Date(2026, 8, 30, 23).getTime(), now)).toBe('Yesterday');
    expect(relativeDay(new Date(2026, 8, 27).getTime(), now)).toBe('4d ago');
    expect(relativeDay(new Date(2026, 8, 17).getTime(), now)).toBe('2w ago');
    expect(relativeDay(new Date(2026, 6, 4).getTime(), now)).toBe('Jul 4');
    expect(relativeDay(new Date(2025, 6, 4).getTime(), now)).toBe('Jul 4, 2025');
  });
});

describe('formatPRValue', () => {
  it('shows carry distances in yards/meters and runs in mi/km', () => {
    expect(formatPRValue('longest_distance', anyToMeters(40, 'yd'), 'weight_distance', 'lb', 'mi')).toBe('40 yd');
    expect(formatPRValue('longest_distance', 30, 'weight_distance', 'kg', 'km')).toBe('30 m');
    expect(formatPRValue('longest_distance', 5000, 'distance_duration', 'kg', 'km')).toBe('5 km');
    expect(formatPRValue('longest_distance', 5000, 'distance_duration', 'lb', 'mi')).toBe('3.11 mi');
  });

  it('shows carry distances to 0.1 yd / m', () => {
    expect(formatPRValue('longest_distance', anyToMeters(40.5, 'yd'), 'weight_distance', 'lb', 'mi')).toBe('40.5 yd');
  });

  it('formats progress metrics with the exercise type (carries in yd / m, runs in mi / km)', () => {
    expect(formatMetric('maxDistance', 5000, 'distance_duration', 'kg', 'km')).toBe('5 km');
    expect(formatMetric('maxDistance', anyToMeters(40, 'yd'), 'weight_distance', 'lb', 'mi')).toBe('40 yd');
    expect(formatMetric('maxDuration', 90, 'duration', 'kg', 'km')).toBe('1:30');
  });

  it('prefixes added weight on weighted bodyweight moves', () => {
    expect(formatPRValue('heaviest_weight', 20, 'weighted_bodyweight', 'kg', 'km')).toBe('+20 kg');
    expect(formatPRValue('heaviest_weight', 100, 'weight_reps', 'kg', 'km')).toBe('100 kg');
  });
});
