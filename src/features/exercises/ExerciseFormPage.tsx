import { useCallback, useEffect, useRef } from 'react';
import { Navigate, useBlocker, useNavigate, useParams, useSearchParams, type BlockerFunction } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { Button, EmptyState, Loading, Page, TopBar, confirm, toast } from '../../components/ui';
import { ExerciseFormFields, useExerciseForm } from './ExerciseForm';
import { useGoBack } from './hooks';
import { HeaderButton } from './parts';

/**
 * /exercises/new                      create a custom exercise
 * /exercises/new?variantOf=<id>       create a gym/brand variant (prefilled from the base exercise)
 * /exercises/:id/edit                 edit a custom exercise (catalog ids redirect to the detail page)
 */
export function ExerciseFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  if (id && !id.startsWith('c_')) return <Navigate to={`/exercises/${encodeURIComponent(id)}`} replace />;
  // Fresh form state per target (edit id / variant base).
  return <FormPage key={id ?? `new:${params.get('variantOf') ?? ''}`} editId={id ?? null} />;
}

function FormPage({ editId }: { editId: string | null }) {
  const [params] = useSearchParams();
  const variantOfId = editId ? null : params.get('variantOf');
  const nav = useNavigate();
  const cancel = useGoBack(editId ? `/exercises/${editId}` : '/exercises');
  const form = useExerciseForm({ editId, variantOfId, initialName: params.get('name') ?? undefined });

  // ---- leaving with unsaved changes (Cancel, Android back, tab links...) asks first
  const dirtyRef = useRef(false);
  dirtyRef.current = form.dirty;
  const leaving = useRef(false);
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
    [],
  );
  const blocker = useBlocker(shouldBlock);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const prompting = useRef(false);
  useEffect(() => {
    if (blocker.state !== 'blocked' || prompting.current) return;
    prompting.current = true;
    void confirm({
      title: 'Discard changes?',
      message: form.mode === 'edit' ? 'Your changes to this exercise will be lost.' : 'This exercise has not been saved.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep Editing',
      danger: true,
    }).then((ok) => {
      prompting.current = false;
      const b = blockerRef.current;
      if (b.state !== 'blocked') return;
      if (ok) {
        leaving.current = true;
        b.proceed();
      } else b.reset();
    });
  }, [blocker.state, form.mode]);

  const title =
    form.mode === 'edit' ? 'Edit Exercise' : form.mode === 'variant' ? 'New Variant' : 'Create Exercise';

  const submit = async () => {
    const id = await form.save();
    if (!id) return;
    toast(form.mode === 'edit' ? 'Saved' : form.mode === 'variant' ? 'Variant created' : 'Exercise created', 'success');
    leaving.current = true;
    if (form.mode === 'edit') cancel();
    else nav(`/exercises/${id}`, { replace: true });
  };

  return (
    <Page>
      <TopBar
        title={title}
        left={<HeaderButton onClick={cancel}>Cancel</HeaderButton>}
        right={
          <HeaderButton
            bold
            onClick={() => void submit()}
            disabled={form.status !== 'ready' || form.saving || form.photoBusy}
          >
            {form.saving ? 'Saving…' : 'Save'}
          </HeaderButton>
        }
      />
      {form.status === 'loading' ? (
        <Loading />
      ) : form.status === 'notfound' ? (
        <EmptyState
          icon={<SearchX className="h-7 w-7" />}
          title="Exercise not found"
          message={form.mode === 'variant' ? 'The exercise to make a variant of no longer exists.' : 'It may have been deleted.'}
          action={<Button onClick={() => nav('/exercises', { replace: true })}>Browse Exercises</Button>}
        />
      ) : (
        <>
          {form.mode === 'variant' && form.base ? (
            <div className="mx-4 mt-4 rounded-2xl bg-accent-soft px-4 py-3 text-[14px] leading-snug text-fg">
              <span className="font-semibold text-accent">Variant of {form.base.name}.</span> Same movement on a different
              machine — it keeps its own weights, history and records.
            </div>
          ) : null}
          <ExerciseFormFields form={form} />
          <div className="px-4 pb-6">
            <Button block size="lg" onClick={() => void submit()} disabled={form.saving || form.photoBusy}>
              {form.saving ? 'Saving…' : form.mode === 'edit' ? 'Save Changes' : form.mode === 'variant' ? 'Create Variant' : 'Create Exercise'}
            </Button>
          </div>
        </>
      )}
    </Page>
  );
}
