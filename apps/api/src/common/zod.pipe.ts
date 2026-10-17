import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { Errors } from './errors';

/** Validates and transforms input with a shared @uc/contracts schema. */
@Injectable()
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw Errors.validation(
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      );
    }
    return result.data;
  }
}

export const zod = <T extends ZodTypeAny>(schema: T) => new ZodPipe(schema);
