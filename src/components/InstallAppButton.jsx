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
  const [installed, setInstalled] = useState(() => (
    window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
  ));

  useEffect(() => {
    promptSubscribers.add(setInstallPrompt);
    setInstallPrompt(savedInstallPrompt);
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const updateInstalledState = () => {
      setInstalled(standaloneQuery.matches || window.navigator.standalone === true);
    };
    standaloneQuery.addEventListener('change', updateInstalledState);
    window.addEventListener('appinstalled', updateInstalledState);
    return () => {
      promptSubscribers.delete(setInstallPrompt);
      standaloneQuery.removeEventListener('change', updateInstalledState);
      window.removeEventListener('appinstalled', updateInstalledState);
    };
  }, []);

  if (installed) return null;

  async function handleInstallClick() {
    const promptEvent = installPrompt;
    if (!promptEvent) {
      const isIos = /iPad|iPhone|iPod/.test(window.navigator.userAgent);
      window.alert(
        isIos
          ? 'To install CashMap, open the Share menu and choose Add to Home Screen.'
          : 'Use your browser menu and choose Install CashMap or Install app. If that option is missing, confirm you are using the HTTPS address.',
      );
      return;
    }

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
    <a
      href="#install-cashmap"
      onClick={(event) => {
        event.preventDefault();
        handleInstallClick();
      }}
      className="install-app-link"
    >
      Install CashMap
    </a>
  );
}
