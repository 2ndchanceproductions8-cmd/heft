import type { FoodChoice } from '../../../lib/nutrition/types';
import { SourceChip } from '../ui';
import { per100Line } from '../meal/format';

/** A scanned product as the label reports it: name, brand, per-100 g numbers and the serving size. */
export function ProductCard({ food, code }: { food: FoodChoice; code: string }) {
  return (
    <div className="rounded-2xl bg-surface p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[18px] leading-snug font-semibold">{food.name}</div>
          {food.brand ? <div className="mt-0.5 truncate text-[14px] text-muted">{food.brand}</div> : null}
        </div>
        <SourceChip source={food.source} className="mt-1 shrink-0" />
      </div>
      <div className="mt-3 space-y-1 text-[14px] tabular-nums">
        <div>
          <span className="text-muted">Per 100 g: </span>
          {per100Line(food.per100g)}
        </div>
        <div className="text-muted">
          {food.servingG ? `Serving on the label: ${Math.round(food.servingG * 10) / 10} g` : 'No serving size on the label — weigh it or use 100 g.'}
        </div>
        <div className="text-[12px] text-faint">Barcode {code}</div>
      </div>
    </div>
  );
}
