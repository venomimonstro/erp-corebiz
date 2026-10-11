"use client";

import type { ReactNode } from "react";

export function StudioModal({
  title,
  eyebrow,
  description,
  children,
  footer,
  onClose
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="studio-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="studio-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            {eyebrow ? <span>{eyebrow}</span> : null}
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button
            className="studio-modal-close"
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="studio-modal-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  );
}
