import { z } from "zod";
import {
  READY_AVATAR_DEFAULT_MAX_RUNTIME_AVATAR_BYTES,
  REQUIRED_VRM_BONES,
} from "./constants.js";

const glbHeaderLength = 12;
const glbChunkHeaderLength = 8;
const glbMagic = 0x46546c67;
const jsonChunkType = 0x4e4f534a;

export const vrmValidationSummarySchema = z.object({
  fileName: z.string(),
  fileSize: z.number().int().positive(),
  specVersion: z.string(),
  extension: z.literal(".vrm"),
  format: z.literal("vrm-1.0"),
  playable: z.boolean(),
  humanoidBones: z.array(z.string()),
  previewScaleSafe: z.boolean(),
  errors: z.array(z.string()),
});

export type VrmValidationSummary = z.infer<typeof vrmValidationSummarySchema>;

type ParsedGlb = {
  json: Record<string, unknown>;
  bytes: Uint8Array;
};

function readJsonChunk(bytes: Uint8Array): ParsedGlb {
  if (bytes.byteLength < glbHeaderLength + glbChunkHeaderLength) {
    throw new Error("File is too small to be a GLB container.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== glbMagic) {
    throw new Error("File signature is not glTF/GLB.");
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new Error("VRM uploads must be glTF 2.0 based.");
  }

  const jsonLength = view.getUint32(glbHeaderLength, true);
  const chunkType = view.getUint32(glbHeaderLength + 4, true);
  if (chunkType !== jsonChunkType) {
    throw new Error("GLB JSON chunk is missing.");
  }

  const start = glbHeaderLength + glbChunkHeaderLength;
  const end = start + jsonLength;
  const rawJson = new TextDecoder().decode(bytes.slice(start, end));
  return {
    bytes,
    json: JSON.parse(rawJson) as Record<string, unknown>,
  };
}

function getJsonRecord<T extends Record<string, unknown>>(
  value: unknown,
  label: string,
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing.`);
  }

  return value as T;
}

function getNodeScale(node: unknown): number[] | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }

  const scale = (node as { scale?: unknown }).scale;
  if (!Array.isArray(scale)) {
    return null;
  }

  return scale.map((value) => Number(value));
}

export function validatePlayableAvatarUpload(
  fileName: string,
  bytes: Uint8Array,
  maxBytes = READY_AVATAR_DEFAULT_MAX_RUNTIME_AVATAR_BYTES,
): VrmValidationSummary {
  const errors: string[] = [];

  if (!fileName.toLowerCase().endsWith(".vrm")) {
    errors.push("Active avatars must use the .vrm extension.");
  }

  if (bytes.byteLength > maxBytes) {
    errors.push(
      `Runtime avatar exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`,
    );
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = readJsonChunk(bytes).json;
  } catch (error) {
    errors.push((error as Error).message);
  }

  let humanoidBones: string[] = [];
  let specVersion = "unknown";
  let previewScaleSafe = false;

  if (json) {
    try {
      const asset = getJsonRecord<Record<string, unknown>>(json.asset, "glTF asset");
      if (String(asset.version ?? "") !== "2.0") {
        errors.push("VRM uploads must declare glTF asset version 2.0.");
      }

      const extensionsUsed = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
      if (!extensionsUsed.includes("VRMC_vrm")) {
        errors.push("VRM humanoid extension usage is missing from glTF extensionsUsed.");
      }

      const extensions = getJsonRecord<Record<string, unknown>>(
        json.extensions,
        "glTF extensions",
      );
      const vrm = getJsonRecord<Record<string, unknown>>(
        extensions.VRMC_vrm,
        "VRM 1.0 extension",
      );

      specVersion = String(vrm.specVersion ?? "unknown");
      if (!specVersion.startsWith("1.")) {
        errors.push("Only VRM 1.x avatars can become active playable characters.");
      }

      const humanoid = getJsonRecord<Record<string, unknown>>(
        vrm.humanoid,
        "VRM humanoid",
      );
      const humanBonesRecord = getJsonRecord<Record<string, unknown>>(
        humanoid.humanBones,
        "VRM humanoid bone map",
      );

      humanoidBones = Object.keys(humanBonesRecord);
      if (humanoidBones.length === 0) {
        errors.push("VRM humanoid bone map is empty.");
      }

      const nodes = Array.isArray(json.nodes) ? json.nodes : [];
      const assignedNodes = new Map<number, string>();
      let allPositive = true;

      for (const [boneName, definition] of Object.entries(humanBonesRecord)) {
        if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
          errors.push(`Humanoid bone '${boneName}' is not defined as an object.`);
          continue;
        }

        const node = Number((definition as { node?: unknown }).node);
        if (!Number.isInteger(node) || node < 0) {
          errors.push(`Humanoid bone '${boneName}' does not point to a valid node.`);
          continue;
        }

        const existingBone = assignedNodes.get(node);
        if (existingBone) {
          errors.push(
            `Humanoid bone '${boneName}' reuses node ${node}, already assigned to '${existingBone}'.`,
          );
        } else {
          assignedNodes.set(node, boneName);
        }

        const scale = getNodeScale(nodes[node]);
        if (scale && scale.some((value) => !Number.isFinite(value) || value <= 0)) {
          allPositive = false;
          errors.push(`Humanoid bone '${boneName}' has a non-positive scale transform.`);
        }
      }

      for (const boneName of REQUIRED_VRM_BONES) {
        if (!humanBonesRecord[boneName]) {
          errors.push(`Required humanoid bone '${boneName}' is missing.`);
        }
      }

      previewScaleSafe = allPositive;
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  return {
    fileName,
    fileSize: bytes.byteLength,
    specVersion,
    extension: ".vrm",
    format: "vrm-1.0",
    playable: errors.length === 0,
    humanoidBones,
    previewScaleSafe,
    errors,
  };
}

export function isGenericGlbAsset(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".glb");
}
