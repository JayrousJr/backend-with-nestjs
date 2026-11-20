import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { NotificationType, Prisma } from '@db';
import { RequestContext, offsetPaginate, PaginationInput } from '@common';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsRepository } from './notifications.repository';
import {
  NotificationFilterInput,
  buildNotificationWhere,
} from './dto/notification.filter';

export interface NotifyInput {
  /** Frontend i18n key for the title, e.g. "notifications.campaign_sent_title" */
  titleKey: string;
  /** Frontend i18n key for the body */
  messageKey: string;
  /** Interpolation values for the i18n keys */
  params?: Record<string, string | number>;
  type?: NotificationType;
  /** In-app route to navigate to when the notification is clicked */
  link?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly gateway: EventsGateway,
  ) {}

  /**
   * Persist a notification for a user and push it to their open sockets.
   * Fire-and-forget safe: failures are logged, never thrown, so a broken
   * notification can't fail the business operation that produced it.
   */
  async notify(userId: number, input: NotifyInput): Promise<void> {
    try {
      const row = await this.notifications.create({
        user: { connect: { id: userId } },
        type: input.type ?? 'INFO',
        titleKey: input.titleKey,
        messageKey: input.messageKey,
        params: input.params,
        link: input.link,
      });
      this.gateway.emitToUser(userId, 'notification', this.toEntity(row));
    } catch (error) {
      this.logger.error(`Failed to notify user ${userId}: ${error}`);
    }
  }

  async getMyNotifications(
    filter?: NotificationFilterInput,
    pagination?: PaginationInput,
  ) {
    const user = RequestContext.getUser();
    if (!user) throw new UnauthorizedException();

    const where = buildNotificationWhere(user.id, filter);
    const [result, unreadCount] = await Promise.all([
      offsetPaginate(
        (args) => this.notifications.findMany({ ...args, where }),
        () => this.notifications.count(where),
        pagination,
      ),
      this.notifications.countUnread(user.id),
    ]);

    return {
      ...result,
      data: result.data.map((row) => this.toEntity(row)),
      unreadCount,
    };
  }

  async markRead(uniqueId: string) {
    const user = RequestContext.getUser();
    if (!user) throw new UnauthorizedException();

    const notification = await this.notifications.findByUniqueId(uniqueId);
    // Users can only touch their own notifications; a foreign uniqueId is
    // indistinguishable from a missing one on purpose.
    if (!notification || notification.userId !== user.id) {
      throw new NotFoundException('errors.not_found');
    }

    const updated = notification.readAt
      ? notification
      : await this.notifications.markRead(notification.id);
    return this.toEntity(updated);
  }

  async markAllRead() {
    const user = RequestContext.getUser();
    if (!user) throw new UnauthorizedException();
    await this.notifications.markAllRead(user.id);
  }

  /** Map a DB row to the GraphQL/socket shape (params → JSON string). */
  private toEntity<T extends { params: Prisma.JsonValue }>(row: T) {
    return {
      ...row,
      params: row.params == null ? null : JSON.stringify(row.params),
    };
  }
}
