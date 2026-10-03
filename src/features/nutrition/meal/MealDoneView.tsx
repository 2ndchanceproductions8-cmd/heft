import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Plus, ScanBarcode, Trash2, TriangleAlert } from 'lucide-react';
import { ActionSheet, Button, confirm, prompt, SectionHeader, toast, TopBar } from '../../../components/ui';
import { useMediaUrls } from '../../../lib/media';
import { clampServes, dayKey } from '../../../lib/nutrition/math';
import { deleteMeal, itemFromChoice, useDayTotals, useTargets } from '../../../lib/nutrition/store';
import { useNutritionKeys } from '../../../lib/nutrition/keys';
import type { FoodChoice, Meal, MealItem } from '../../../lib/nutrition/types';
import { formatGrams } from '../../../lib/units';
import { FoodSearchSheet } from '../FoodSearchSheet';
import { formatKcal, Ring, useMassUnit } from '../ui';
import { dayLabel, fromDateTimeLocal, mealDisplayTitle, toDateTimeLocal } from './format';
import { gramsEdited, ItemRow } from './ItemRow';
import { AnalysisNotes, MealPhotos, MealSummary, ServesStepper } from './MealStates';
import { diaryPath, scanPath, SETTINGS_PATH } from './nav';
import { BackButton, Notice } from './parts';
import { useMealEditor } from './useMealEditor';

/** True when an item fell back to Claude's estimate because USDA's (shared) key was rate limited. */
export const needsFdcKeyBanner = (items: Pick<MealItem, 'lookup'>[], fdcKey: string | null) =>
  !fdcKey && items.some((it) => it.lookup === 'rate_limited');

