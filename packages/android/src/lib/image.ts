// NOTE: expo-file-system v19 moved the `documentDirectory` / `makeDirectoryAsync`
// / `copyAsync` / `getInfoAsync` helpers into the `/legacy` submodule. The new
// class-based API would require a larger rewrite; this keeps the original
// behaviour with a single-character import change.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';

import { FormatDef, FORMATS } from './formats';

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
}: ConvertRequest): Promise<ConvertResult> {
  const saveFormat = saveFormatFor(targetFormat);
  if (!saveFormat) {
    throw new Error(`${targetFormat.label} is not supported yet on mobile.`);
  }

  const actions: ImageManipulator.Action[] = [];
  if (resize.kind === 'percentage' && resize.percent !== 100) {
    const { width, height } = await probeImageSize(sourceUri);
    actions.push({
      resize: {
        width: Math.max(1, Math.round(width * (resize.percent / 100))),
        height: Math.max(1, Math.round(height * (resize.percent / 100))),
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

  const stem = sourceName.replace(/\.[^.]+$/, '') || 'image';
  const outputName = `${stem}.${targetFormat.ext}`;

  // Copy to the app's persistent document dir with the new name so the share
  // intent presents a sensible filename to Gmail / Drive / etc.
  const finalUri = `${FileSystem.documentDirectory}exports/${Date.now()}-${outputName}`;
  await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}exports`, {
    intermediates: true,
  });
  await FileSystem.copyAsync({ from: manipulated.uri, to: finalUri });

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

export async function saveToGallery(uri: string): Promise<boolean> {
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (!perm.granted) return false;
  try {
    const asset = await MediaLibrary.createAssetAsync(uri);
    const album = await MediaLibrary.getAlbumAsync('Convert-X');
    if (album == null) {
      await MediaLibrary.createAlbumAsync('Convert-X', asset, false);
    } else {
      await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    }
    return true;
  } catch {
    return false;
  }
}

export function isSupportedImageFormat(fmt: FormatDef): boolean {
  return saveFormatFor(fmt) !== null;
}

export function supportedImageFormats(): FormatDef[] {
  return FORMATS.filter((f) => f.category === 'image' && isSupportedImageFormat(f));
}
