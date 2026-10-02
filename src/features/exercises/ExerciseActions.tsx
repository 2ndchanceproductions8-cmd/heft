import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, GitBranch, Info, Pencil, RotateCcw } from 'lucide-react';
import type { Exercise } from '../../types';
import { ActionSheet, prompt, toast, type SheetAction } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import {
  createVariant,
  renameExercise,
  setExerciseHidden,
  variantFamily,
  variantName,
  variantRoot,
  type ExerciseIndex,
} from '../../lib/exercises';

/*
 * Shared exercise actions (picker rows, library rows, detail page menu): rename, gym/brand variants, hide.
 */

export const VARIANT_EXPLAINER = 'Same exercise on a different machine at your gym — it keeps its own weights & history.';

export const isRenamed = (ex: Exercise) => ex.source === 'catalog' && ex.name !== ex.originalName;

/** Prompt for a new name. Returns true when renamed. */
export async function promptRename(ex: Exercise): Promise<boolean> {
  const name = await prompt({
    title: 'Rename Exercise',
    message: 'Renames it everywhere. Your history is kept.',
    initial: ex.name,
    placeholder: ex.originalName,
    validate: (v) => (v.trim() ? null : 'Enter a name'),
  });
  if (name == null || name.trim() === ex.name) return false;
  try {
    await renameExercise(ex.id, name);
    toast('Renamed', 'success');
    return true;
  } catch {
    toast('Could not rename', 'error');
    return false;
  }
}

/** Reset a renamed catalog exercise to its original name. */
export async function resetName(ex: Exercise): Promise<void> {
  try {
    await renameExercise(ex.id, '');
    toast(`Reset to “${ex.originalName}”`, 'success');
  } catch {
    toast('Could not reset the name', 'error');
  }
}

/**
 * Prompt for a machine brand / gym label and create a variant of the exercise's root (so variants of
 * variants never chain names). Returns the new exercise id, or null when cancelled.
 */
export async function promptCreateVariant(
  index: ExerciseIndex,
  ex: Exercise,
): Promise<{ id: string; name: string } | null> {
  const base = variantRoot(index, ex.id);
  const family = variantFamily(index, base.id);
  const brand = await prompt({
    title: 'Machine / Brand Variant',
    message: (
      <>
        {VARIANT_EXPLAINER}
        <span className="mt-1.5 block text-[13px] text-faint">Variant of {base.name}</span>
      </>
    ),
    placeholder: 'e.g. Hammer Strength',
    confirmLabel: 'Create',
    validate: (v) => {
      const b = v.trim();
      if (!b) return 'Enter the machine brand or a label';
      if (family.some((f) => f.brand?.trim().toLowerCase() === b.toLowerCase())) return `You already have a ${b} variant`;
      return null;
    },
  });
  if (brand == null) return null;
  try {
    const id = await createVariant(base, brand.trim());
    const name = variantName(base.name, brand);
    toast(`Created “${name}”`, 'success');
    return { id, name };
  } catch {
    toast('Could not create the variant', 'error');
    return null;
  }
}

export async function toggleHidden(ex: Exercise): Promise<void> {
  try {
    await setExerciseHidden(ex.id, !ex.hidden);
    toast(ex.hidden ? 'Shown in library' : 'Hidden from library', 'success');
  } catch {
    toast('Could not update', 'error');
  }
}

/** Row menu for an exercise in the picker or the library. */
export function ExerciseActions({
  exercise,
  onClose,
  onViewDetails,
  onVariantCreated,
}: {
  /** null = closed. */
  exercise: Exercise | null;
  onClose: () => void;
  /** Defaults to navigating to the detail page. The picker closes itself first. */
  onViewDetails?: (ex: Exercise) => void;
  onVariantCreated?: (id: string, name: string, from: Exercise) => void;
}) {
  const index = useExercises();
  const nav = useNavigate();
  const ex = exercise;
  const actions: SheetAction[] = ex
    ? [
        {
          label: 'View Details',
          icon: <Info className="h-5 w-5" />,
          hint: 'History, records, progress & how-to',
          onClick: () => (onViewDetails ? onViewDetails(ex) : nav(`/exercises/${ex.id}`)),
        },
        {
          label: 'Rename',
          icon: <Pencil className="h-5 w-5" />,
          hint: 'Renames it everywhere. Your history is kept.',
          onClick: () => void promptRename(ex),
        },
        ...(isRenamed(ex)
          ? [
              {
                label: 'Reset Original Name',
                icon: <RotateCcw className="h-5 w-5" />,
                hint: ex.originalName,
                onClick: () => void resetName(ex),
              },
            ]
          : []),
        {
          label: 'Create Machine/Brand Variant',
          icon: <GitBranch className="h-5 w-5" />,
          hint: VARIANT_EXPLAINER,
          onClick: async () => {
            const created = await promptCreateVariant(index, ex);
            if (created) onVariantCreated?.(created.id, created.name, ex);
          },
        },
        {
          label: ex.hidden ? 'Show in Library' : 'Hide From Library',
          icon: ex.hidden ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />,
          onClick: () => void toggleHidden(ex),
        },
      ]
    : [];
  return (
    <ActionSheet
      open={!!ex}
      onClose={onClose}
      title={ex ? <span className="block truncate text-fg">{ex.name}</span> : undefined}
      actions={actions}
    />
  );
}
