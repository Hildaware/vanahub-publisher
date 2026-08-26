interface Window {
  turnstile?: {
    render(
      element: HTMLElement,
      options: {
        sitekey: string;
        callback: (token: string) => void;
        'expired-callback': () => void;
        'error-callback': () => void;
        theme: 'dark';
      },
    ): string;
    reset(widgetId: string): void;
    remove(widgetId: string): void;
  };
}
