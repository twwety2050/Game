// The navigation console screen: lists the ship's thrusters and lets you drag copies of them
// onto the Q, W, E, A, S, and D boxes. At the helm, holding a key fires every thruster in its box.
import { applyRotation } from './shapes.js';
import { CONTROL_KEYS } from './ship.js';

const DIRECTIONS = [
  ['Forward', '↑'], ['Back', '↓'], ['Right', '→'], ['Left', '←'], ['Up', '⤒'], ['Down', '⤓'],
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class NavConsoleUI {
  // icons: Map(block id -> canvas); callbacks: { onPilot(), onClose(), onHover(thrusterKey | null) }
  constructor(icons, thrusterId, callbacks) {
    this.icon = icons.get(thrusterId);
    this.callbacks = callbacks;
    this.root = document.getElementById('console');
    this.available = this.root.querySelector('.available .tiles');
    this.boxes = Object.fromEntries(CONTROL_KEYS.map((k) => [k, this.root.querySelector(`.keybox[data-key="${k}"]`)]));
    this.root.querySelector('#console-pilot').addEventListener('click', () => this.callbacks.onPilot());
    this.root.querySelector('#console-close').addEventListener('click', () => this.callbacks.onClose());

    for (const [key, box] of Object.entries(this.boxes)) {
      box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
      box.addEventListener('dragleave', () => box.classList.remove('over'));
      box.addEventListener('drop', (e) => {
        e.preventDefault();
        box.classList.remove('over');
        const { thruster, from } = JSON.parse(e.dataTransfer.getData('application/json'));
        if (from && from !== key) this.unbind(from, thruster);
        this.bind(key, thruster);
      });
    }
    // Dropping a copy back on the thruster list removes it from its key.
    const list = this.root.querySelector('.available');
    list.addEventListener('dragover', (e) => e.preventDefault());
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const { thruster, from } = JSON.parse(e.dataTransfer.getData('application/json'));
      if (from) this.unbind(from, thruster);
    });
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  // Open the screen for the console at local `consoleKey` (orientation `meta`) on `ship`.
  open(ship, consoleKey, meta) {
    this.ship = ship;
    this.bindings = ship.consoleBindings(consoleKey);
    // The pilot stands facing the screen: forward is away from the screen's face.
    const front = applyRotation(meta, [0, 0, 1]);
    const up = applyRotation(meta, [0, 1, 0]);
    this.axes = { forward: front.map((v) => -v), up };
    this.axes.right = cross(this.axes.forward, up);
    this.render();
    this.root.classList.remove('hidden');
  }

  close() {
    this.root.classList.add('hidden');
    this.callbacks.onHover(null);
  }

  // Thrusters sorted into a stable order and numbered.
  thrusterList() {
    return [...this.ship.thrusters.entries()]
      .sort(([, a], [, b]) => a.y - b.y || a.z - b.z || a.x - b.x)
      .map(([key, t], i) => ({ key, number: i + 1, ...t }));
  }

  // Which way a thruster pushes the ship, from the pilot's point of view.
  describe(t) {
    const push = t.nozzle.map((v) => -v);
    const { forward, right, up } = this.axes;
    const scores = [dot(push, forward), -dot(push, forward), dot(push, right), -dot(push, right), dot(push, up), -dot(push, up)];
    return DIRECTIONS[scores.indexOf(Math.max(...scores))];
  }

  // Where a thruster sits on the ship, from the pilot's point of view (ignoring the axis it
  // pushes along), e.g. "left side". Empty if it's near the centre.
  locate(t) {
    const com = this.ship.com;
    const offset = [t.x + 0.5 - com.x, t.y + 0.5 - com.y, t.z + 0.5 - com.z];
    const { forward, right, up } = this.axes;
    const along = [[dot(offset, right), 'right side', 'left side'], [dot(offset, forward), 'front', 'rear'], [dot(offset, up), 'top', 'bottom']]
      .filter(([, pos]) => Math.abs(dot(t.nozzle, pos === 'right side' ? right : pos === 'front' ? forward : up)) < 0.5);
    along.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
    const [d, pos, neg] = along[0];
    return Math.abs(d) < 1 ? '' : d > 0 ? pos : neg;
  }

  bind(key, thruster) {
    if (!this.bindings[key].includes(thruster)) this.bindings[key].push(thruster);
    this.render();
  }

  unbind(key, thruster) {
    this.bindings[key] = this.bindings[key].filter((k) => k !== thruster);
    this.render();
  }

  makeTile(t, from) {
    const [name, arrow] = this.describe(t);
    const where = this.locate(t);
    const el = document.createElement('div');
    el.className = from ? 'chip' : 'tile';
    el.draggable = true;
    const info = `Thruster ${t.number}: pushes ${name.toLowerCase()}${where ? `, mounted on the ${where}` : ''}`;
    el.title = from ? `${info} (click to remove)` : info;
    const icon = document.createElement('canvas');
    icon.width = icon.height = 32;
    icon.getContext('2d').drawImage(this.icon, 0, 0, 32, 32);
    const label = document.createElement('span');
    label.innerHTML = `<b>T${t.number}</b> ${arrow} ${name}${where ? ` <i>· ${where}</i>` : ''}`;
    el.append(icon, label);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ thruster: t.key, from }));
      e.dataTransfer.effectAllowed = from ? 'move' : 'copy';
    });
    el.addEventListener('mouseenter', () => this.callbacks.onHover(t.key));
    el.addEventListener('mouseleave', () => this.callbacks.onHover(null));
    if (from) el.addEventListener('click', () => this.unbind(from, t.key));
    return el;
  }

  render() {
    const list = this.thrusterList();
    const byKey = new Map(list.map((t) => [t.key, t]));
    this.available.textContent = '';
    if (list.length === 0) {
      this.available.innerHTML = '<p class="empty">No thrusters on this ship yet. Place some!</p>';
    }
    for (const t of list) this.available.appendChild(this.makeTile(t, null));
    for (const [key, box] of Object.entries(this.boxes)) {
      const chips = box.querySelector('.chips');
      chips.textContent = '';
      for (const thruster of this.bindings[key]) {
        const t = byKey.get(thruster);
        if (t) chips.appendChild(this.makeTile(t, key)); // skip thrusters that were removed
      }
    }
  }
}
