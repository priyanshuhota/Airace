export default function PanelCard({
  title,
  subtitle,
  children,
  accent = 'cyan',
  badge = null,
  icon = null,
}) {
  return (
    <section className={`panel-card panel-${accent}`}>
      <div className="panel-head">
        <div className="panel-head-main">
          {icon ? <div className="panel-icon" aria-hidden="true">{icon}</div> : null}

          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </div>

        {badge || null}
      </div>

      <div className="panel-body">{children}</div>
    </section>
  );
}