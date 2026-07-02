import { useEffect, useState } from 'react';

let savedInstallPrompt = null;
const promptSubscribers = new Set();

function publishInstallPrompt(prompt) {
  savedInstallPrompt = prompt;
  promptSubscribers.forEach((subscriber) => subscriber(prompt));
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    publishInstallPrompt(event);
  });

  window.addEventListener('appinstalled', () => {
    publishInstallPrompt(null);
  });
}

export default function InstallAppButton() {
  const [installPrompt, setInstallPrompt] = useState(savedInstallPrompt);

  useEffect(() => {
    promptSubscribers.add(setInstallPrompt);
    setInstallPrompt(savedInstallPrompt);
    return () => promptSubscribers.delete(setInstallPrompt);
  }, []);

  if (!installPrompt) return null;

  async function handleInstallClick() {
    const promptEvent = installPrompt;
    publishInstallPrompt(null);

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      console.info('CashMap install prompt result:', choice.outcome);
    } catch (error) {
      console.error('CashMap install prompt failed:', error);
    }
  }

  return (
    <button
      type="button"
      onClick={handleInstallClick}
      className="soft-button install-app-button"
    >
      Install CashMap
    </button>
  );
}
