const store = globalThis.__codexPebbleButtonMock || { instances: [] };
globalThis.__codexPebbleButtonMock = store;

export const buttonInstances = store.instances;

export function resetButtons() {
  store.instances.length = 0;
}

export default class Button {
  constructor(options) {
    this.options = options;
    store.instances.push(this);
  }

  push(type, down = false) {
    this.options.onPush(down, type);
  }
}
