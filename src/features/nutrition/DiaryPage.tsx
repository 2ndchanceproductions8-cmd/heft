import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, ChevronLeft, ChevronRight, Plus, ScanBarcode, Search, Settings as SettingsIcon, Utensils, Zap } from 'lucide-react';
import { ActionSheet, Button, EmptyState, IconButton, ListGroup, Loading, Page, SectionHeader, TopBar, toast } from '../../components/ui';
import { atForDay, dayKey, shiftDay, sumMeals } from '../../lib/nutrition/math';
import { createMeal, itemFromChoice, useDayMeals, useTargets, useUnfinishedMeals, type TargetsState } from '../../lib/nutrition/store';
import { useDayBurn, type DayBurn } from '../../lib/nutrition/burn';
import type { FoodChoice, Meal } from '../../lib/nutrition/types';
import { FoodSearchSheet } from './FoodSearchSheet';
import { dayPhrase, dayQuery, diaryTitle, parseDiaryDay, useTodayKey } from './diary/day';
import { FoodErrorBoundary } from './diary/FoodErrorBoundary';
import { MealRow } from './diary/MealRow';
import { buildQuickAdd, QuickAddSheet, type QuickAddValues } from './diary/QuickAddSheet';
import { TargetsSummary } from './diary/TargetsSummary';
import { TrainingDayChip } from './diary/TrainingDayChip';
import { TrainingLine } from './diary/TrainingLine';
import { otherDayUnfinished, UnfinishedMeals } from './diary/UnfinishedMeals';

/*
 * Food tab root (/nutrition, ?d=yyyy-MM-dd for another day): the day's budget, workout burn (display only),
 * "Log food", unfinished meals from other days, and the day's meals in the order they were eaten.
 */
export function DiaryPage() {
  return (
    <FoodErrorBoundary title="Food">
      <DiaryScreen />
    </FoodErrorBoundary>
  );
}

