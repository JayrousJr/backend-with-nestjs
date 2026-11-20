import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { RequirePermission } from '@access';
import { PaginationInput } from '@common';
import { StorageService } from './storage.service';
import { FileEntity } from './entities/file.entity';
import { FileListResponse } from './dto/file.responses';
import { FileFilterInput, FileOrderInput } from './dto/file-filter';

@Resolver(() => FileEntity)
export class StorageResolver {
  constructor(private readonly storageService: StorageService) {}

  @RequirePermission('file.view')
  @Query(() => FileListResponse, { name: 'getFiles' })
  getFiles(
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
    @Args('filter', { type: () => FileFilterInput, nullable: true })
    filter?: FileFilterInput,
    @Args('orderBy', { type: () => FileOrderInput, nullable: true })
    orderBy?: FileOrderInput,
  ) {
    return this.storageService.getFiles(filter, orderBy, pagination);
  }

  @RequirePermission('file.view')
  @Query(() => FileEntity, { name: 'getFile' })
  getFile(@Args('uniqueId', { type: () => String }) uniqueId: string) {
    return this.storageService.getFile(uniqueId);
  }

  @RequirePermission('file.delete')
  @Mutation(() => Boolean)
  async deleteFile(
    @Args('uniqueId', { type: () => String }) uniqueId: string,
  ): Promise<boolean> {
    await this.storageService.deleteFile(uniqueId);
    return true;
  }
}
