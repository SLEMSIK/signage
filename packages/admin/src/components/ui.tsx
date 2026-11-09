import { useEffect, type ReactNode } from 'react';
import type { MediaDto } from '@signage/shared';
import { formatDuration } from '../format';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const TYPE_LABEL: Record<MediaDto['type'], string> = {
  image: 'Изображение',
  video: 'Видео',
  html: 'HTML',
  html_zip: 'HTML-пакет',
};

export function MediaThumb({ media, showType = true }: { media: MediaDto | null | undefined; showType?: boolean }) {
  if (!media) return <div className="thumb">удалён</div>;
  return (
    <div className="thumb">
      {media.thumbUrl ? (
        <img src={media.thumbUrl} alt="" loading="lazy" />
      ) : media.type === 'html' || media.type === 'html_zip' ? (
        <span className="html-icon">&lt;/&gt;</span>
      ) : (
        <span>{TYPE_LABEL[media.type]}</span>
      )}
      {showType && (
        <span className="type">
          {TYPE_LABEL[media.type]}
          {media.durationSec ? ` · ${formatDuration(media.durationSec)}` : ''}
        </span>
      )}
    </div>
  );
}

/** Показ одного медиа в сцене 1920×1080, вписанной в контейнер 16:9. */
export function StagePreview({ media, fit = 'contain' }: { media: MediaDto | null; fit?: 'contain' | 'cover' | 'stretch' }) {
  const objectFit = fit === 'stretch' ? 'fill' : fit;
  return (
    <div className="preview-stage" ref={scaleStage}>
      <div className="scaler">
        {!media ? null : media.type === 'image' ? (
          <img src={media.url} alt="" style={{ objectFit }} />
        ) : media.type === 'video' ? (
          <video src={media.url} muted autoPlay loop playsInline style={{ objectFit }} />
        ) : (
          <iframe src={media.url} sandbox="allow-scripts allow-same-origin" title={media.title} />
        )}
      </div>
    </div>
  );
}

/** ref-колбэк: масштабирует сцену 1920×1080 под ширину контейнера (React 19 — с очисткой). */
export function scaleStage(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const apply = () => {
    const scaler = el.firstElementChild as HTMLElement | null;
    if (scaler) scaler.style.transform = `scale(${el.clientWidth / 1920})`;
  };
  apply();
  const ro = new ResizeObserver(apply);
  ro.observe(el);
  return () => ro.disconnect();
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <div className="alert alert-error">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
