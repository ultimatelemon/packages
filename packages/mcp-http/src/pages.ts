const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #fbfbfa; color: #1a1a18;
  }
  main { width: min(30rem, calc(100vw - 2rem)); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; color: #5c5c56; }
  fieldset { border: 0; margin: 0 0 1.5rem; padding: 0; display: grid; gap: .5rem; }
  legend { font-weight: 600; margin-bottom: .25rem; }
  legend small { display: block; font-weight: 400; color: #5c5c56; }
  label {
    display: flex; gap: .75rem; align-items: baseline; padding: .75rem 1rem;
    border: 1px solid #dcdcd6; border-radius: .5rem; background: #fff; cursor: pointer;
  }
  label:has(input:checked) { border-color: #1a1a18; }
  .hint { display: block; color: #5c5c56; font-size: .875rem; }
  button {
    width: 100%; padding: .875rem 1rem; font: inherit; font-weight: 600; cursor: pointer;
    background: #1a1a18; color: #fbfbfa; border: 0; border-radius: .5rem;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #171715; color: #f2f2ef; }
    p, .hint, legend small { color: #a3a39c; }
    label { background: #201f1d; border-color: #35342f; }
    label:has(input:checked) { border-color: #f2f2ef; }
    button { background: #f2f2ef; color: #171715; }
  }
`;

export interface SettingsOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SettingsField {
  name: string;
  label: string;
  hint?: string;
  options: SettingsOption[];
  /** Checkboxes instead of radio buttons; the answer is the checked values joined by commas. */
  multiple?: boolean;
  /** Values checked when the page opens. */
  defaults?: string[];
}

export interface SettingsForm {
  title: string;
  intro?: string;
  fields: SettingsField[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function htmlResponse(
  body: string,
  status: number,
  formTargets: readonly string[] = []
): Response {
  const formAction = ["'self'", ...formTargets].join(' ');
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
      'x-frame-options': 'DENY'
    }
  });
}

export function errorPage(title: string, detail: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
  );
}

function fieldHtml(field: SettingsField): string {
  const type = field.multiple ? 'checkbox' : 'radio';
  const checked = new Set(
    field.defaults ?? (field.multiple ? [] : [field.options[0]?.value ?? ''])
  );
  const options = field.options
    .map(
      (option) => `<label>
        <input type="${type}" name="${escapeHtml(field.name)}" value="${escapeHtml(option.value)}"${checked.has(option.value) ? ' checked' : ''}>
        <span>${escapeHtml(option.label)}${option.hint ? `<span class="hint">${escapeHtml(option.hint)}</span>` : ''}</span>
      </label>`
    )
    .join('\n');
  const hint = field.hint ? `<small>${escapeHtml(field.hint)}</small>` : '';
  return `<fieldset><legend>${escapeHtml(field.label)}${hint}</legend>${options}</fieldset>`;
}

export function settingsPage(
  form: SettingsForm,
  action: string,
  pending: string
): string {
  const intro = form.intro ? `<p>${escapeHtml(form.intro)}</p>` : '';
  return page(
    form.title,
    `<h1>${escapeHtml(form.title)}</h1>${intro}
     <form method="post" action="${escapeHtml(action)}">
       <input type="hidden" name="pending" value="${escapeHtml(pending)}">
       ${form.fields.map(fieldHtml).join('\n')}
       <button type="submit">Connect</button>
     </form>`
  );
}
