import type {
  CaptureMapping,
  GroundingResult,
  PixelSize,
  Point,
  Rect,
} from "./types.js";

export interface ImageGrounding {
  point: Point;
  box: Rect;
  endpointSensitivityPoint: Point;
}

export interface FoundScore {
  pointInTarget: boolean;
  centerErrorPixels: number;
  centerErrorScreenPoints: number;
  boxIou: number;
  predictedImage: ImageGrounding;
  predictedScreenPoint: Point;
  predictedScreenBox: Rect;
  expectedImageBox: Rect;
}

export function normalizedToPixel(
  point: Point,
  imageSize: PixelSize,
  denominator: number,
): Point {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("Coordinate denominator must be positive and finite");
  }
  return {
    x: (point.x / denominator) * imageSize.width,
    y: (point.y / denominator) * imageSize.height,
  };
}

export function imageToScreen(point: Point, mapping: CaptureMapping): Point {
  return {
    x:
      mapping.screenBounds.x +
      (point.x - mapping.imageContentBounds.x) / mapping.pixelsPerPoint.x,
    y:
      mapping.screenBounds.y +
      (point.y - mapping.imageContentBounds.y) / mapping.pixelsPerPoint.y,
  };
}

export function screenToImage(point: Point, mapping: CaptureMapping): Point {
  return {
    x:
      mapping.imageContentBounds.x +
      (point.x - mapping.screenBounds.x) * mapping.pixelsPerPoint.x,
    y:
      mapping.imageContentBounds.y +
      (point.y - mapping.screenBounds.y) * mapping.pixelsPerPoint.y,
  };
}

export function mapRect(rect: Rect, transform: (point: Point) => Point): Rect {
  const topLeft = transform({ x: rect.x, y: rect.y });
  const bottomRight = transform({
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  });
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };
}

export function decodeFoundResult(
  result: Extract<GroundingResult, { status: "found" }>,
  imageSize: PixelSize,
  denominator: number,
  sensitivityDenominator = 999,
): ImageGrounding {
  const point = normalizedToPixel(result.point, imageSize, denominator);
  const topLeft = normalizedToPixel(
    { x: result.box.xMin, y: result.box.yMin },
    imageSize,
    denominator,
  );
  const bottomRight = normalizedToPixel(
    { x: result.box.xMax, y: result.box.yMax },
    imageSize,
    denominator,
  );
  return {
    point,
    box: {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    },
    endpointSensitivityPoint: normalizedToPixel(
      result.point,
      imageSize,
      sensitivityDenominator,
    ),
  };
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

export function rectCenter(rect: Rect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function intersectionOverUnion(left: Rect, right: Rect): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea =
    left.width * left.height + right.width * right.height - intersectionArea;
  return unionArea === 0 ? 0 : intersectionArea / unionArea;
}

export function scoreFoundResult(
  result: Extract<GroundingResult, { status: "found" }>,
  expectedScreenBox: Rect,
  imageSize: PixelSize,
  mapping: CaptureMapping,
  denominator: number,
): FoundScore {
  const predictedImage = decodeFoundResult(result, imageSize, denominator);
  const predictedScreenPoint = imageToScreen(predictedImage.point, mapping);
  const predictedScreenBox = mapRect(predictedImage.box, (point) =>
    imageToScreen(point, mapping),
  );
  const expectedImageBox = mapRect(expectedScreenBox, (point) =>
    screenToImage(point, mapping),
  );

  return {
    pointInTarget: containsPoint(expectedScreenBox, predictedScreenPoint),
    centerErrorPixels: distance(
      predictedImage.point,
      rectCenter(expectedImageBox),
    ),
    centerErrorScreenPoints: distance(
      predictedScreenPoint,
      rectCenter(expectedScreenBox),
    ),
    boxIou: intersectionOverUnion(predictedImage.box, expectedImageBox),
    predictedImage,
    predictedScreenPoint,
    predictedScreenBox,
    expectedImageBox,
  };
}
