import { ObjectType } from '@nestjs/graphql';
import { MutationResponse, QueryListResponse } from '@common';
import { PostEntity } from '../entities/post.entity';

@ObjectType()
export class PostMutationResponse extends MutationResponse(PostEntity) {}

@ObjectType()
export class PostListResponse extends QueryListResponse(PostEntity) {}
