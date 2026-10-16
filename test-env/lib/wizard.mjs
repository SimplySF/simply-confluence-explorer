// Minimal HTTP driver for Confluence's HTML setup wizard: a cookie jar,
// redirect following, and form parsing (action + hidden/default inputs + atl_token).

export class WizardSession {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.url = '';
    this.html = '';
  }

  storeCookies(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(url, { method = 'GET', form } = {}) {
    let target = new URL(url, this.baseUrl).toString();
    let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hops = 0; hops < 15; hops++) {
      const res = await fetch(target, {
        method,
        redirect: 'manual',
        headers: {
          Cookie: this.cookieHeader(),
          'X-Atlassian-Token': 'no-check',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
      });
      this.storeCookies(res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target).toString();
        method = 'GET';
        body = undefined;
        continue;
      }
      this.url = target;
      this.html = await res.text();
      this.status = res.status;
      return this;
    }
    throw new Error(`Too many redirects from ${url}`);
  }

  get path() {
    return new URL(this.url).pathname;
  }

  // Returns all forms on the current page with their default field values.
  forms() {
    const forms = [];
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let m;
    while ((m = formRe.exec(this.html))) {
      const attrs = m[1];
      const inner = m[2];
      const attr = (s, n) => (s.match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1];
      const fields = {};
      for (const [, tag] of inner.matchAll(/<input\b([^>]*)>/gi)) {
        const name = attr(tag, 'name');
        if (!name) continue;
        const type = (attr(tag, 'type') || 'text').toLowerCase();
        const value = decode(attr(tag, 'value') ?? '');
        if (type === 'radio' || type === 'checkbox') {
          if (/\bchecked\b/i.test(tag) && !(name in fields)) fields[name] = value;
        } else if (type !== 'submit' && type !== 'button' && type !== 'image') {
          fields[name] = value;
        }
      }
      for (const [, tag, body] of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
        const name = attr(tag, 'name');
        if (!name) continue;
        const sel = body.match(/<option\b[^>]*selected[^>]*value="([^"]*)"/i) || body.match(/<option\b[^>]*value="([^"]*)"/i);
        fields[name] = sel ? decode(sel[1]) : '';
      }
      forms.push({ name: attr(attrs, 'name') || attr(attrs, 'id') || '', action: decode(attr(attrs, 'action') || ''), fields });
    }
    return forms;
  }

  form(name) {
    const forms = this.forms();
    const f = name ? forms.find((x) => x.name === name) : forms[0];
    if (!f) throw new Error(`Form "${name}" not found on ${this.url}. Forms: ${forms.map((x) => x.name).join(', ')}`);
    return f;
  }

  async submit(formName, overrides = {}) {
    const f = this.form(formName);
    return this.request(new URL(f.action, this.url).toString(), { method: 'POST', form: { ...f.fields, ...overrides } });
  }

  errors() {
    return [...this.html.matchAll(/class="[^"]*(?:aui-message-error|error)[^"]*"[^>]*>([\s\S]*?)<\//gi)]
      .map((x) => x[1].replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);
  }
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
