export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_BULK_FILES = 10;

/**
 * Upload allowlist. The stored extension is derived from the *validated* MIME
 * type, never from the client-supplied filename, so a file named
 * `avatar.png.html` cannot land on disk as HTML.
 *
 * `image/svg+xml` is deliberately absent: SVGs can carry <script> and become
 * stored XSS when served back from the API origin. Add types here only once
 * you have decided how they should be served (see INLINE_MIME_TYPES).
 */
export const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
};

/** Everything else is sent as an attachment instead of rendering in-page. */
export const INLINE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(ALLOWED_MIME_TYPES).map(([mime, ext]) => [ext, mime]),
);
