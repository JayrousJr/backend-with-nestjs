/// <reference types="multer" />
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { createReadStream, existsSync } from 'fs';
import { basename, extname, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { PaginationInput, offsetPaginate } from '@common';
import { StorageRepository } from './storage.repository';
import type { StorageDriver } from './drivers/storage-driver.interface';
import {
  ALLOWED_MIME_TYPES,
  INLINE_MIME_TYPES,
  MIME_BY_EXTENSION,
  STORAGE_DRIVER,
} from './storage.constants';
import {
  FileFilterInput,
  FileOrderInput,
  buildFileWhere,
  buildFileOrderBy,
} from './dto/file-filter';

@Injectable()
export class StorageService {
  constructor(
    private readonly files: StorageRepository,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
  ) {}

  async upload(file: Express.Multer.File, folder: string, uploaderId?: number) {
    if (!file) throw new BadRequestException('errors.file_required');

    // Extension comes from the validated MIME type, never from the uploaded
    // filename — otherwise "logo.png.html" would be stored (and served) as HTML.
    const ext = ALLOWED_MIME_TYPES[file.mimetype];
    if (!ext) throw new BadRequestException('errors.unsupported_file_type');

    // Folder is caller-supplied; keep it to a flat, safe segment so it cannot
    // climb out of the uploads root.
    const safeFolder = folder
      .replace(/[^a-zA-Z0-9/_-]/g, '')
      .replace(/\.+/g, '');
    const key = `${safeFolder || 'general'}/${randomUUID()}${ext}`;
    const uri = await this.driver.put(file.buffer, key, file.mimetype);

    return this.files.create({
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      uri,
      createdById: uploaderId,
    });
  }

  async uploadMany(
    fileList: Express.Multer.File[],
    folder: string,
    uploaderId?: number,
  ) {
    return Promise.all(fileList.map((f) => this.upload(f, folder, uploaderId)));
  }

  async getFile(uniqueId: string) {
    const file = await this.files.findByUniqueId(uniqueId);
    if (!file) throw new NotFoundException('errors.record_not_found');
    return file;
  }

  getFiles(
    filter?: FileFilterInput,
    orderBy?: FileOrderInput,
    pagination?: PaginationInput,
  ) {
    const where = buildFileWhere(filter);
    const order = buildFileOrderBy(orderBy);

    return offsetPaginate(
      (args) => this.files.findMany({ ...args, where, orderBy: order }),
      () => this.files.count(where),
      pagination,
    );
  }

  async deleteFile(uniqueId: string) {
    const file = await this.getFile(uniqueId);
    await this.driver.delete(file.uri);
    await this.files.softDelete(uniqueId);
  }

  /**
   * Hard-purge soft-deleted file rows past the retention cutoff. Files can't
   * be purged with a bulk SQL delete like other models: each row's blob must
   * be removed through the storage driver, and one failing row (e.g. a stale
   * FK reference) shouldn't abort the rest of the batch.
   */
  async purgeSoftDeletedBefore(cutoff: Date): Promise<number> {
    const files = await this.files.findSoftDeletedBefore(cutoff);
    let purged = 0;
    for (const file of files) {
      try {
        // Best-effort: deleteFile() already removed the blob at soft-delete
        // time, and both drivers tolerate deleting a missing object.
        await this.driver.delete(file.uri);
        await this.files.hardDeleteById(file.id);
        purged++;
      } catch {
        // Leave the row for the next run rather than failing the whole purge.
      }
    }
    return purged;
  }

  getFileStream(uri: string): StreamableFile {
    const uploadsRoot = resolve(process.cwd(), 'uploads');
    const filePath = resolve(uploadsRoot, uri);

    // `uri` is user-controlled: without this check "../../.env" would resolve
    // outside the uploads root and stream arbitrary server files.
    if (!filePath.startsWith(uploadsRoot + sep)) {
      throw new BadRequestException('errors.invalid_path');
    }
    if (!existsSync(filePath)) {
      throw new NotFoundException('errors.record_not_found');
    }

    // Serve with the type implied by our own stored extension (helmet already
    // sends X-Content-Type-Options: nosniff), and force a download for
    // anything that isn't a known-safe inline type.
    const type =
      MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ??
      'application/octet-stream';

    return new StreamableFile(createReadStream(filePath), {
      type,
      disposition: INLINE_MIME_TYPES.has(type)
        ? 'inline'
        : `attachment; filename="${basename(filePath)}"`,
    });
  }
}
