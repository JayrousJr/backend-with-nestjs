import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Observable, tap } from 'rxjs';
import { RequestContext } from '../context/request-context';

const SLOW_QUERY_MS = 500;

@Injectable()
export class GqlLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('GraphQL');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<'graphql'>() !== 'graphql') return next.handle();

    const gqlCtx = GqlExecutionContext.create(context);
    const info = gqlCtx.getInfo<{
      fieldName: string;
      operation: { operation: string };
    }>();
    const operation = info.operation.operation;
    const field = info.fieldName;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        const user = RequestContext.getUser();
        const actor = user ? `${user.email} [#${user.id}]` : 'anonymous';

        if (operation === 'mutation') {
          this.logger.log(`${field} — ${actor} — ${duration}ms`);
        } else if (duration >= SLOW_QUERY_MS) {
          this.logger.warn(`${field} — ${actor} — ${duration}ms (slow)`);
        }
      }),
    );
  }
}
