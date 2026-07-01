// #306 — vanilla-DOM addEventListener fixture. Mirrors the
// `test-code-comprehension/static-site/site-client-src/` shape:
// a Web-Component-style class registering DOM event listeners on
// child elements with bound class methods.

declare const document: {
  getElementById(id: string): HTMLElement;
};

interface HTMLElement {
  addEventListener(event: string, handler: (e?: Event) => void): void;
}

interface Event {
  preventDefault(): void;
}

export class UserCardComponent {
  private button: HTMLElement;
  private overlay: HTMLElement;
  private arrowHandler = (e?: Event) => {
    e?.preventDefault();
  };

  constructor() {
    this.button = document.getElementById('btn');
    this.overlay = document.getElementById('overlay');

    // 1. Bound method — `.bind(this)` is the most common shape.
    this.button.addEventListener('click', this.onClick.bind(this));

    // 2. Plain identifier handler (no class method).
    this.overlay.addEventListener('click', handleOverlayClick);

    // 3. Inline arrow — has no separate FunctionDefinition target.
    this.button.addEventListener('mouseenter', (e?: Event) => {
      e?.preventDefault();
    });

    // 4. Direct method reference (no .bind).
    this.button.addEventListener('focus', this.onFocus);

    // 5. Arrow-bound class field. The field initializer IS the handler.
    this.button.addEventListener('blur', this.arrowHandler);
  }

  onClick(e?: Event): void {
    e?.preventDefault();
  }

  onFocus(): void {
    /* noop */
  }
}

function handleOverlayClick(e?: Event): void {
  e?.preventDefault();
}
