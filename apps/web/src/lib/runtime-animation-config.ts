import type { ReadyAvatarManifest } from "@pacific/shared";

export const RUNTIME_ANIMATION_STATES = ["idle", "walk", "run", "jump"] as const;

export type RuntimeAnimationStateName = (typeof RUNTIME_ANIMATION_STATES)[number];

export type RuntimeAnimationClipConfigEntry = {
  name: string;
  url: string | null;
};

export type RuntimeAnimationConfig = Record<
  RuntimeAnimationStateName,
  RuntimeAnimationClipConfigEntry
>;

export const DEFAULT_RUNTIME_ANIMATION_CONFIG: RuntimeAnimationConfig = {
  idle: {
    name: "idle",
    url: null,
  },
  walk: {
    name: "walk",
    url: null,
  },
  run: {
    name: "run",
    url: null,
  },
  jump: {
    name: "jump",
    url: null,
  },
};

export function clipSearchPattern(state: RuntimeAnimationStateName) {
  switch (state) {
    case "idle":
      return /idle|stand|rest/i;
    case "walk":
      return /walk|locomotion|move/i;
    case "run":
      return /run|jog|sprint/i;
    case "jump":
      return /jump|air|fall|land/i;
    default:
      return /.^/;
  }
}

export function resolveRuntimeAnimationReference(
  manifest: ReadyAvatarManifest | null | undefined,
  state: RuntimeAnimationStateName,
) {
  const manifestEntry = manifest?.animations?.[state];
  if (manifestEntry?.url) {
    return manifestEntry.url;
  }

  if (manifestEntry?.blobId) {
    return `walrus://${manifestEntry.blobId}`;
  }

  return DEFAULT_RUNTIME_ANIMATION_CONFIG[state].url;
}
