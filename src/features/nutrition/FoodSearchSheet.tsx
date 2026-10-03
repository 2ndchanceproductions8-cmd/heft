import type { FoodChoice } from '../../lib/nutrition/types';

// CONTRACT STUB (foundation) — the capture/meal builder owns and replaces this file; the props are fixed.
export interface FoodSearchSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * 'add': picking a food then asks for grams (GramsSheet) and calls onPick(choice, grams).
   * 'change': picking calls onPick(choice, null) immediately (the caller keeps the item's grams and name).
   */
  mode: 'add' | 'change';
  initialQuery?: string;
  title?: string;
  /** Called after the food has been saved to the recents library (upsertFood). The sheet closes itself. */
  onPick: (choice: FoodChoice, grams: number | null) => void;
}

export function FoodSearchSheet(_props: FoodSearchSheetProps) {
  return null;
}
