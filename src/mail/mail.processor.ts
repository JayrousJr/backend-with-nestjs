import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';
import { I18nService } from 'nestjs-i18n';
import { AppConfigService } from '@config';
import { MAIL_QUEUE } from './mail.constants';
import { CodeEmailJob, GenericEmailJob, LinkEmailJob } from './mail.service';
import { linkEmailTemplate } from './templates/link-email.template';

interface MailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

@Processor(MAIL_QUEUE)
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);
  private readonly sendMail: (payload: MailPayload) => Promise<void>;

  constructor(
    private readonly config: AppConfigService,
    private readonly i18n: I18nService,
  ) {
    super();

    const mailer = this.config.mail.mailer;

    if (mailer === 'smtp' && this.config.mail.host) {
      const transporter = nodemailer.createTransport({
        host: this.config.mail.host,
        port: Number(this.config.mail.port) || 465,
        secure: this.config.mail.encryption?.toUpperCase() === 'SSL',
        auth: {
          user: this.config.mail.user,
          pass: this.config.mail.password,
        },
        pool: true,
        maxConnections: 5,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
      const from = this.config.mail.from;
      this.sendMail = async (payload) => {
        await transporter.sendMail({ from, ...payload });
      };
      this.logger.log(`Mail transport: SMTP (${this.config.mail.host})`);
    } else if (this.config.resend.apiKey) {
      const resend = new Resend(this.config.resend.apiKey);
      const from = this.config.resend.from;
      this.sendMail = async (payload) => {
        await resend.emails.send({ from, ...payload });
      };
      this.logger.log('Mail transport: Resend');
    } else {
      this.sendMail = (payload) => {
        this.logger.warn(`No mail transport — skipping email to ${payload.to}`);
        return Promise.resolve();
      };
      this.logger.warn(
        'No mail transport configured (set MAIL_MAILER=smtp or RESEND_API_KEY)',
      );
    }
  }

  private t(key: string, lang: string, args?: Record<string, unknown>): string {
    return this.i18n.translate(key, { lang, args });
  }

  async process(
    job: Job<LinkEmailJob | CodeEmailJob | GenericEmailJob>,
  ): Promise<void> {
    if (job.name === 'generic') {
      const d = job.data as GenericEmailJob;
      const { html, text } = linkEmailTemplate({
        url: d.url ?? '',
        greeting: d.greeting,
        body: d.body,
        cta: d.cta ?? d.url ?? '',
        expiry: d.footer ?? '',
        ignore: '',
      });
      await this.sendMail({ to: d.email, subject: d.subject, html, text });
      this.logger.log(`Sent generic email to ${d.email}`);
      return;
    }
    if (job.name === 'two-factor-code') {
      return this.processCode(job as Job<CodeEmailJob>);
    }
    const { email, firstName, token, locale, validFor } =
      job.data as LinkEmailJob;
    const lang = locale || 'en';
    let subject: string, html: string, text: string;

    if (job.name === 'activation-email') {
      subject = this.t('mail.activation.subject', lang);
      ({ html, text } = linkEmailTemplate({
        url: `${this.config.frontendUrl}/auth/activate?token=${token}`,
        greeting: this.t('mail.activation.greeting', lang, { firstName }),
        body: this.t('mail.activation.body', lang),
        cta: this.t('mail.activation.cta', lang),
        expiry: this.t('mail.activation.expiry', lang, { hours: validFor }),
        ignore: this.t('mail.activation.ignore', lang),
      }));
    } else if (job.name === 'password-reset-email') {
      subject = this.t('mail.password_reset.subject', lang);
      ({ html, text } = linkEmailTemplate({
        url: `${this.config.frontendUrl}/auth/reset-password?token=${token}`,
        greeting: this.t('mail.password_reset.greeting', lang, { firstName }),
        body: this.t('mail.password_reset.body', lang),
        cta: this.t('mail.password_reset.cta', lang),
        expiry: this.t('mail.password_reset.expiry', lang, {
          minutes: validFor,
        }),
        ignore: this.t('mail.password_reset.ignore', lang),
      }));
    } else {
      return;
    }

    await this.sendMail({ to: email, subject, html, text });
    this.logger.log(`Sent ${job.name} to ${email} [${lang}]`);
  }

  private async processCode(job: Job<CodeEmailJob>): Promise<void> {
    const { email, firstName, code, locale, validFor } = job.data;
    const lang = locale || 'en';
    const greeting = this.t('mail.two_factor.greeting', lang, { firstName });
    const body = this.t('mail.two_factor.body', lang);
    const expiry = this.t('mail.two_factor.expiry', lang, {
      minutes: validFor,
    });
    const ignore = this.t('mail.two_factor.ignore', lang);
    const text = `${greeting}\n\n${body}\n\n${code}\n\n${expiry}\n\n${ignore}`;
    const html = `<p>${greeting}</p><p>${body}</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>${expiry}</p><p style="color:#888">${ignore}</p>`;
    await this.sendMail({
      to: email,
      subject: this.t('mail.two_factor.subject', lang),
      html,
      text,
    });
    this.logger.log(`Sent ${job.name} to ${email} [${lang}]`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Mail job ${job.id} (${job.name}) failed: ${error.message}`,
    );
  }
}