function DiaryScreen() {
  const navigate = useNavigate();
  const today = useTodayKey();
  const [params, setParams] = useSearchParams();
  const day = parseDiaryDay(params.get('d'), today);
  const isToday = day === today;

  const meals = useDayMeals(day);
  // Per day: Maintain · Recomp's target depends on whether that day is a training day.
  const targets = useTargets(day);
  const burn = useDayBurn(day);
  const unfinished = otherDayUnfinished(useUnfinishedMeals(), day);

  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [quick, setQuick] = useState(false);

  const goDay = (d: string) => setParams(d >= today ? {} : { d }, { replace: true });
  const q = dayQuery(day, today);
  const where = dayPhrase(day, today);

  const addSearched = async (choice: FoodChoice, grams: number | null) => {
    if (grams == null || !(grams > 0)) return;
    try {
      await createMeal({
        input: { kind: 'search' },
        status: 'done',
        at: atForDay(day, Date.now()),
        title: choice.name,
        items: [itemFromChoice(choice, grams)],
      });
      toast(`Added to ${where}`, 'success');
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message || 'unknown error'}`, 'error');
    }
  };

  const addQuick = async (v: QuickAddValues) => {
    await createMeal(buildQuickAdd(v, atForDay(day, Date.now())));
    toast(`Added to ${where}`, 'success');
  };

  return (
    <Page tabBar>
      <TopBar
        title={diaryTitle(day, today)}
        large
        left={
          isToday ? null : (
            <button
              type="button"
              onClick={() => goDay(today)}
              className="ml-2 inline-flex h-10 items-center rounded-full bg-accent-soft px-4 text-[14px] font-semibold text-accent active:brightness-110"
            >
              Today
            </button>
          )
        }
        right={
          <>
            <IconButton label="Previous day" tone="accent" onClick={() => goDay(shiftDay(day, -1))}>
              <ChevronLeft className="h-6 w-6" />
            </IconButton>
            <IconButton label="Next day" tone="accent" disabled={isToday} onClick={() => goDay(shiftDay(day, 1))}>
              <ChevronRight className="h-6 w-6" />
            </IconButton>
            <IconButton label="Food settings" tone="accent" onClick={() => navigate('/nutrition/settings')}>
              <SettingsIcon className="h-[22px] w-[22px]" />
            </IconButton>
          </>
        }
      />

      <DiaryContent
        meals={meals}
        targets={targets}
        burn={burn}
        unfinished={unfinished}
        today={today}
        onLog={() => setMenu(true)}
        onSettings={() => navigate('/nutrition/settings')}
      />

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={isToday ? 'Log food' : `Log food for ${where}`}
        actions={[
          {
            label: 'Photo or description',
            hint: 'Claude identifies it, USDA supplies the numbers',
            icon: <Camera className="h-5 w-5" />,
            onClick: () => navigate(`/nutrition/log${q}`),
          },
          {
            label: 'Scan barcode',
            hint: 'Numbers from the label',
            icon: <ScanBarcode className="h-5 w-5" />,
            onClick: () => navigate(`/nutrition/scan${q}`),
          },
          {
            label: 'Search foods',
            hint: 'USDA database and your recent foods',
            icon: <Search className="h-5 w-5" />,
            onClick: () => setSearch(true),
          },
          {
            label: 'Quick add',
            hint: 'Just the calories, macros optional',
            icon: <Zap className="h-5 w-5" />,
            onClick: () => setQuick(true),
          },
        ]}
      />
      {search ? (
        <FoodSearchSheet
          open
          mode="add"
          title="Search foods"
          onClose={() => setSearch(false)}
          onPick={(choice, grams) => {
            setSearch(false);
            void addSearched(choice, grams);
          }}
        />
      ) : null}
      <QuickAddSheet open={quick} onClose={() => setQuick(false)} onSave={addQuick} />
    </Page>
  );
}

/**
 * The Diary body with plain props (live data comes from DiaryScreen), so it renders in tests. `undefined`
 * means still loading. `unfinished` = unfinished meals from OTHER days (see UnfinishedMeals).
 */
export function DiaryContent({
  meals,
  targets,
  burn,
  unfinished = [],
  today = dayKey(Date.now()),
  onLog,
  onSettings,
}: {
  meals: Meal[] | undefined;
  targets: Pick<TargetsState, 'targets' | 'missing'> & Partial<Pick<TargetsState, 'day' | 'training'>> | undefined;
  burn: DayBurn | undefined;
  unfinished?: Meal[];
  today?: string;
  onLog: () => void;
  onSettings: () => void;
}) {
  const totals = meals ? sumMeals(meals) : undefined;
  const notCounted = meals?.some((m) => m.status !== 'done') ?? false;
  return (
    <>
      <div className="pt-3">
        <TargetsSummary
          totals={totals}
          targets={targets?.targets ?? null}
          missing={targets?.missing ?? []}
          loading={meals === undefined || targets === undefined}
          onSetup={onSettings}
          footer={
            targets?.targets?.recomp && targets.training && targets.day ? (
              <TrainingDayChip day={targets.day} training={targets.training} recomp={targets.targets.recomp} />
            ) : null
          }
        />
        <TrainingLine burn={burn} hasTarget={!!targets?.targets} onSettings={onSettings} />
      </div>

      <div className="px-4 pt-4">
        <Button block size="lg" icon={<Plus className="h-5 w-5" strokeWidth={2.5} />} onClick={onLog}>
          Log food
        </Button>
      </div>

      <UnfinishedMeals meals={unfinished} today={today} />

      {meals === undefined ? (
        <Loading />
      ) : meals.length === 0 ? (
        <EmptyState
          icon={<Utensils className="h-7 w-7" />}
          title="Nothing logged"
          message="Snap a photo or describe your meal, scan a barcode, or search for a food."
        />
      ) : (
        <>
          <SectionHeader>Meals</SectionHeader>
          <ListGroup>
            {meals.map((m) => (
              <MealRow key={m.id} meal={m} />
            ))}
          </ListGroup>
          {notCounted ? (
            <p className="px-5 pt-2 text-[12px] text-faint">Only analyzed meals count toward your totals.</p>
          ) : null}
        </>
      )}
    </>
  );
}
