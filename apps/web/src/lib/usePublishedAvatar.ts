import { useCallback, useEffect, useState } from "react";
import {
  LAST_PUBLISHED_AVATAR_EVENT,
  LAST_PUBLISHED_AVATAR_KEY,
  readLastPublishedAvatar,
  type PublishedAvatarRecord,
} from "./published-avatar";

export function usePublishedAvatar() {
  const [publishedAvatar, setPublishedAvatar] = useState<PublishedAvatarRecord | null>(() =>
    readLastPublishedAvatar(),
  );

  const refresh = useCallback(() => {
    setPublishedAvatar(readLastPublishedAvatar());
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LAST_PUBLISHED_AVATAR_KEY) {
        refresh();
      }
    };
    const onUpdated = () => refresh();

    window.addEventListener("storage", onStorage);
    window.addEventListener(LAST_PUBLISHED_AVATAR_EVENT, onUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LAST_PUBLISHED_AVATAR_EVENT, onUpdated);
    };
  }, [refresh]);

  return {
    publishedAvatar,
    refresh,
  };
}
