/** Оверлеи поверх сцены: код регистрации, имя экрана, индикатор связи. */

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

export class Overlays {
  private pairing: HTMLElement;
  private identify: HTMLElement;
  private offline: HTMLElement;
  private identifyTimer: number | undefined;

  constructor(stage: HTMLElement) {
    this.pairing = el('div', 'overlay pairing hidden', stage);
    this.identify = el('div', 'overlay identify hidden', stage);
    this.offline = el('div', 'offline-dot hidden', stage);
    this.offline.title = 'Нет связи с сервером';
  }

  showPairing(code: string): void {
    const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
    this.pairing.innerHTML = '';
    el('div', 'pairing-title', this.pairing).textContent = 'Экран не зарегистрирован';
    el('div', 'pairing-code', this.pairing).textContent = pretty;
    el('div', 'pairing-hint', this.pairing).textContent =
      'Откройте админку → «Экраны и группы» → «Добавить экран» и введите этот код';
    el('div', 'pairing-url', this.pairing).textContent = location.origin;
    this.pairing.classList.remove('hidden');
  }

  hidePairing(): void {
    this.pairing.classList.add('hidden');
  }

  showIdentify(name: string): void {
    this.identify.textContent = name;
    this.identify.classList.remove('hidden');
    window.clearTimeout(this.identifyTimer);
    this.identifyTimer = window.setTimeout(() => this.identify.classList.add('hidden'), 10_000);
  }

  setOnline(online: boolean): void {
    this.offline.classList.toggle('hidden', online);
  }
}

/** Сцена 1920×1080, вписанная в окно с letterbox. */
export function fitStage(stage: HTMLElement): void {
  const apply = () => {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    const x = (window.innerWidth - 1920 * s) / 2;
    const y = (window.innerHeight - 1080 * s) / 2;
    stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  apply();
  window.addEventListener('resize', apply);
}
