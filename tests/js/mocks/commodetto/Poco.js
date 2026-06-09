const store = globalThis.__codexPebblePocoMock || { instances: [] };
globalThis.__codexPebblePocoMock = store;

export const pocoInstances = store.instances;

export function resetPoco() {
  store.instances.length = 0;
}

export default class Poco {
  constructor() {
    this.width = 144;
    this.height = 168;
    this.frames = [];
    this.texts = [];
    this.Font = Font;
    store.instances.push(this);
  }

  begin() {
    this.texts = [];
  }

  end() {
    this.frames.push(this.texts.slice());
  }

  fillRectangle() {
  }

  drawText(text, font, color, x, y) {
    this.texts.push({ text: String(text), font, color, x, y });
  }

  makeColor(red, green, blue) {
    return `rgb(${red},${green},${blue})`;
  }

  getTextWidth(text) {
    return String(text || "").length * 6;
  }
}

class Font {
  constructor(name, size) {
    this.name = name;
    this.size = size;
  }
}
