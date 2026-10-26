// DOM overlay: hotbar with isometric block icons, selected block name, and debug text.
import { BLOCKS } from './blocks.js';
import { ATLAS, TILE } from './textures.js';

export class Hud {
  constructor(atlas, items) {
    this.atlas = atlas;
    this.items = items.slice();
    this.selected = 0;
    this.slots = [];
    this.bar = document.getElementById('hotbar');
    this.label = document.getElementById('block-name');
    this.debugEl = document.getElementById('debug');
    this.labelTimer = 0;

    this.items.forEach((_, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 48;
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = i + 1;
      el.append(canvas, key);
      this.bar.appendChild(el);
      this.slots.push({ el, canvas });
      this.drawIcon(i);
    });
    this.select(0);
  }

  get current() { return this.items[this.selected]; }

  select(i) {
    this.selected = (i + this.items.length) % this.items.length;
    this.slots.forEach((s, n) => s.el.classList.toggle('active', n === this.selected));
    this.toast(BLOCKS[this.current].name);
  }

  toast(text) {
    this.label.textContent = text;
    this.label.classList.add('show');
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(() => this.label.classList.remove('show'), 1500);
  }

  scroll(dir) { this.select(this.selected + dir); }

  setItem(id) {
    const existing = this.items.indexOf(id);
    if (existing >= 0) return this.select(existing);
    this.items[this.selected] = id;
    this.drawIcon(this.selected);
    this.select(this.selected);
  }

  drawIcon(i) {
    const def = BLOCKS[this.items[i]];
    const ctx = this.slots[i].canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 48, 48);
    ctx.imageSmoothingEnabled = false;
    const s = 1 / TILE;
    const face = (tile, m, shade) => {
      ctx.save();
      ctx.setTransform(...m);
      ctx.drawImage(this.atlas, (tile % ATLAS) * TILE, Math.floor(tile / ATLAS) * TILE, TILE, TILE, 0, 0, TILE, TILE);
      if (shade) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fillRect(0, 0, TILE, TILE);
      }
      ctx.restore();
    };
    face(def.side, [20 * s, 10 * s, 0, 22 * s, 4, 14], 0.25);   // left
    face(def.side, [20 * s, -10 * s, 0, 22 * s, 24, 24], 0.45); // right
    face(def.top, [20 * s, -10 * s, 20 * s, 10 * s, 4, 14], 0);  // top
  }

  setDebug(text) {
    this.debugEl.textContent = text;
  }

  toggleDebug() {
    this.debugEl.classList.toggle('hidden');
  }
}
