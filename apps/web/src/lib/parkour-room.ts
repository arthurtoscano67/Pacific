export type ParkourPeerSnapshot = {
  peerId: string;
  label: string;
  avatarObjectId: string | null;
  color: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
  facingYaw: number;
  checkpointIndex: number;
  stance: string;
  speed: number;
  updatedAt: number;
};

type Message =
  | {
      type: "presence";
      roomId: string;
      snapshot: ParkourPeerSnapshot;
    }
  | {
      type: "leave";
      roomId: string;
      peerId: string;
    };

type Options = {
  roomId: string;
  label: string;
  avatarObjectId: string | null;
  color: string;
};

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

export function createParkourRoom(options: Options) {
  const peerId = `${options.avatarObjectId ?? "guest"}-${randomId()}`;
  const channel =
    typeof window !== "undefined" && "BroadcastChannel" in window
      ? new BroadcastChannel(`pacific-parkour:${options.roomId}`)
      : null;
  const listeners = new Set<(message: Message) => void>();

  if (channel) {
    channel.onmessage = (event: MessageEvent<Message>) => {
      if (!event.data) {
        return;
      }

      listeners.forEach((listener) => listener(event.data));
    };
  }

  return {
    peerId,
    publish(snapshot: Omit<ParkourPeerSnapshot, "peerId" | "label" | "avatarObjectId" | "color" | "updatedAt">) {
      if (!channel) {
        return;
      }

      channel.postMessage({
        type: "presence",
        roomId: options.roomId,
        snapshot: {
          ...snapshot,
          peerId,
          label: options.label,
          avatarObjectId: options.avatarObjectId,
          color: options.color,
          updatedAt: Date.now(),
        },
      } satisfies Message);
    },
    subscribe(listener: (message: Message) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (channel) {
        channel.postMessage({
          type: "leave",
          roomId: options.roomId,
          peerId,
        } satisfies Message);
        channel.close();
      }
      listeners.clear();
    },
  };
}
