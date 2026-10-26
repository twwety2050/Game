// DOM overlay: hotbar, block inventory, selected block name, and debug text.
import { BLOCKS } from './blocks.js';

export class Hud {
  // icons: Map(block id -> canvas with a rendered picture of the block)
  constructor(icons, items) {
    this.icons = icons;
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
    const ctx = this.slots[i].canvas.getContext('2d');
    ctx.clearRect(0, 0, 48, 48);
    const icon = this.icons.get(this.items[i]);
    if (icon) ctx.drawImage(icon, 0, 0, 48, 48);
  }

  // Fill the inventory screen with every placeable block. `onPick(id)` is called on click.
  buildInventory(onPick) {
    const grid = document.querySelector('#inventory .items');
    grid.textContent = '';
    for (const def of BLOCKS) {
      if (!def?.placeable) continue;
      const item = document.createElement('button');
      item.className = 'item';
      item.title = def.name;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 48;
      canvas.getContext('2d').drawImage(this.icons.get(def.id), 0, 0, 48, 48);
      const label = document.createElement('span');
      label.textContent = def.name;
      item.append(canvas, label);
      item.addEventListener('click', () => onPick(def.id));
      grid.appendChild(item);
    }
  }

  setDebug(text) {
    this.debugEl.textContent = text;
  }

  toggleDebug() {
    this.debugEl.classList.toggle('hidden');
  }
}
