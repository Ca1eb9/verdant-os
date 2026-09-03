"use client";

import { useEffect, useState } from "react";

function detectStandalone() {
  if (typeof window === "undefined") {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & {
    standalone?: boolean;
  };

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean(navigatorWithStandalone.standalone)
  );
}

export function InstallAppButton({ className }: { className?: string }) {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setInstalled(detectStandalone());

    const handleBeforeInstallPrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setPromptEvent(event);
    };

    const handleInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  if (installed) {
    return <span className={className}>Installed</span>;
  }

  if (!promptEvent) {
    return null;
  }

  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;

        if (choice.outcome === "accepted") {
          setPromptEvent(null);
        }
      }}
    >
      Install App
    </button>
  );
}
