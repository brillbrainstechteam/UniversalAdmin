'use client';

import { useState, type ReactNode } from 'react';
import { Button } from './components';

export interface ShellNavSection {
  heading?: string;
  items: { key: string; label: string; href: string; active: boolean }[];
}

/**
 * Responsive admin shell: skip link, labelled sidebar navigation (collapsible on small screens), top bar, main.
 * `renderLink` lets each app use its router's Link component.
 */
export function AppShell({
  brand,
  subtitle,
  sections,
  topbar,
  banner,
  children,
  renderLink,
}: {
  brand: string;
  subtitle?: string;
  sections: ShellNavSection[];
  topbar?: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
  renderLink: (props: {
    href: string;
    children: ReactNode;
    active: boolean;
    onClick: () => void;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="uc-shell" data-nav-open={open}>
      <a className="uc-skip" href="#main">
        Skip to content
      </a>
      <aside className="uc-sidebar" id="uc-sidebar">
        <div className="uc-brand">
          {brand}
          {subtitle && <small>{subtitle}</small>}
        </div>
        <nav className="uc-nav" aria-label="Main navigation">
          {sections.map((section, i) => (
            <div key={section.heading ?? i} className="uc-nav">
              {section.heading && <div className="uc-nav-heading">{section.heading}</div>}
              {section.items.map((item) => (
                <span key={item.key} style={{ display: 'contents' }}>
                  {renderLink({
                    href: item.href,
                    active: item.active,
                    onClick: () => setOpen(false),
                    children: item.label,
                  })}
                </span>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="uc-main">
        {banner}
        <div className="uc-topbar">
          <Button
            className="uc-btn uc-menu-toggle"
            variant="ghost"
            aria-controls="uc-sidebar"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            ☰ Menu
          </Button>
          {topbar}
        </div>
        <main id="main" className="uc-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
