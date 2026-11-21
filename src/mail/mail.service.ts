import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MAIL_QUEUE } from './mail.constants';

export interface LinkEmailJob {
  email: string;
  firstName: string;
  token: string;
  locale: string;
  /** Link validity shown in the email (hours or minutes). */
  validFor: number;
}

export interface CodeEmailJob {
  email: string;
  firstName: string;
  code: string;
  locale: string;
  /** Minutes the code stays valid. */
  validFor: number;
}

/** Pre-written email (texts already in the recipient's language). */
export interface GenericEmailJob {
  email: string;
  subject: string;
  greeting: string;
  body: string;
  url?: string;
  cta?: string;
  footer?: string;
}

const RETRY = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
} as const;

@Injectable()
export class MailService {
  constructor(@InjectQueue(MAIL_QUEUE) private readonly queue: Queue) {}

  async queueActivationEmail(data: LinkEmailJob): Promise<void> {
    await this.queue.add('activation-email', data, RETRY);
  }

  async queuePasswordResetEmail(data: LinkEmailJob): Promise<void> {
    await this.queue.add('password-reset-email', data, RETRY);
  }

  async queueGeneric(data: GenericEmailJob): Promise<void> {
    await this.queue.add('generic', data, RETRY);
  }

  async queueTwoFactorCode(data: CodeEmailJob): Promise<void> {
    await this.queue.add('two-factor-code', data, RETRY);
  }
}
