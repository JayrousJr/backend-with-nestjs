export interface LinkEmailData {
  url: string;
  greeting: string;
  body: string;
  cta: string;
  expiry: string;
  ignore: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Single call-to-action email (activation, password reset). */
export function linkEmailTemplate(d: LinkEmailData): RenderedEmail {
  const text = `${d.greeting}

${d.body}
${d.url}

${d.expiry}

${d.ignore}`;

  const html = `
    <p>${escape(d.greeting)}</p>
    <p>${escape(d.body)}</p>
    <p><a href="${escape(d.url)}">${escape(d.cta)}</a></p>
    <p>${escape(d.expiry)}</p>
    <p style="color:#888">${escape(d.ignore)}</p>
  `;

  return { html, text };
}
