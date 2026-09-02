import { z } from "zod";

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const pixelSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const captureMappingSchema = z.object({
  kind: z.literal("linear"),
  imageContentBounds: rectSchema,
  screenBounds: rectSchema,
  pixelsPerPoint: z.object({
    x: z.number().finite().positive(),
    y: z.number().finite().positive(),
  }),
});

const normalizedPointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const normalizedBoxSchema = z.object({
  xMin: z.number().int(),
  yMin: z.number().int(),
  xMax: z.number().int(),
  yMax: z.number().int(),
});

export function createGroundingResultSchema(maxCoordinate: number) {
  const coordinate = z.number().int().min(0).max(maxCoordinate);
  const point = normalizedPointSchema.extend({ x: coordinate, y: coordinate });
  const box = normalizedBoxSchema
    .extend({
      xMin: coordinate,
      yMin: coordinate,
      xMax: coordinate,
      yMax: coordinate,
    })
    .refine(({ xMin, xMax }) => xMin < xMax, {
      path: ["xMax"],
      message: "xMax must be greater than xMin",
    })
    .refine(({ yMin, yMax }) => yMin < yMax, {
      path: ["yMax"],
      message: "yMax must be greater than yMin",
    });

  return z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("found"),
        point,
        box,
      })
      .refine(
        ({ point: candidate, box: bounds }) =>
          candidate.x >= bounds.xMin &&
          candidate.x <= bounds.xMax &&
          candidate.y >= bounds.yMin &&
          candidate.y <= bounds.yMax,
        { path: ["point"], message: "point must be inside box" },
      ),
    z.object({
      status: z.literal("not_found"),
      point: z.null(),
      box: z.null(),
    }),
    z.object({
      status: z.literal("ambiguous"),
      point: z.null(),
      box: z.null(),
    }),
  ]);
}

export type Point = z.infer<typeof pointSchema>;
export type Rect = z.infer<typeof rectSchema>;
export type PixelSize = z.infer<typeof pixelSizeSchema>;
export type CaptureMapping = z.infer<typeof captureMappingSchema>;
export type GroundingResult = z.infer<
  ReturnType<typeof createGroundingResultSchema>
>;

export interface GroundingAdapter<Result = GroundingResult> {
  readonly id: string;
  readonly version: number;
  readonly maxCoordinate: number;
  readonly coordinateDenominator: number;
  supportsModel(modelId: string): boolean;
  prompt(target: string, imageSize: PixelSize): string;
  readonly responseJsonSchema: Record<string, unknown>;
  parse(value: unknown): Result;
}
