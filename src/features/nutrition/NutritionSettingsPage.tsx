import { useLocation } from 'react-router-dom';
import { startOfMonth } from 'date-fns';
import { Loading, Page, SectionHeader, TopBar } from '../../components/ui';
import { useWakeNow } from '../../lib/useWakeNow';
import { useNutritionKeys } from '../../lib/nutrition/keys';
import { useAiSpend } from '../../lib/nutrition/store';
import { bodyFromSettings, computeTargets } from '../../lib/nutrition/targets';
import { FoodErrorBoundary } from './diary/FoodErrorBoundary';
import { BodySection } from './settings/BodySection';
import { useFoodSettingsData } from './settings/data';
import { ClaudeKeySection, UsdaKeySection } from './settings/KeysSection';
import { ActivitySection, GoalSection } from './settings/PlanSection';
import { TargetsCard } from './settings/TargetsCard';

/*
 * Food settings (/nutrition/settings): body inputs (shared with Heft's Settings), activity + goal, the
 * resulting targets with optional overrides, and the device-only API keys.
 */
export function NutritionSettingsPage() {
  const location = useLocation();
  // Back returns to the Diary day you came from; a deep link (no history) goes to the Diary.
  const back = location.key === 'default' ? '/nutrition' : true;
  return (
    <FoodErrorBoundary title="Food settings" back="/nutrition">
      <SettingsScreen back={back} />
    </FoodErrorBoundary>
  );
}

function SettingsScreen({ back }: { back: string | boolean }) {
  const now = useWakeNow();
  const data = useFoodSettingsData();
  const keys = useNutritionKeys();
  const spend = useAiSpend(startOfMonth(now).getTime());

  const body = data ? bodyFromSettings(data.settings, data.bodyweightKg, now).body : null;
  // The same day as the live targets (Maintain · Recomp: training or rest today), without the overrides.
  const recompDay = data?.training
    ? { trainingDay: data.training.training, trainingDaysPerWeek: data.targets?.recomp?.trainingDaysPerWeek ?? null }
    : undefined;
  const auto = data && body ? computeTargets({ ...data.profile, kcalOverride: null, proteinOverride: null }, body, recompDay) : null;

  return (
    <Page tabBar>
      <TopBar title="Food settings" back={back} />

      {data === undefined ? (
        <Loading />
      ) : (
        <>
          <SectionHeader>Body</SectionHeader>
          <BodySection settings={data.settings} bodyweightKg={data.bodyweightKg} latest={data.latest} now={now} />
          <p className="px-5 pt-2 text-[13px] leading-snug text-muted">Shared with Heft's Settings. Used for your calorie target.</p>

          <SectionHeader>Activity</SectionHeader>
          <ActivitySection activity={data.profile.activity} />

          <SectionHeader>Goal</SectionHeader>
          <GoalSection goal={data.profile.goal} pace={data.profile.pace} recomp={data.profile.recomp} />

          <SectionHeader>Daily targets</SectionHeader>
          <TargetsCard targets={data.targets} auto={auto} missing={data.missing} profile={data.profile} />
        </>
      )}

      <SectionHeader>Claude (photo analysis)</SectionHeader>
      <ClaudeKeySection saved={keys.anthropic} spend={spend} />

      <SectionHeader>USDA FoodData Central</SectionHeader>
      <UsdaKeySection saved={keys.fdc} />

      <p className="px-6 pt-6 text-center text-[12px] leading-snug text-faint">
        Nutrition data: USDA FoodData Central (public domain) · Open Food Facts (ODbL).
      </p>
    </Page>
  );
}
