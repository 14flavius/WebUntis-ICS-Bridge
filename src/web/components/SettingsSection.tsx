import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function SettingsSection({
  title,
  icon,
  description,
  status,
  children,
}: {
  title: string;
  icon: IconName;
  description?: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card settings-card">
      <header className="settings-section-heading">
        <span className={`settings-icon settings-icon-${icon}`}>
          <Icon name={icon} />
        </span>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
        {status}
      </header>
      <div className="settings-section-content">{children}</div>
    </section>
  );
}
