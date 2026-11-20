export interface JwtPayload {
  /** User uniqueId. */
  sub: string;
  email: string;
  /** Session uniqueId. */
  sid: string;
}
