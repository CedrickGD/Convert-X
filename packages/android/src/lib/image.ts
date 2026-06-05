// NOTE: expo-file-system v19 moved the `documentDirectory` / `makeDirectoryAsync`
// / `copyAsync` / `getInfoAsync` helpers into the `/legacy` submodule. The new
// class-based API would require a larger rewrite; this keeps the original
// behaviour with a single-character import change.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';

import { FormatDef, FORMATS } from './formats';
import type { CropSpec } from '../state/types';

export type ResizeSpec =
  | { kind: 'percentage'; percent: number }
  | { kind: 'pixels'; width?: number; height?: number }
  | { kind: 'none' };

export type ConvertRequest = {
  sourceUri: string;
  sourceName: string;
  targetFormat: FormatDef;
  quality: number; // 0..100
  resize: ResizeSpec;
  /** Free-form crop in source-pixel coords, applied before resize. null/undefined = no crop. */
  crop?: CropSpec | null;
  /** Optional output filename stem (no extension). null/undefined = derive
   *  from sourceName. Used for the single-file rename field. */
  outputBaseName?: string | null;
};

export type ConvertResult = {
  outputUri: string;
  outputName: string;
  bytes: number;
};

function saveFormatFor(fmt: FormatDef): ImageManipulator.SaveFormat | null {
  switch (fmt.key) {
    case 'png':
      return ImageManipulator.SaveFormat.PNG;
    case 'jpg':
      return ImageManipulator.SaveFormat.JPEG;
    case 'webp':
      return ImageManipulator.SaveFormat.WEBP;
    default:
      return null;
  }
}

export async function convertImage({
  sourceUri,
  sourceName,
  targetFormat,
  quality,
  resize,
  crop,
  outputBaseName,
}: ConvertRequest): Promise<ConvertResult> {
  const saveFormat = saveFormatFor(targetFormat);
  if (!saveFormat) {
    throw new Error(`${targetFormat.label} is not supported yet on mobile.`);
  }

  const actions: ImageManipulator.Action[] = [];

  // Crop runs first (source-pixel coords) so any resize below applies to the
  // cropped region. `base*` becomes the effective source size for percentage
  // math; when there's no crop it stays 0 and we probe lazily only if needed.
  let baseW = 0;
  let baseH = 0;
  if (crop && crop.w > 0 && crop.h > 0) {
    const src = await probeImageSize(sourceUri);
    const originX = Math.max(0, Math.min(Math.round(crop.x), src.width - 1));
    const originY = Math.max(0, Math.min(Math.round(crop.y), src.height - 1));
    const width = Math.max(1, Math.min(Math.round(crop.w), src.width - originX));
    const height = Math.max(1, Math.min(Math.round(crop.h), src.height - originY));
    actions.push({ crop: { originX, originY, width, height } });
    baseW = width;
    baseH = height;
  }

  if (resize.kind === 'percentage' && resize.percent !== 100) {
    if (baseW === 0) {
      const probe = await probeImageSize(sourceUri);
      baseW = probe.width;
      baseH = probe.height;
    }
    actions.push({
      resize: {
        width: Math.max(1, Math.round(baseW * (resize.percent / 100))),
        height: Math.max(1, Math.round(baseH * (resize.percent / 100))),
      },
    });
  } else if (resize.kind === 'pixels' && (resize.width || resize.height)) {
    const target: { width?: number; height?: number } = {};
    if (resize.width) target.width = resize.width;
    if (resize.height) target.height = resize.height;
    actions.push({ resize: target });
  }

  const manipulated = await ImageManipulator.manipulateAsync(sourceUri, actions, {
    compress: Math.max(0, Math.min(1, quality / 100)),
    format: saveFormat,
  });

  const stem = outputBaseName?.trim() || sourceName.replace(/\.[^.]+$/, '') || 'image';
  const outputName = `${stem}.${targetFormat.ext}`;

  // Copy to the app's persistent document dir with the new name so the share
  // intent presents a sensible filename to Gmail / Drive / etc.
  const finalUri = `${FileSystem.documentDirectory}exports/${Date.now()}-${outputName}`;
  await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}exports`, {
    intermediates: true,
  });
  await FileSystem.copyAsync({ from: manipulated.uri, to: finalUri });
  // expo-image-manipulator writes its result to a cache temp; we've copied it
  // to exports/ under the final name, so drop the temp to avoid leaking it.
  await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }).catch(() => {});

  // v19 legacy `InfoOptions` dropped the `size` flag — size is always present
  // on existing files now. Left original guard for `exists`.
  const info = await FileSystem.getInfoAsync(finalUri);
  const bytes = info.exists && 'size' in info ? info.size ?? 0 : 0;

  return { outputUri: finalUri, outputName, bytes };
}

async function probeImageSize(uri: string): Promise<{ width: number; height: number }> {
  // manipulateAsync with no actions is the cheapest way to read dimensions
  const probe = await ImageManipulator.manipulateAsync(uri, [], { base64: false });
  return { width: probe.width, height: probe.height };
}

/**
 * Public source-dimension probe — used by the crop editor to map the on-screen
 * box back to source pixels. Files picked via DocumentPicker arrive without
 * width/height, so callers can't always rely on the FileEntry.
 */
export async function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return probeImageSize(uri);
}

export type SaveResult = { ok: boolean; reason?: string };

export async function saveToGallery(uri: string): Promise<SaveResult> {
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (!perm.granted) {
    return { ok: false, reason: 'Permission to save to your gallery was denied.' };
  }
  try {
    const asset = await MediaLibrary.createAssetAsync(uri);
    const album = await MediaLibrary.getAlbumAsync('Convert-X');
    if (album == null) {
      await MediaLibrary.createAlbumAsync('Convert-X', asset, false);
    } else {
      await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    }
    return { ok: true };
  } catch (e) {
    // createAssetAsync rejects on Android for non-image/video MIME types
    // (audio, ICO, TIFF, BMP) even with permission granted — surface the
    // real reason rather than a misleading "permission denied".
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Could not add this file to the gallery.',
    };
  }
}

export function isSupportedImageFormat(fmt: FormatDef): boolean {
  return saveFormatFor(fmt) !== null;
}

export function supportedImageFormats(): FormatDef[] {
  return FORMATS.filter((f) => f.category === 'image' && isSupportedImageFormat(f));
}
