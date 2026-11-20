import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContext, CurrentUser } from '../context/request-context';
import { getRequest } from '../context/get-request';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = getRequest(context);
    const user = request.user as CurrentUser | undefined;
    const requestId = request.headers['x-request-id'] as string | undefined;
    const ipAddress = request.ip;
    const onBehalfOfUserId = (request as { onBehalfOfUserId?: number })
      .onBehalfOfUserId;

    return new Observable((observer) => {
      RequestContext.run(
        { user, requestId, ipAddress, onBehalfOfUserId },
        () => {
          next.handle().subscribe(observer);
        },
      );
    });
  }
}
