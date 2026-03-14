export type ShooterCharacterPreset = {
  id: string;
  label: string;
  prefabResource: string;
  tagline: string;
  role: string;
  previewImagePath: string;
};

export const SHOOTER_CHARACTER_PRESETS: ShooterCharacterPreset[] = [
  {
    id: "mplayer_1",
    label: "MPlayer 1",
    prefabResource: "MPlayer [1]",
    tagline: "Balanced assault loadout",
    role: "Assault",
    previewImagePath: "/mfps-previews/player-team-1-face.png",
  },
  {
    id: "mplayer_2",
    label: "MPlayer 2",
    prefabResource: "MPlayer [2]",
    tagline: "Heavy armor frontline",
    role: "Heavy",
    previewImagePath: "/mfps-previews/player-team-2-face.png",
  },
  {
    id: "botplayer_1",
    label: "BotPlayer 1",
    prefabResource: "BotPlayer [1]",
    tagline: "Fast tactical profile",
    role: "Recon",
    previewImagePath: "/mfps-previews/player-team-1-face.png",
  },
  {
    id: "botplayer_2",
    label: "BotPlayer 2",
    prefabResource: "BotPlayer [2]",
    tagline: "Defensive anchor specialist",
    role: "Support",
    previewImagePath: "/mfps-previews/player-team-2-face.png",
  },
];

export function findShooterPresetById(id: string | null | undefined) {
  if (!id) {
    return null;
  }

  return SHOOTER_CHARACTER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export async function createShooterPresetPreviewBlob(
  preset: ShooterCharacterPreset,
  size = 640,
) {
  if (typeof document === "undefined") {
    throw new Error("Canvas preview is unavailable outside a browser context.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create preview canvas context.");
  }

  const gradient = context.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, "#0f131a");
  gradient.addColorStop(0.52, "#1a2230");
  gradient.addColorStop(1, "#283447");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const previewImage = await loadPreviewImage(preset.previewImagePath);
  if (previewImage) {
    const imageHeight = Math.round(size * 0.62);
    context.drawImage(previewImage, 0, 0, size, imageHeight);

    const imageFade = context.createLinearGradient(0, imageHeight * 0.55, 0, imageHeight);
    imageFade.addColorStop(0, "rgba(8, 12, 18, 0)");
    imageFade.addColorStop(1, "rgba(8, 12, 18, 0.86)");
    context.fillStyle = imageFade;
    context.fillRect(0, 0, size, imageHeight);
  }

  context.fillStyle = "rgba(7, 11, 17, 0.72)";
  context.fillRect(0, size * 0.58, size, size * 0.42);

  context.fillStyle = "rgba(255, 220, 72, 0.94)";
  context.font = `700 ${Math.round(size * 0.07)}px "Space Grotesk", sans-serif`;
  context.fillText("MFPS 2.0", size * 0.06, size * 0.15);

  context.fillStyle = "#ffffff";
  context.font = `700 ${Math.round(size * 0.086)}px "Space Grotesk", sans-serif`;
  context.fillText(preset.label, size * 0.08, size * 0.72);

  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.font = `500 ${Math.round(size * 0.048)}px "Space Grotesk", sans-serif`;
  context.fillText(preset.role, size * 0.08, size * 0.81);

  context.fillStyle = "rgba(255, 255, 255, 0.7)";
  context.font = `500 ${Math.round(size * 0.036)}px "IBM Plex Mono", monospace`;
  context.fillText(preset.prefabResource, size * 0.08, size * 0.88);

  context.fillStyle = "rgba(255, 255, 255, 0.8)";
  context.font = `500 ${Math.round(size * 0.032)}px "IBM Plex Mono", monospace`;
  context.fillText("Minted on Sui + Walrus", size * 0.08, size * 0.95);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (!value) {
        reject(new Error("Failed to encode shooter preview PNG."));
        return;
      }

      resolve(value);
    }, "image/png");
  });

  const previewUrl = URL.createObjectURL(blob);
  return { previewBlob: blob, previewUrl };
}

async function loadPreviewImage(src: string) {
  if (!src || typeof Image === "undefined") {
    return null;
  }

  return await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
