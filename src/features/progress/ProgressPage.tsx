import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChartColumn, Play, Settings as SettingsIcon } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Loading, Page, TopBar } from '../../components/ui';
import { MuscleMap } from '../../components/MuscleMap';
import { useSettings } from '../../lib/settings';
import { useWakeNow } from '../../lib/useWakeNow';
import { useWorkouts } from '../../lib/workouts';
import { beginWorkout } from '../../lib/startWorkout';
import { ThisWeekCard, WeeklyChartCard } from './components/WeekCards';
import { MuscleMapCard } from './components/MuscleMapCard';
import { BodyCard, RecentRecordsCard, TopExercisesCard } from './components/ListCards';

export function ProgressPage() {
  const navigate = useNavigate();
  const settings = useSettings();
  const workouts = useWorkouts(); // newest first; undefined while loading
  // An installed app can sit suspended on this tab for days: useWakeNow refreshes when it comes back to the
  // foreground. "now" also moves on whenever history changes (and stays stable between other renders, which
  // keeps the memoized stats stable).
  const wakeNow = useWakeNow();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [workouts, wakeNow]);

  return (
    <Page tabBar>
      <TopBar
        title="Progress"
        large
        right={
          <IconButton label="Settings" tone="accent" onClick={() => navigate('/settings')}>
            <SettingsIcon className="h-[22px] w-[22px]" />
          </IconButton>
        }
      />
      {workouts === undefined ? (
        <Loading />
      ) : workouts.length === 0 ? (
        <div className="space-y-3 px-4 pt-2">
          <Card className="overflow-hidden px-4 pt-6">
            <div className="mx-auto max-w-[240px] opacity-80">
              <MuscleMap />
            </div>
            <EmptyState
              className="px-2 pt-6 pb-8"
              icon={<ChartColumn className="h-7 w-7" />}
              title="Your progress lives here"
              message="Finish your first workout and this tab fills up with weekly charts, a muscle heat map of what you trained, your personal records and streaks."
              action={
                <Button icon={<Play className="h-4 w-4" fill="currentColor" />} onClick={() => void beginWorkout({ type: 'empty' }, navigate)}>
                  Start Workout
                </Button>
              }
            />
          </Card>
          <BodyCard settings={settings} now={now} />
        </div>
      ) : (
        <div className="space-y-3 px-4 pt-2">
          <ThisWeekCard workouts={workouts} settings={settings} now={now} />
          <WeeklyChartCard workouts={workouts} settings={settings} now={now} />
          <MuscleMapCard workouts={workouts} now={now} />
          <RecentRecordsCard workouts={workouts} settings={settings} now={now} />
          <TopExercisesCard workouts={workouts} settings={settings} />
          <BodyCard settings={settings} now={now} />
        </div>
      )}
    </Page>
  );
}
