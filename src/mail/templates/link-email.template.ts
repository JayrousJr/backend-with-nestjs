export interface PasswordResetEmailData {
  resetUrl: string;
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

export function passwordResetEmailTemplate({
  resetUrl,
  greeting,
  body,
  cta,
  expiry,
  ignore,
}: PasswordResetEmailData): RenderedEmail {
  const text = `${greeting}

${body}
${resetUrl}

${expiry}

${ignore}`;

  const html = `
    <p>${greeting}</p>
    <p>${body}</p>
    <p><a href="${resetUrl}">${cta}</a></p>
    <p>${expiry}</p>
    <p style="color:#888">${ignore}</p>
  `;

  return { html, text };
}
