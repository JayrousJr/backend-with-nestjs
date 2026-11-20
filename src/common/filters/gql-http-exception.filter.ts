import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { I18nContext, I18nService, I18nValidationException } from 'nestjs-i18n';
import { CurrentUser, RequestContext } from '../context/request-context';

const HTTP_STATUS_TO_GQL_CODE: Record<number, string> = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
};

@Injectable()
@Catch(HttpException)
export class GqlHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GqlHttpExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: HttpException, host: ArgumentsHost) {
    const status = exception.getStatus();
    this.log(status, exception);

    if (host.getType<'http' | 'graphql'>() === 'graphql') {
      const req = GqlArgumentsHost.create(host).getContext<{ req: Request }>()
        .req;
      return this.toGraphQLError(exception, req);
    }

    const req = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse() as
      | string
      | {
          message?: string;
          args?: Record<string, unknown>;
          [key: string]: unknown;
        };

    if (typeof body === 'string') {
      response.status(status).json({ statusCode: status, message: body });
    } else {
      const rawMessage = body.message;
      const message =
        typeof rawMessage === 'string' && rawMessage.startsWith('errors.')
          ? this.t(rawMessage, req, body.args)
          : rawMessage;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { args: _a, ...rest } = body;
      response.status(status).json({ ...rest, message });
    }
  }

  private getLang(req?: Request): string {
    return (
      RequestContext.getUser()?.preferredLocale ??
      (req?.user as CurrentUser | undefined)?.preferredLocale ??
      I18nContext.current()?.lang ??
      'en'
    );
  }

  private t(
    key: string,
    req?: Request,
    args?: Record<string, unknown>,
  ): string {
    return this.i18n.translate(key, { lang: this.getLang(req), args });
  }

  private log(status: number, exception: HttpException): void {
    const user = RequestContext.getUser();
    const actor = user ? `${user.email} [#${user.id}]` : 'anonymous';

    if (status >= 500) {
      this.logger.error(
        `[${status}] ${exception.message} — ${actor}`,
        exception.stack,
      );
    } else if (status === 401 || status === 403) {
      this.logger.warn(`[${status}] ${exception.message} — ${actor}`);
    }
  }

  private toGraphQLError(exception: HttpException, req: Request): GraphQLError {
    const status = exception.getStatus();
    const code = HTTP_STATUS_TO_GQL_CODE[status] ?? 'INTERNAL_SERVER_ERROR';
    const lang = this.getLang(req);

    if (exception instanceof I18nValidationException) {
      const message = this.t('validation.failed', req);
      const errors = exception.errors.map((e) => ({
        field: e.property,
        messages: Object.values(e.constraints ?? {}).map((raw) => {
          const pipeIdx = raw.indexOf('|');
          const key = pipeIdx === -1 ? raw : raw.slice(0, pipeIdx);
          const parsedArgs =
            pipeIdx === -1
              ? {}
              : (JSON.parse(raw.slice(pipeIdx + 1)) as Record<string, unknown>);
          return this.i18n.translate(key, {
            lang,
            args: { property: e.property, ...parsedArgs },
          });
        }),
      }));
      return new GraphQLError(message, {
        extensions: { code: 'BAD_USER_INPUT', status: 400, message, errors },
      });
    }

    const body = exception.getResponse() as
      | string
      | {
          message?: string | string[];
          args?: Record<string, unknown>;
          errors?: { field: string; messages: string[] }[];
        };

    if (typeof body !== 'string' && body.errors) {
      const message = this.t('validation.failed', req);
      return new GraphQLError(message, {
        extensions: { code, status, message, errors: body.errors },
      });
    }

    const rawMessage =
      typeof body === 'string' ? body : (body.message as string | undefined);
    const args = typeof body !== 'string' ? body.args : undefined;
    const message = rawMessage?.startsWith('errors.')
      ? this.t(rawMessage, req, args)
      : this.t(`errors.${code}`, req);
    return new GraphQLError(message, { extensions: { code, status, message } });
  }
}
