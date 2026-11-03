export function Screen({
  image,
  variant = 'page',
  width = 'wide',
  className = '',
  children
}) {
  return (
    <div
      className={`screen screen-${variant} ${className}`}
      style={image ? { backgroundImage: `url(${image})` } : undefined}
    >
      <div className="screen-overlay" aria-hidden="true" />
      <div className={`screen-content is-${width}`}>{children}</div>
    </div>
  );
}

export function Button({
  variant = 'primary',
  block = false,
  size,
  className = '',
  type = 'button',
  children,
  ...props
}) {
  const classes = [
    'btn',
    `btn-${variant}`,
    block ? 'btn-block' : '',
    size === 'lg' ? 'btn-lg' : '',
    className
  ].filter(Boolean).join(' ');

  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  );
}

export function TextField({
  label,
  id,
  hint,
  error,
  className = '',
  inputClassName = '',
  ...props
}) {
  const fieldId = id || props.name;
  const message = error || hint;
  const messageId = message ? `${fieldId}-message` : undefined;

  return (
    <div className={`field ${className}`.trim()}>
      {label ? <label htmlFor={fieldId}>{label}</label> : null}
      <input
        id={fieldId}
        className={`input ${inputClassName}`.trim()}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={messageId}
        {...props}
      />
      {message ? (
        <p id={messageId} className={error ? 'field-error' : 'field-hint'}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function Panel({ title, className = '', children, as: Tag = 'section' }) {
  return (
    <Tag className={`panel ${className}`.trim()}>
      {title ? <h2 className="panel-title">{title}</h2> : null}
      {children}
    </Tag>
  );
}

export function Alert({ children }) {
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ className = '' }) {
  return <span className={`spinner ${className}`.trim()} aria-hidden="true" />;
}

export function formatMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `£${value}` : '—';
}
