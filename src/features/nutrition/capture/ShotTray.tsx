import { Camera, ImagePlus, Plus, X } from 'lucide-react';
import { Spinner } from '../../../components/ui';
import { useMediaUrl } from '../../../lib/media';

export const MAX_PHOTOS = 4;

/**
 * The capture screen's photo strip: up to 4 shots of the plate (80 px thumbnails, each removable) plus a
 * "+ Angle" tile. With no photos yet it shows two big buttons instead (camera / library).
 */
export function ShotTray({
  photoIds,
  saving,
  onCamera,
  onLibrary,
  onRemove,
}: {
  photoIds: string[];
  /** A photo is being downscaled / saved. */
  saving: boolean;
  onCamera: () => void;
  onLibrary: () => void;
  onRemove: (id: string) => void;
}) {
  const full = photoIds.length >= MAX_PHOTOS;
  if (!photoIds.length && !saving) {
    return (
      <div className="rounded-2xl bg-surface p-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCamera}
            className="flex h-28 flex-col items-center justify-center gap-1.5 rounded-xl bg-accent text-[15px] font-semibold text-on-accent active:brightness-90"
          >
            <Camera className="h-7 w-7" />
            Take photo
          </button>
          <button
            type="button"
            onClick={onLibrary}
            className="flex h-28 flex-col items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-accent active:bg-surface-3"
          >
            <ImagePlus className="h-7 w-7" />
            From library
          </button>
        </div>
        <p className="mt-3 text-[13px] leading-snug text-muted">Shoot the whole plate from above, then add a side angle — height is where portion guesses go wrong.</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold tracking-wide text-muted uppercase">Photos</span>
        <span className="text-[13px] text-faint tabular-nums">
          {photoIds.length}/{MAX_PHOTOS}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {photoIds.map((id, i) => (
          <Thumb key={id} id={id} index={i} onRemove={() => onRemove(id)} />
        ))}
        {saving ? (
          <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-surface-2" role="status" aria-label="Saving photo">
            <Spinner />
          </div>
        ) : null}
        {!full && !saving ? (
          <button
            type="button"
            onClick={onCamera}
            aria-label="Add an angle"
            className="flex h-20 w-20 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-line bg-surface-2 text-[13px] font-semibold text-accent active:bg-surface-3"
          >
            <Plus className="h-6 w-6" />
            Angle
          </button>
        ) : null}
      </div>
      {!full ? (
        <>
          <p className="mt-3 text-[13px] leading-snug text-muted">Add a side angle — height is where portion guesses go wrong.</p>
          <button
            type="button"
            onClick={onLibrary}
            disabled={saving}
            className="mt-1 inline-flex h-10 items-center gap-1.5 text-[15px] font-medium text-accent active:opacity-60 disabled:opacity-40"
          >
            <ImagePlus className="h-4.5 w-4.5" />
            Choose from library
          </button>
        </>
      ) : (
        <p className="mt-3 text-[13px] text-muted">That's the maximum — remove one to swap it.</p>
      )}
    </div>
  );
}

function Thumb({ id, index, onRemove }: { id: string; index: number; onRemove: () => void }) {
  const url = useMediaUrl(id);
  return (
    <div className="relative h-20 w-20 overflow-hidden rounded-xl bg-surface-2">
      {url ? <img src={url} alt={`Meal photo ${index + 1}`} className="h-full w-full object-cover" /> : null}
      {/* The tile clips overflow, so the button itself is the 40px target; the small circle sits inside it. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove photo ${index + 1}`}
        className="group absolute top-0 right-0 flex h-10 w-10 items-center justify-center"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-backdrop text-white group-active:opacity-70">
          <X className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}
