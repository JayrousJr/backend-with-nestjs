import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';
import { Prisma } from '@db';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { CurrentUser, RequestContext } from '../context/request-context';

interface PrismaErrorResolution {
  status: number;
  code: string;
  i18nKey: string;
}

const PRISMA_CODE_MAP: Record<string, PrismaErrorResolution> = {
  P2002: {
    status: HttpStatus.CONFLICT,
    code: 'CONFLICT',
    i18nKey: 'errors.database_conflict',
  },
  P2025: {
    status: HttpStatus.NOT_FOUND,
    code: 'NOT_FOUND',
    i18nKey: 'errors.record_not_found',
  },
  P2003: {
    status: HttpStatus.BAD_REQUEST,
    code: 'BAD_USER_INPUT',
    i18nKey: 'errors.related_record_not_found',
  },
};

const FALLBACK: PrismaErrorResolution = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'INTERNAL_SERVER_ERROR',
  i18nKey: 'errors.INTERNAL_SERVER_ERROR',
};

@Injectable()
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): GraphQLError | void {
    const mapped = PRISMA_CODE_MAP[exception.code];

    if (!mapped) {
      const user = RequestContext.getUser();
      const actor = user ? `${user.email} [#${user.id}]` : 'anonymous';
      this.logger.error(
        `Unhandled Prisma error ${exception.code} — ${actor}`,
        exception.stack,
      );
    }

    const resolved = mapped ?? FALLBACK;

    let req: Request | undefined;
    if (host.getType<'http' | 'graphql'>() === 'graphql') {
      req = GqlArgumentsHost.create(host).getContext<{ req: Request }>().req;
      const message = this.t(resolved.i18nKey, req);
      return new GraphQLError(message, {
        extensions: { code: resolved.code, status: resolved.status, message },
      });
    }

    const message = this.t(resolved.i18nKey);
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(resolved.status)
      .json({ statusCode: resolved.status, message });
  }

  private t(key: string, req?: Request): string {
    const lang =
      RequestContext.getUser()?.preferredLocale ??
      (req?.user as CurrentUser | undefined)?.preferredLocale ??
      I18nContext.current()?.lang ??
      'en';
    return this.i18n.translate(key, { lang });
  }
}