/** The finished-meal editor: photo, totals, notes, servings and every item (all editable). */
export function MealDoneView({ meal }: { meal: Meal }) {
  const nav = useNavigate();
  const { view, edit, flush, discard } = useMealEditor(meal);
  const [mu] = useMassUnit();
  const keys = useNutritionKeys();
  const photoUrls = useMediaUrls(view.photoIds);
  const [menuFor, setMenuFor] = useState<MealItem | null>(null);
  const [changeFor, setChangeFor] = useState<MealItem | null>(null);
  const [adding, setAdding] = useState(false);
  const title = mealDisplayTitle(view);

  const back = async () => {
    await flush();
    nav(diaryPath(view.day), { replace: true });
  };

  const rename = async () => {
    const t = await prompt({ title: 'Rename meal', initial: view.title || title, placeholder: 'e.g. Lunch' });
    if (t == null) return;
    edit(() => ({ title: t.trim() }), { now: true });
  };

  const setItem = (itemId: string, patch: Partial<MealItem>, now = false) =>
    edit((m) => ({ items: m.items.map((it) => (it.id === itemId ? { ...it, ...patch, id: it.id } : it)) }), { now });

  const renameItem = async (item: MealItem) => {
    const t = await prompt({
      title: 'Rename food',
      initial: item.name,
      validate: (v) => (v.trim() ? null : 'Enter a name'),
    });
    if (t == null) return;
    setItem(item.id, { name: t.trim() }, true);
  };

  const deleteItem = async (item: MealItem) => {
    const ok = await confirm({
      title: `Delete ${item.name.trim() || 'this food'}?`,
      message: 'It comes off this meal and your day totals.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    edit((m) => ({ items: m.items.filter((it) => it.id !== item.id) }), { now: true });
  };

  // "Change food" swaps the numbers only: the item keeps its own name and weight.
  const changeFood = (item: MealItem, c: FoodChoice) =>
    setItem(
      item.id,
      {
        per100g: c.per100g,
        fixed: null,
        matchedName: c.brand ? `${c.name} · ${c.brand}` : c.name,
        fdcId: c.fdcId,
        barcode: c.barcode,
        source: c.source,
        lookup: 'ok',
      },
      true,
    );

  const addFood = (c: FoodChoice, grams: number | null) => {
    if (grams == null) return;
    edit((m) => ({ items: [...m.items, itemFromChoice(c, grams)] }), { now: true });
  };

  const removeMeal = async () => {
    const ok = await confirm({
      title: 'Delete this meal?',
      message: view.photoIds.length ? 'Its photos are deleted too. This can’t be undone.' : 'This can’t be undone.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    discard();
    try {
      await deleteMeal(view.id);
      toast('Meal deleted', 'success');
      nav(diaryPath(view.day), { replace: true });
    } catch {
      toast("Couldn't delete the meal", 'error');
    }
  };

  const addBarcode = async () => {
    await flush();
    nav(scanPath({ meal: view.id }));
  };

  const menuActions = menuFor
    ? [
        ...(menuFor.fixed
          ? []
          : [
              {
                label: 'Change food',
                hint: 'Keep the name and weight, use another database entry',
                onClick: () => setChangeFor(menuFor),
              },
              {
                label: 'Reset weight',
                hint: gramsEdited(menuFor) ? `Back to ${formatGrams(menuFor.baselineGrams, mu)}` : 'Weight is unchanged',
                disabled: !gramsEdited(menuFor),
                onClick: () => setItem(menuFor.id, { grams: menuFor.baselineGrams }, true),
              },
            ]),
        { label: 'Rename', onClick: () => void renameItem(menuFor) },
        { label: 'Delete item', danger: true, onClick: () => void deleteItem(menuFor) },
      ]
    : [];

  return (
    <>
      <TopBar left={<BackButton onClick={() => void back()} />} title="Meal" />
      <div className="space-y-3 px-4 pt-4">
        <MealPhotos urls={photoUrls} kind={view.input.kind} />
        <div>
          <button type="button" onClick={() => void rename()} className="flex min-h-10 max-w-full items-center gap-2 text-left active:opacity-60">
            <span className="line-clamp-2 text-[22px] leading-tight font-bold">{title}</span>
            <Pencil className="h-4 w-4 shrink-0 text-faint" />
          </button>
          <div className="mt-1 flex items-center gap-2">
            <label className="text-[13px] font-medium text-muted" htmlFor="meal-eaten-at">
              Eaten
            </label>
            <input
              id="meal-eaten-at"
              type="datetime-local"
              value={toDateTimeLocal(view.at)}
              onChange={(e) => {
                const at = fromDateTimeLocal(e.target.value);
                if (at != null) edit(() => ({ at }));
              }}
              className="h-10 min-w-0 rounded-lg bg-surface-2 px-3 text-[16px] text-fg tabular-nums outline-none focus:ring-2 focus:ring-accent/60"
            />
          </div>
        </div>
        <MealSummary totals={view.totals} confidence={view.confidence} aside={<DayRing day={view.day} />} />
        {view.confidence != null || view.notes.trim() ? (
          <AnalysisNotes
            notes={view.notes}
            scaleReference={view.scaleReference}
            angles={view.angles}
            isPhoto={view.input.kind === 'photo'}
            weighedLabel={view.input.weightG ? formatGrams(view.input.weightG, mu) : null}
          />
        ) : null}
        <ServesStepper value={view.serves} onChange={(s) => edit(() => ({ serves: clampServes(s) }))} />
        {needsFdcKeyBanner(view.items, keys.fdc) ? (
          <Notice
            tone="warn"
            icon={<TriangleAlert className="h-5 w-5" />}
            actions={
              <Button variant="secondary" block onClick={() => void flush().then(() => nav(SETTINGS_PATH))}>
                Open Food settings
              </Button>
            }
          >
            USDA's shared key is busy. Add your free key in Food settings for database-accurate numbers.
          </Notice>
        ) : null}
      </div>

      <SectionHeader right={<span className="text-[13px] text-muted tabular-nums">{view.items.length}</span>}>Foods</SectionHeader>
      <div className="mx-4 divide-y divide-line overflow-hidden rounded-2xl bg-surface">
        {view.items.length ? (
          view.items.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              serves={view.serves}
              mu={mu}
              onRename={() => void renameItem(it)}
              onGrams={(g) => setItem(it.id, { grams: g })}
              onResetGrams={() => setItem(it.id, { grams: it.baselineGrams }, true)}
              onMenu={() => setMenuFor(it)}
            />
          ))
        ) : (
          <div className="px-6 py-8 text-center">
            <div className="text-[16px] font-semibold">No foods in this meal</div>
            <div className="mt-1 text-[14px] text-muted">Add one from the database or scan a barcode.</div>
          </div>
        )}
      </div>

      <div className="space-y-2 px-4 pt-4">
        <Button block variant="soft" icon={<Plus className="h-5 w-5" />} onClick={() => setAdding(true)}>
          Add food
        </Button>
        <Button block variant="secondary" icon={<ScanBarcode className="h-5 w-5" />} onClick={() => void addBarcode()}>
          Add barcode item
        </Button>
        <Button block variant="danger" icon={<Trash2 className="h-5 w-5" />} className="mt-4" onClick={() => void removeMeal()}>
          Delete meal
        </Button>
      </div>

      <ActionSheet open={!!menuFor} onClose={() => setMenuFor(null)} title={menuFor?.name} actions={menuActions} />
      <FoodSearchSheet
        open={!!changeFor}
        onClose={() => setChangeFor(null)}
        mode="change"
        title="Change food"
        initialQuery={changeFor ? changeFor.fdcQuery || changeFor.name : ''}
        onPick={(c) => {
          if (changeFor) changeFood(changeFor, c);
        }}
      />
      <FoodSearchSheet open={adding} onClose={() => setAdding(false)} mode="add" title="Add food" onPick={addFood} />
    </>
  );
}

/** Small ring: the meal's day eaten vs the kcal target ("Today" when it's today). */
function DayRing({ day }: { day: string }) {
  const totals = useDayTotals(day);
  const ts = useTargets();
  if (!totals || !ts) return null;
  const label = dayLabel(day, dayKey(Date.now()));
  const target = ts.targets?.kcal ?? null;
  if (!target) {
    return (
      <div className="shrink-0 text-right">
        <div className="text-[12px] font-medium text-muted">{label}</div>
        <div className="text-[17px] font-semibold tabular-nums">{formatKcal(totals.kcal)}</div>
        <div className="text-[11px] text-faint">kcal eaten</div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-center">
      <Ring value={totals.kcal} max={target} size={76} stroke={7}>
        <span className="text-[15px] leading-none font-semibold tabular-nums">{formatKcal(totals.kcal)}</span>
        <span className="text-[10px] text-faint tabular-nums">/ {formatKcal(target)}</span>
      </Ring>
      <span className="mt-1 text-[12px] font-medium text-muted">{label}</span>
    </div>
  );
}
